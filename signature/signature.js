/* STU operations adapted from Wacom's MIT-licensed STU SigCaptX sample.
 * Copyright (c) 2023 Wacom Co. Ltd. See vendor/WACOM-LICENSE.txt.
 * TIPON integration: signatures stay in memory until Save Signature.
 */
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
  let sdkPromise, tablet, intf, reportHandler, imageData, capability, threshold, protocol;
  let reporting = false, cleaning = false, editingPad = false, hasInk = false, down = false, point = null, buttonDown = -1;
  let bounds, buttons, inkBounds, saveTimer;
  const loadedScripts = new Set();
  function status(text, kind = '') { $('status').textContent = text; $('status').className = kind; }
  function controls() {
    $('connect').disabled = !parentReady || connecting || connected || saving || finished;
    $('clear').disabled = !connected || saving || editingPad || finished;
    $('save').disabled = !connected || !hasInk || saving || editingPad || finished;
    $('cancel').disabled = saving;
  }
  function send(type, extra = {}) {
    if (!validSession || !window.opener || window.opener.closed) throw new Error('The TIPON signature dialog was closed. Reopen Capture Signature in the form.');
    window.opener.postMessage({type, requestId, ...extra}, parentOrigin);
  }
  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function timed(value, label, ms = 12000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' timed out. Check the Wacom installation and USB connection.')), ms);
      Promise.resolve(value).then(result => {clearTimeout(timer); resolve(result);}, error => {clearTimeout(timer); reject(error);});
    });
  }
  function loadScript(src) {
    if (loadedScripts.has(src)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {loadedScripts.add(src); resolve();};
      script.onerror = () => {script.remove(); reject(new Error('Could not load the Wacom component. Check your internet connection and try again.'));};
      document.head.appendChild(script);
    });
  }
  async function loadSdk() {
    if (!sdkPromise) sdkPromise = (async () => {await loadScript('vendor/q.js'); await loadScript('vendor/wgssStuSdk.js');})();
    try {await sdkPromise;} catch (e) {sdkPromise = null; throw e;}
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
  async function cleanup() {
    if (cleaning) return;
    cleaning = true; connected = false;
    if (window.WacomGSS && WacomGSS.STU) WacomGSS.STU.onDCAtimeout = null;
    const bestEffort = async fn => {try {await timed(fn(), 'Disconnect', 1500);} catch (_) {}};
    if (reportHandler && reporting) await bestEffort(() => reportHandler.stopReporting());
    reporting = false; reportHandler = null;
    if (tablet) {
      await bestEffort(() => tablet.setInkingMode(protocol.InkingMode.InkingMode_Off));
      await bestEffort(() => tablet.setClearScreen());
      await bestEffort(() => tablet.disconnect());
    } else if (intf) await bestEffort(() => intf.disconnect());
    if (imageData) await bestEffort(() => imageData.remove());
    tablet = null; intf = null; imageData = null;
    if (window.WacomGSS && WacomGSS.STU) WacomGSS.STU.close();
    cleaning = false; $('connection').textContent = 'Disconnected'; controls();
  }
  async function connect() {
    if (connecting || connected || saving || !parentReady || finished) return;
    connecting = true; controls(); status('Connecting to the Wacom service on this laptop…');
    try {
      const alreadyLoaded = !!window.WacomGSS;
      await loadSdk();
      if (alreadyLoaded && !WacomGSS.STU.isServiceReady()) WacomGSS.STU.Reinitialize();
      const start = Date.now();
      while (!WacomGSS.STU.isServiceReady()) {
        if (Date.now() - start > 12000) throw new Error('Wacom STU SigCaptX is not connected. Install STU SigCaptX, reopen the browser, and allow local network access when prompted.');
        await delay(150);
      }
      if (!await timed(WacomGSS.STU.isDCAReady(), 'Wacom service')) throw new Error('Wacom device service is not ready. Sign out and back into Windows after installation, then try again.');
      const devices = await timed(WacomGSS.STU.getUsbDevices(), 'Find signature pad');
      const matches = (devices || []).filter(d => Number(d.idVendor) === 0x056a && Number(d.idProduct) === 0x00a8);
      if (!matches.length) throw new Error('No STU-540 found in USB HID mode. Reconnect its USB cable and close any other app using the pad.');
      if (matches.length !== 1) throw new Error('More than one STU-540 is connected. Leave only the pad you want to use connected.');
      protocol = new WacomGSS.STU.Protocol();
      intf = new WacomGSS.STU.UsbInterface();
      await timed(intf.Constructor(), 'Prepare USB');
      await timed(intf.connect(matches[0], true), 'Connect USB');
      tablet = new WacomGSS.STU.Tablet();
      await timed(tablet.Constructor(intf), 'Prepare pad');
      threshold = await timed(tablet.getInkThreshold(), 'Read pen settings');
      capability = await timed(tablet.getCapability(), 'Read pad settings');
      if (!(capability.screenWidth > 0 && capability.screenHeight > 150 && capability.tabletMaxX > 0 && capability.tabletMaxY > 0)) throw new Error('The pad returned invalid display settings.');
      prepareCanvas();
      await timed(tablet.setInkingMode(protocol.InkingMode.InkingMode_Off), 'Prepare signing area');
      await timed(tablet.setClearScreen(), 'Clear pad');
      if (await timed(tablet.isSupported(protocol.ReportId.ReportId_PenDataOptionMode), 'Check pen mode')) {
        await timed(tablet.setPenDataOptionMode(protocol.PenDataOptionMode.PenDataOptionMode_TimeCountSequence), 'Set pen mode');
      }
      const mode = protocol.EncodingMode.EncodingMode_1bit;
      imageData = await timed(WacomGSS.STU.ProtocolHelper.resizeAndFlatten(canvas.toDataURL('image/jpeg'), 0, 0, 0, 0, canvas.width, canvas.height, mode, 1, false, 0, true), 'Prepare pad display');
      await timed(tablet.writeImage(mode, imageData), 'Show signing area');
      reportHandler = new WacomGSS.STU.ProtocolHelper.ReportHandler();
      reportHandler.onReportPenData = onPen;
      reportHandler.onReportPenDataOption = onPen;
      reportHandler.onReportPenDataTimeCountSequence = onPen;
      reportHandler.onReportPenDataTimeCountSequenceEncrypted = onPen;
      const pair = report => (report.penData || []).forEach(onPen);
      reportHandler.onReportPenDataEncrypted = pair;
      reportHandler.onReportPenDataEncryptedOption = pair;
      reportHandler.tabletDisconnected = () => {status('The signature pad was disconnected. Reconnect it and choose Connect signature pad.', 'error'); void cleanup();};
      WacomGSS.STU.onDCAtimeout = () => {status('The Wacom connection ended. Reconnect the pad and try again.', 'error'); void cleanup();};
      connected = true;
      await timed(reportHandler.startReporting(tablet, true), 'Start pen capture'); reporting = true;
      await timed(tablet.setInkingMode(protocol.InkingMode.InkingMode_On), 'Enable pen');
      $('connection').textContent = 'STU-540 connected'; status('Sign inside the box on the pad, then choose Save Signature.');
    } catch (error) {await cleanup(); status(error.message || String(error), 'error');}
    finally {connecting = false; controls();}
  }
  async function clear() {
    if (!connected || saving || editingPad || finished) return;
    editingPad = true; controls();
    try {
      await timed(tablet.setInkingMode(protocol.InkingMode.InkingMode_Off), 'Pause pen');
      inkCtx.clearRect(0, 0, ink.width, ink.height);
      hasInk = false; inkBounds = null; down = false; point = null; buttonDown = -1; frame();
      await timed(tablet.writeImage(protocol.EncodingMode.EncodingMode_1bit, imageData), 'Clear signature');
      await timed(tablet.setInkingMode(protocol.InkingMode.InkingMode_On), 'Enable pen');
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
      status('Connect the STU-540, then choose Connect signature pad.'); controls();
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
  window.addEventListener('pagehide', () => {if (window.WacomGSS && WacomGSS.STU) WacomGSS.STU.close();});
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
