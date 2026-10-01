/* TIPON WebHID capture. Signature images stay in memory until Save Signature. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('preview');
  const ctx = canvas.getContext('2d');
  const ink = document.createElement('canvas');
  const inkCtx = ink.getContext('2d');
  const params = new URLSearchParams(location.hash.slice(1));
  const requestId = params.get('session') || '';
  const parentOrigin = params.get('parentOrigin') || '';
  const googleOrigin = /^https:\/\/(?:script\.google\.com|script\.googleusercontent\.com|[a-z0-9-]+[.-]script\.googleusercontent\.com)$/;
  const validSession = /^[a-f0-9]{32}$/.test(requestId) && googleOrigin.test(parentOrigin) && !!window.opener;
  let parentReady = false, connecting = false, connected = false, saving = false, finished = false;
  let tablet, imageData, capability, threshold;
  let cleaning = false, cleanupPromise, editingPad = false, hasInk = false, down = false, point = null, buttonDown = -1;
  let bounds, buttons, inkBounds, saveTimer;
  function status(text, kind = '') { $('status').textContent = text; $('status').className = kind; }
  function controls() {
    $('connect').disabled = !parentReady || !TiponStu540.supported() || connecting || connected || cleaning || saving || finished;
    $('clear').disabled = !connected || saving || editingPad || finished;
    $('save').disabled = !connected || !hasInk || saving || editingPad || finished;
    $('cancel').disabled = saving || connecting || editingPad || cleaning;
  }
  function send(type, extra = {}) {
    if (!validSession || !window.opener || window.opener.closed) throw new Error('The TIPON signature dialog was closed. Reopen Capture Signature in the form.');
    window.opener.postMessage({type, requestId, ...extra}, parentOrigin);
  }
  function inside(p, r) { return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h; }
  function frame() {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#173b57'; ctx.font = 'bold 25px Arial'; ctx.fillText('Please sign inside the box', 24, 35);
    ctx.strokeStyle = '#97aebd'; ctx.lineWidth = 1; ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.drawImage(ink, 0, 0);
    for (const button of buttons) {
      ctx.fillStyle = '#e5ebee'; ctx.fillRect(button.x, button.y, button.w, button.h);
      ctx.strokeStyle = '#8a9aa5'; ctx.strokeRect(button.x, button.y, button.w, button.h);
      ctx.fillStyle = '#173b57'; ctx.font = 'bold 25px Arial'; ctx.textAlign = 'center';
      ctx.fillText(button.text, button.x + button.w / 2, button.y + button.h / 2 + 9);
    }
    ctx.textAlign = 'left';
  }
  function prepareCanvas() {
    canvas.width = ink.width = capability.screenWidth;
    canvas.height = ink.height = capability.screenHeight;
    const y = canvas.height - 66;
    bounds = {x:24, y:55, w:canvas.width - 48, h:y - 70};
    buttons = ['Save', 'Clear', 'Cancel'].map((text, i) => ({x:i * canvas.width / 3, y, w:canvas.width / 3, h:66, text}));
    hasInk = false; down = false; point = null; buttonDown = -1; inkBounds = null;
    frame();
  }
  function addPoint(p, previous) {
    inkCtx.strokeStyle = '#000'; inkCtx.fillStyle = '#000'; inkCtx.lineWidth = 2.8; inkCtx.lineCap = 'round'; inkCtx.lineJoin = 'round';
    inkCtx.beginPath();
    if (previous) {inkCtx.moveTo(previous.x, previous.y); inkCtx.lineTo(p.x, p.y); inkCtx.stroke();}
    else {inkCtx.arc(p.x, p.y, 1.4, 0, Math.PI * 2); inkCtx.fill();}
    if (!inkBounds) inkBounds = {left:p.x, top:p.y, right:p.x, bottom:p.y};
    inkBounds.left = Math.min(inkBounds.left, p.x); inkBounds.top = Math.min(inkBounds.top, p.y);
    inkBounds.right = Math.max(inkBounds.right, p.x); inkBounds.bottom = Math.max(inkBounds.bottom, p.y);
    hasInk = true;
    ctx.drawImage(ink, 0, 0);
    controls();
  }
  function onPen(report) {
    if (!connected || saving || editingPad || finished || !report) return;
    if (![report.x, report.y, report.pressure].every(Number.isFinite)) return;
    const p = {x:canvas.width * report.x / capability.tabletMaxX, y:canvas.height * report.y / capability.tabletMaxY};
    const nextDown = down ? report.pressure > threshold.offPressureMark : report.pressure > threshold.onPressureMark;
    const button = buttons.findIndex(r => inside(p, r));
    if (!down && nextDown) {buttonDown = button; point = null;}
    if (nextDown && buttonDown === -1 && inside(p, bounds)) {addPoint(p, point); point = p;}
    else point = null;
    const action = down && !nextDown && button === buttonDown ? button : -1;
    down = nextDown;
    if (!nextDown) buttonDown = -1;
    if (action === 0) void save();
    if (action === 1) void clear();
    if (action === 2) void cancel();
  }
  function cleanup() {
    if (cleaning) return cleanupPromise;
    cleaning = true; connected = false;
    const previous = tablet; tablet = null; controls();
    cleanupPromise = Promise.resolve(previous ? previous.disconnect() : undefined).finally(() => {
      cleaning = false; $('connection').textContent = 'Disconnected'; controls();
    });
    return cleanupPromise;
  }
  function connectionError(error) {
    if (error.name === 'NotFoundError') return 'No pad selected. Choose Connect signature pad and select the STU-540.';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'USB access was not allowed. Use desktop Chrome or Edge and allow this page to connect to the STU-540. If your organisation blocks device access, contact IT.';
    if (error.name === 'NetworkError' || error.name === 'InvalidStateError') return 'The pad could not be opened. Close other apps or tabs using it, reconnect the USB cable, then try again.';
    return error.message || String(error);
  }
  async function connect() {
    if (connecting || connected || cleaning || saving || !parentReady || finished) return;
    connecting = true; controls(); status('Select the STU-540 in the browser device window, then choose Connect.');
    try {
      const pad = tablet = new TiponStu540();
      if (!await pad.connect()) {await cleanup(); status('No pad selected. Reconnect the USB cable and choose Connect signature pad again.'); return;}
      if (finished) {await cleanup(); return;}
      capability = pad.capability;
      // The upstream STU-540 demo uses pressure > 0 to distinguish ink from hover.
      threshold = {onPressureMark:0, offPressureMark:0};
      prepareCanvas();
      pad.onPen = onPen;
      pad.onDisconnect = () => {
        if (!saving && !finished) status('The pad was disconnected. Reconnect it and capture the signature again.', 'error');
        void cleanup();
      };
      await pad.prepare(bounds);
      imageData = TiponStu540.monochrome(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      await pad.writeImage(imageData, percent => {if (!finished) status('Preparing the signing area… ' + percent + '%');});
      if (finished) {await cleanup(); return;}
      await pad.setInking(true);
      connected = true;
      $('connection').textContent = 'STU-540 connected by USB'; status('Sign inside the box on the pad, then choose Save Signature.');
    } catch (error) {await cleanup(); if (!finished) status(connectionError(error), 'error');}
    finally {connecting = false; controls();}
  }
  async function clear() {
    if (!connected || saving || editingPad || finished) return;
    editingPad = true; controls();
    try {
      await tablet.setInking(false);
      inkCtx.clearRect(0, 0, ink.width, ink.height);
      hasInk = false; inkBounds = null; down = false; point = null; buttonDown = -1; frame();
      await tablet.writeImage(imageData);
      await tablet.setInking(true);
      status('Signature cleared. Please sign again.');
    } catch (error) {status(error.message || String(error), 'error'); await cleanup();}
    finally {editingPad = false; controls();}
  }
  function signaturePng() {
    const output = document.createElement('canvas'); output.width = 840; output.height = 480;
    const out = output.getContext('2d');
    const b = inkBounds;
    const x = Math.max(0, Math.floor(b.left - 6)), y = Math.max(0, Math.floor(b.top - 6));
    const w = Math.min(ink.width - x, Math.ceil(b.right - x + 6));
    const h = Math.min(ink.height - y, Math.ceil(b.bottom - y + 6));
    const scale = Math.min(800 / w, 420 / h, 2);
    out.drawImage(ink, x, y, w, h, (840 - w * scale) / 2, (480 - h * scale) / 2, w * scale, h * scale);
    return output.toDataURL('image/png');
  }
  async function save() {
    if (!connected || saving || editingPad || finished) return;
    if (!hasInk || !inkBounds) {status('Please sign inside the box first.', 'error'); return;}
    const dataUrl = signaturePng();
    if (dataUrl.length > 1600000) {status('Signature image is too large. Clear it and sign again.', 'error'); return;}
    saving = true; controls(); status('Saving to the TIPON form… Keep both windows open.');
    try {
      send('TIPON_STU_SIGNATURE', {dataUrl});
      saveTimer = setTimeout(() => status('Still waiting for the form to confirm the save. Check the TIPON signature dialog. Do not submit again yet.', 'error'), 20000);
    } catch (error) {saving = false; controls(); status(error.message, 'error');}
  }
  async function cancel() {
    if (saving) return;
    finished = true; controls();
    try {send('TIPON_STU_CANCEL');} catch (_) {}
    await cleanup(); window.close(); status('This window can now be closed.');
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!validSession || event.origin !== parentOrigin || event.source !== window.opener || !message || message.requestId !== requestId) return;
    if (message.type === 'TIPON_STU_INIT' && !finished) {
      parentReady = true;
      $('applicant').textContent = 'Applicant: ' + String(message.applicantName || 'Applicant').slice(0, 180);
      status(TiponStu540.supported() ? 'Connect the STU-540 by USB, then choose Connect signature pad.' : 'Use desktop Chrome or Edge. WebHID is not available in this browser.', TiponStu540.supported() ? '' : 'error'); controls();
    }
    if (message.type === 'TIPON_STU_RESULT' && saving && typeof message.success === 'boolean') {
      clearTimeout(saveTimer); saving = false; finished = true; controls();
      if (message.success) {
        status('Signature saved and synchronized. This window will close.', 'success');
        void cleanup().finally(() => {try {send('TIPON_STU_ACK');} catch (_) {} setTimeout(() => window.close(), 800);});
      } else {
        status(String(message.message || 'The form could not confirm the save. Check the form before trying again.').slice(0, 500), 'error');
        void cleanup();
      }
    }
  });
  window.addEventListener('pagehide', () => {finished = true; void cleanup();});
  window.addEventListener('beforeunload', event => {if (saving) {event.preventDefault(); event.returnValue = '';}});
  $('connect').addEventListener('click', connect); $('clear').addEventListener('click', clear);
  $('save').addEventListener('click', save); $('cancel').addEventListener('click', cancel);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#8095a5'; ctx.font = '24px Arial'; ctx.textAlign = 'center'; ctx.fillText('Signature preview', canvas.width / 2, canvas.height / 2); ctx.textAlign = 'left';
  if (validSession) {
    send('TIPON_STU_READY');
    setTimeout(() => {if (!parentReady) status('The TIPON dialog did not respond. Close this window and open Wacom STU-540 again from the form.', 'error');}, 7000);
  } else status('Open the TIPON form, choose Capture Signature, then Wacom STU-540.', 'error');
})();
