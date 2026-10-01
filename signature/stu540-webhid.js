/*
 * Direct STU-540 USB adapter, adapted from pabloko/Wacom-STU-WebHID.
 * Copyright (c) 2021 Pablo García - pablomorpheo@gmail.com
 * MIT License: vendor/WEBHID-LICENSE.txt
 * TIPON changes: validated reports, sequential monochrome image transfers,
 * bounded USB operations, and cleanup on failure/cancel/disconnection.
 * This is a community integration, not the official Wacom Signature SDK.
 */
'use strict';
(() => {
  const REPORT = Object.freeze({CAPABILITY:0x09, INKING:0x21, CLEAR:0x20,
    START_IMAGE:0x25, IMAGE:0x26, END_IMAGE:0x27, AREA:0x2a, PEN_COLOR:0x2d,
    PEN_MODE:0x32, PEN:0x01, PEN_TIMED:0x34});
  class TiponStu540 {
    constructor() {
      this.device = null; this.capability = null; this.onPen = null; this.onDisconnect = null;
      this.epoch = 0; this.uploading = false; this.disposing = null; this.pending = null;
      this.inputListener = event => {
        if (event.device !== this.device || !this.capability) return;
        const pen = TiponStu540.decodePen(event.reportId, event.data, this.capability);
        if (pen && this.onPen) this.onPen(pen);
      };
      this.disconnectListener = event => {
        if (event.device !== this.device) return;
        const notify = this.onDisconnect;
        void this.disconnect(false);
        if (notify) notify();
      };
    }
    static supported() {return window.isSecureContext && !!navigator.hid;}
    static decodePen(reportId, data, cap) {
      if (!data || (reportId !== REPORT.PEN && reportId !== REPORT.PEN_TIMED)) return null;
      if (data.byteLength < (reportId === REPORT.PEN_TIMED ? 10 : 6)) return null;
      // Input-report data excludes the report ID. Coordinates and pressure are big-endian.
      // Keep pressure's low 12 bits; do not mutate the HID event or rely on flag bits.
      const pressure = data.getUint16(0, false) & 0x0fff;
      const x = data.getUint16(2, false), y = data.getUint16(4, false);
      if (x > cap.tabletMaxX || y > cap.tabletMaxY || pressure > cap.tabletMaxPressure) return null;
      return {x, y, pressure};
    }
    static monochrome(rgba, width, height) {
      if (width % 8 || rgba.length !== width * height * 4) throw new Error('Invalid pad display image.');
      const packed = new Uint8Array(width * height / 8);
      for (let p = 0; p < width * height; p++) {
        const i = p * 4, alpha = rgba[i + 3] / 255;
        const light = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) * alpha + 255 * (1 - alpha);
        if (light >= 160) packed[p >> 3] |= 0x80 >> (p & 7);
      }
      return packed;
    }
    static async bounded(promise, label, ms = 6000) {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timed out. Reconnect the USB cable and try again.')), ms);
        })]);
      } finally {clearTimeout(timer);}
    }
    async connect() {
      if (!TiponStu540.supported()) throw new Error('Use desktop Chrome or Edge over HTTPS. This browser does not provide WebHID.');
      if (this.device || this.disposing) throw new Error('The pad is already opening or disconnecting.');
      const epoch = ++this.epoch;
      // Called before any asynchronous work, while the Connect click is still active.
      const choices = await navigator.hid.requestDevice({filters:[{vendorId:0x056a, productId:0x00a8}]});
      if (epoch !== this.epoch) throw new Error('Connection cancelled.');
      if (!choices.length) return false;
      if (choices.length !== 1 || choices[0].vendorId !== 0x056a || choices[0].productId !== 0x00a8) throw new Error('Select one Wacom STU-540 in USB HID mode.');
      const device = this.device = choices[0];
      try {
        const opening = device.open();
        // A late open must not leave the USB device claimed after cancel or timeout.
        opening.then(() => {if (epoch !== this.epoch && device.opened) void device.close().catch(() => {});}, () => {});
        await TiponStu540.bounded(opening, 'Opening the signature pad');
        if (epoch !== this.epoch) throw new Error('Connection cancelled.');
        const cap = await TiponStu540.bounded(device.receiveFeatureReport(REPORT.CAPABILITY), 'Reading pad settings');
        if (epoch !== this.epoch) throw new Error('Connection cancelled.');
        // Feature reports include their report ID, unlike input-report event data.
        if (cap.byteLength < 12 || cap.getUint8(0) !== REPORT.CAPABILITY) throw new Error('The pad returned an invalid capability report.');
        this.capability = {tabletMaxX:cap.getUint16(1, false), tabletMaxY:cap.getUint16(3, false),
          tabletMaxPressure:cap.getUint16(5, false), screenWidth:cap.getUint16(7, false), screenHeight:cap.getUint16(9, false)};
        const c = this.capability;
        if (c.screenWidth !== 800 || c.screenHeight !== 480 || !c.tabletMaxX || !c.tabletMaxY || !c.tabletMaxPressure || c.tabletMaxPressure > 4095) throw new Error('Unexpected STU-540 display or pen settings.');
        device.addEventListener('inputreport', this.inputListener);
        navigator.hid.addEventListener('disconnect', this.disconnectListener);
        return true;
      } catch (error) {await this.disconnect(false); throw error;}
    }
    async send(reportId, data) {
      const device = this.device, epoch = this.epoch;
      if (!device || !device.opened || this.disposing) throw new Error('The signature pad is disconnected.');
      const sending = this.pending = device.sendFeatureReport(reportId, data);
      const settled = () => {if (this.pending === sending) this.pending = null;};
      sending.then(settled, settled);
      await TiponStu540.bounded(sending, 'USB communication');
      if (epoch !== this.epoch) throw new Error('The signature pad connection ended.');
    }
    setInking(enabled) {return this.send(REPORT.INKING, new Uint8Array([enabled ? 1 : 0]));}
    clearScreen() {return this.send(REPORT.CLEAR, new Uint8Array([0]));}
    async prepare(area) {
      await this.setInking(false);
      await this.send(REPORT.PEN_MODE, new Uint8Array([2])); // TimeCountSequence, supported by STU-540.
      await this.send(REPORT.PEN_COLOR, new Uint8Array([0, 0, 0, 3]));
      const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
      // The display-area command uses little-endian pixel coordinates (upstream STU-540 implementation).
      [area.x, area.y, area.x + area.w, area.y + area.h].forEach((n, i) => view.setUint16(i * 2, Math.round(n), true));
      await this.send(REPORT.AREA, bytes);
      await this.clearScreen();
    }
    async writeImage(packed, progress = () => {}) {
      if (!this.capability || packed.length !== this.capability.screenWidth * this.capability.screenHeight / 8) throw new Error('Invalid monochrome image size.');
      if (this.uploading) throw new Error('The pad display is already updating.');
      this.uploading = true;
      await this.send(REPORT.START_IMAGE, new Uint8Array([0])); // Uncompressed 1-bit, feature-report transport.
      for (let offset = 0; offset < packed.length; offset += 253) {
        const chunk = packed.subarray(offset, Math.min(offset + 253, packed.length));
        const payload = new Uint8Array(255);
        payload[0] = chunk.length; payload[1] = 0; payload.set(chunk, 2);
        // Await every chunk. EndImage must never overtake a pending image block.
        await this.send(REPORT.IMAGE, payload);
        progress(Math.round(100 * (offset + chunk.length) / packed.length));
      }
      await this.send(REPORT.END_IMAGE, new Uint8Array([0]));
      this.uploading = false;
    }
    disconnect(clear = true) {
      if (this.disposing) return this.disposing;
      ++this.epoch;
      const device = this.device, wasUploading = this.uploading, pending = this.pending;
      this.device = null; this.capability = null; this.uploading = false;
      if (navigator.hid) navigator.hid.removeEventListener('disconnect', this.disconnectListener);
      if (device) device.removeEventListener('inputreport', this.inputListener);
      this.disposing = (async () => {
        if (!device || !device.opened) return;
        const attempt = async fn => {try {await TiponStu540.bounded(fn(), 'Releasing pad', 1000);} catch (_) {}};
        if (pending) {
          try {await TiponStu540.bounded(pending, 'Finishing USB transfer', 1000);}
          catch (_) {await attempt(() => device.close()); return;}
        }
        if (clear) {
          if (wasUploading) await attempt(() => device.sendFeatureReport(REPORT.END_IMAGE, new Uint8Array([0])));
          await attempt(() => device.sendFeatureReport(REPORT.INKING, new Uint8Array([0])));
          await attempt(() => device.sendFeatureReport(REPORT.CLEAR, new Uint8Array([0])));
        }
        await attempt(() => device.close());
      })().finally(() => {this.disposing = null;});
      return this.disposing;
    }
  }
  window.TiponStu540 = TiponStu540;
})();
