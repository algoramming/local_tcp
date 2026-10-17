#!/usr/bin/env node
// Local TCP — Native Messaging Host (Node.js)
// =============================================================================
// WHY NODE (and not the Go binary): on macOS 15/26, Local Network Privacy keys
// LAN access to the *executable's* code identity. Chrome ends up running the
// system/Homebrew `node` binary here (via the shebang the installer patches in),
// which macOS recognizes and allows to reach 192.168.x.x. A bare custom Go
// binary is an unknown executable that macOS silently denies — so its TCP
// connects to the printer fail with "no route to host" even though ping works.
// Running through `node` sidesteps that entirely. (See git history for the Go
// host that hit this wall.)
//
// Protocol: Chrome Native Messaging — 4-byte little-endian length prefix + JSON.
// Actions:  PING | CONNECT | SEND | PRINT | DISCONNECT | USB_LIST | USB_PRINT
// Every response echoes the caller's `reqId` so background.js can correlate
// concurrent requests safely.
//
// USB printing (see the "USB printers" section below) reaches printers the
// browser can't:
//   * Windows : straight to Windows' built-in USB printer driver (usbprint.sys),
//               so no vendor driver is needed, or RAW through any installed
//               Windows printer. Node can't call those APIs itself, so this
//               delegates to usb_windows.ps1, a long-lived PowerShell helper.
//   * Linux   : /dev/usb/lp* (the kernel's usblp driver), or RAW through CUPS.
//   * macOS   : straight to the printer through macOS's own CUPS `usb`
//               backend (no driver, nothing to add in System Settings), or RAW
//               through installed CUPS printers. Chrome on macOS can also
//               reach USB printers itself (WebUSB).
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Reported back on PING so the popup's "bridge status" shows which host is live.
// Independent of the extension's manifest version on purpose: this is the value
// that tells you *which native host binary* is actually installed.
const VERSION = '2.1.2';

// What this host can do, reported on PING. Clients feature-detect on this
// instead of comparing versions: a host without 'usb' predates USB printing.
const FEATURES = ['tcp', 'usb'];

// `node index.js --lp-write <device>`: the Linux USB writer (see writeLinuxDevice).
const LP_WRITER_FLAG = '--lp-write';

// ─── Connection state ────────────────────────────────────────────────────────
const connections = new Map(); // id -> net.Socket (live, reusable)
const opChains = new Map();     // id -> Promise (serializes ops per connection)

// ─── Native Messaging framing ────────────────────────────────────────────────
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function startNativeMessaging() {
  let inbuf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    inbuf = Buffer.concat([inbuf, chunk]);
    // Drain every complete framed message currently buffered.
    while (inbuf.length >= 4) {
      const len = inbuf.readUInt32LE(0);
      if (len === 0 || len > 64 * 1024 * 1024) { // corrupt framing — resync by dropping
        inbuf = Buffer.alloc(0);
        send({ success: false, error: 'invalid message length' });
        break;
      }
      if (inbuf.length < 4 + len) break; // wait for the rest
      const body = inbuf.subarray(4, 4 + len);
      inbuf = inbuf.subarray(4 + len);
      let req;
      try {
        req = JSON.parse(body.toString('utf8'));
      } catch (e) {
        send({ success: false, error: 'JSON parse error: ' + e.message });
        continue;
      }
      Promise.resolve()
        .then(() => handle(req))
        .catch((e) => send({ reqId: req && req.reqId, success: false, error: 'Host error: ' + (e && e.message || e) }));
    }
  });
  process.stdin.on('end', () => process.exit(0)); // Chrome closed the port
  process.on('uncaughtException', (e) => { try { send({ success: false, error: 'Uncaught: ' + e.message }); } catch (_) {} });
  // Never leave the Windows USB helper running after the browser lets go of us.
  process.on('exit', () => { if (winHelper) winHelper.stop(); });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function connId(req) {
  return req.connectionId || `${req.host}:${req.port}`;
}

// A single TCP connect attempt with an application-level timeout.
function dialOnce(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    socket.setTimeout(timeoutMs > 0 ? timeoutMs : 5000);
    socket.once('connect', () => { settled = true; socket.setTimeout(0); resolve(socket); });
    socket.once('timeout', () => { if (!settled) { socket.destroy(); reject(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })); } });
    socket.once('error', (err) => { if (!settled) { socket.destroy(); reject(err); } });
    socket.connect(port, host);
  });
}

// Errors that typically clear on retry (printer asleep / ARP not yet resolved /
// momentary timeout) rather than a hard config error like connection refused.
function isTransient(err) {
  const c = err && err.code;
  return c === 'EHOSTUNREACH' || c === 'EHOSTDOWN' || c === 'ENETUNREACH' ||
         c === 'ETIMEDOUT' || /timeout/i.test((err && err.message) || '');
}

// Fast path for an awake printer; on a transient miss, keep retrying within a
// budget kept under the extension's 30s request timeout so a real error still
// surfaces to the caller before it gives up.
async function dialWithRetry(host, port, timeoutMs) {
  const deadline = Date.now() + 25000;
  const perAttempt = Math.min(timeoutMs > 0 ? timeoutMs : 4000, 4000);
  let lastErr;
  do {
    try {
      return await dialOnce(host, port, perAttempt);
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e; // hard error — fail fast
    }
  } while (Date.now() < deadline);
  throw lastErr;
}

function getConn(id) {
  const s = connections.get(id);
  return s && !s.destroyed ? s : null;
}
function setConn(id, s) {
  const old = connections.get(id);
  if (old && old !== s) old.destroy();
  connections.set(id, s);
  s.once('close', () => { if (connections.get(id) === s) connections.delete(id); });
}
function dropConn(id) {
  const s = connections.get(id);
  if (s) { s.destroy(); connections.delete(id); }
}

// Serialize all operations on the same connection id so two concurrent print
// jobs can't interleave their ESC/POS byte streams and corrupt output.
function chain(id, fn) {
  const prev = opChains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  opChains.set(id, next.catch(() => {}));
  return next;
}

// Read back a short reply (e.g. ESC/POS DLE EOT status) for up to timeoutMs.
function readBack(socket, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    const onData = (d) => chunks.push(d);
    const finish = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', finish);
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };
    socket.on('data', onData);
    socket.once('error', finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// ─── Request dispatch ────────────────────────────────────────────────────────
async function handle(req) {
  const reqId = req.reqId;
  switch (req.action) {
    case 'PING':
      return send({
        reqId, success: true, message: 'Pong', version: VERSION,
        features: FEATURES, platform: PLATFORM, usb: usbCapabilities(),
      });

    case 'CONNECT': {
      const id = connId(req);
      return chain(id, async () => {
        try {
          const s = await dialWithRetry(req.host, req.port, req.timeoutMs || 0);
          setConn(id, s);
          send({ reqId, success: true, message: `Connected to ${req.host}:${req.port}`, connectionId: id });
        } catch (e) {
          send({ reqId, success: false, error: 'Socket error: ' + e.message, connectionId: id });
        }
      });
    }

    case 'SEND':
    case 'PRINT': {
      const id = connId(req);
      if (!Array.isArray(req.data)) return send({ reqId, success: false, error: 'Invalid data format' });
      return chain(id, async () => {
        let s = getConn(id);
        if (!s) {
          try {
            s = await dialWithRetry(req.host, req.port, req.timeoutMs || 0);
            setConn(id, s);
          } catch (e) {
            return send({ reqId, success: false, error: 'Socket connect failed: ' + e.message });
          }
        }
        const payload = Buffer.from(req.data.map((b) => b & 0xFF));
        try {
          await new Promise((res, rej) => s.write(payload, (err) => (err ? rej(err) : res())));
        } catch (e) {
          dropConn(id); // stale socket — drop so the next attempt re-dials
          return send({ reqId, success: false, error: 'Write failed: ' + e.message });
        }
        const resp = { reqId, success: true, bytesSent: payload.length, connectionId: id };
        if (req.readTimeoutMs > 0) {
          const back = await readBack(s, req.readTimeoutMs);
          if (back.length) resp.data = Array.from(back);
          else resp.message = 'Written; no status reply within readTimeoutMs';
        }
        send(resp);
      });
    }

    case 'DISCONNECT': {
      const id = connId(req);
      return chain(id, async () => {
        if (getConn(id)) { dropConn(id); send({ reqId, success: true, message: 'Disconnected' }); }
        else send({ reqId, success: true, message: 'No connection to disconnect' });
      });
    }

    case 'USB_LIST':
      return send(Object.assign({ reqId }, await usbList(req)));

    case 'USB_PRINT': {
      const key = 'usb:' + String(req.printerId || '');
      return chain(key, async () => send(Object.assign({ reqId }, await usbPrint(req))));
    }

    default:
      return send({ reqId, success: false, error: 'Unknown action: ' + req.action });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// USB printers
// ═════════════════════════════════════════════════════════════════════════════
// Every printer is listed as one of two kinds:
//   * 'device' — a USB printer the host writes to directly (Windows usbprint.sys,
//                Linux /dev/usb/lp*). No printer driver or OS setup needed.
//   * 'queue'  — a printer installed in the OS (a Windows printer, or a CUPS
//                queue on macOS/Linux). The bytes go through the OS spooler
//                untouched (RAW), so they still reach the printer as ESC/POS.
//
// Printer ids are opaque strings meant to be stored by the caller and passed
// back to USB_PRINT. A USB device can come back under another id after being
// replugged into another port, so USB_PRINT also takes an optional
// `match: { vendorId, productId, serialNumber }` and falls back to the single
// connected printer that matches it (returned as `resolvedPrinterId`).
//
// Failures carry a stable `code` next to the human-readable `error`:
//   notFound · busy · permissionDenied · timeout · ioError · invalidRequest ·
//   unsupported · helperMissing · helperFailed

const PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

const USB_DEFAULT_TIMEOUT_MS = 20000;
const USB_MIN_TIMEOUT_MS = 3000;
const USB_MAX_TIMEOUT_MS = 120000;
const USB_MAX_JOB_BYTES = 16 * 1024 * 1024;
const USB_WRITE_CHUNK = 64 * 1024;
const USB_JOB_TITLE = 'Local TCP receipt';

const USB_MESSAGES = {
  notFound: 'The printer is not connected. Check the USB cable and that the printer is switched on.',
  busy: 'The printer is busy with another program (for example the system print queue). Try again in a moment.',
  permissionDenied: PLATFORM === 'linux'
    ? 'Linux did not allow access to the USB printer. Run the Local TCP installer again (it sets up USB printer access), or run "sudo usermod -aG lp $USER" and then log out and back in.'
    : 'The system did not allow access to the printer.',
  timeout: 'The printer did not take the data in time. Check that it has paper, the cover is closed and it is online.',
  ioError: 'The printer reported an error while printing.',
  invalidRequest: 'The print request was not valid.',
  unsupported: 'This kind of printer is not supported on this computer.',
  helperMissing: 'A file of the Local TCP bridge is missing. Download the Setup Kit from the extension popup and run it again.',
  helperFailed: 'Windows could not start the Local TCP USB helper.',
};

class UsbError extends Error {
  constructor(code, message, detail) {
    super(message || USB_MESSAGES[code] || code);
    this.code = code;
    if (detail) this.detail = String(detail).slice(0, 600);
  }
}

function usbFailure(e) {
  if (e instanceof UsbError) {
    const r = { success: false, code: e.code, error: e.message };
    if (e.detail) r.detail = e.detail;
    return r;
  }
  return { success: false, code: 'ioError', error: USB_MESSAGES.ioError, detail: String(e && e.message || e).slice(0, 600) };
}

function usbCapabilities() {
  if (PLATFORM === 'win') return { devices: true, queues: true, helper: fs.existsSync(WIN_HELPER_SCRIPT) };
  if (PLATFORM === 'linux') return { devices: true, queues: true };
  return { devices: fs.existsSync(MAC_USB_BACKEND), queues: true };
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return USB_DEFAULT_TIMEOUT_MS;
  return Math.min(USB_MAX_TIMEOUT_MS, Math.max(USB_MIN_TIMEOUT_MS, Math.round(n)));
}

// ─── USB_LIST ────────────────────────────────────────────────────────────────
async function usbList(req) {
  try {
    const result = await listUsbPrinters({ includeVirtual: !!req.includeVirtual });
    return { success: true, platform: PLATFORM, printers: result.printers, notes: result.notes };
  } catch (e) {
    return Object.assign({ platform: PLATFORM }, usbFailure(e));
  }
}

async function listUsbPrinters(opts) {
  if (PLATFORM === 'win') return listWindowsPrinters(opts);
  const notes = [];
  const printers = [];
  if (PLATFORM === 'linux') {
    const devices = listLinuxDevices();
    printers.push(...devices);
    if (devices.some((d) => !d.accessible)) {
      notes.push({ code: 'permissionDenied', level: 'warn', message: USB_MESSAGES.permissionDenied });
    }
    if (!devices.length && linuxHasUnboundPrinter()) {
      notes.push({
        code: 'usblpMissing', level: 'warn',
        message: 'A USB printer is connected, but Linux has not created /dev/usb/lp0 for it. Load the USB printer driver with "sudo modprobe usblp", then press Refresh.',
      });
    }
  } else {
    printers.push(...await listMacUsbDevices());
  }
  const cups = await listCupsQueues(opts);
  if (cups.available) {
    linkQueuesToDevices(printers, cups.printers);
    printers.push(...cups.printers);
  } else if (PLATFORM === 'mac') {
    notes.push({ code: 'cupsUnavailable', level: 'warn', message: 'The macOS printing system (CUPS) did not respond, so installed printers could not be listed.' });
  }
  return { printers: classifyPrinters(printers), notes };
}

// ─── USB_PRINT ───────────────────────────────────────────────────────────────
async function usbPrint(req) {
  const printerId = typeof req.printerId === 'string' ? req.printerId : '';
  const timeoutMs = clampTimeout(req.timeoutMs);
  const jobName = typeof req.jobName === 'string' && req.jobName.trim() ? req.jobName.trim().slice(0, 100) : USB_JOB_TITLE;
  try {
    if (!printerId) throw new UsbError('invalidRequest', 'No printer was chosen (printerId is missing).');
    const data = decodeJobData(req);
    let target = printerId;
    let result;
    try {
      result = await printToUsbTarget(target, data, timeoutMs, jobName);
    } catch (e) {
      // The printer may have moved to another USB port, or Linux may have
      // renumbered it (lp0 → lp1). Find it again by what it is, not where it is.
      if (!(e instanceof UsbError) || e.code !== 'notFound' || !req.match) throw e;
      const found = await findMatchingPrinter(printerId, req.match);
      if (!found) throw e;
      target = found.id;
      result = await printToUsbTarget(target, data, timeoutMs, jobName);
    }
    const resp = { success: true, printerId, bytesSent: data.length };
    if (target !== printerId) resp.resolvedPrinterId = target;
    if (result && result.jobId) resp.jobId = result.jobId;
    return resp;
  } catch (e) {
    return Object.assign({ printerId }, usbFailure(e));
  }
}

// Accepts `dataB64` (preferred: about a third of the size of a JSON number
// array, which matters for raster receipts) or the `data` number array that the
// TCP actions use.
function decodeJobData(req) {
  let data;
  if (typeof req.dataB64 === 'string') {
    data = Buffer.from(req.dataB64, 'base64');
  } else if (Array.isArray(req.data)) {
    data = Buffer.from(req.data.map((b) => b & 0xFF));
  } else {
    throw new UsbError('invalidRequest', 'Nothing to print: send the ESC/POS bytes as dataB64 (base64) or data (number array).');
  }
  if (!data.length) throw new UsbError('invalidRequest', 'Nothing to print: the data is empty.');
  if (data.length > USB_MAX_JOB_BYTES) throw new UsbError('invalidRequest', 'The print job is larger than 16 MB.');
  return data;
}

async function printToUsbTarget(id, data, timeoutMs, jobName) {
  const sep = id.indexOf(':');
  const scheme = sep > 0 ? id.slice(0, sep) : '';
  const rest = sep > 0 ? id.slice(sep + 1) : '';
  switch (scheme) {
    case 'win-usb':
      requirePlatform('win');
      return writeWindowsDevice(rest, data, timeoutMs);
    case 'win-queue':
      requirePlatform('win');
      return writeWindowsQueue(rest, data, timeoutMs, jobName);
    case 'linux-usb': {
      requirePlatform('linux');
      const device = listLinuxDevices().find((d) => d.id === id);
      if (!device) throw new UsbError('notFound');
      if (!device.accessible) throw new UsbError('permissionDenied');
      return writeLinuxDevice(device.path, data, timeoutMs);
    }
    case 'mac-usb':
      requirePlatform('mac');
      return printMacUsb(rest, data, timeoutMs, jobName);
    case 'cups':
      if (PLATFORM === 'win') throw new UsbError('unsupported');
      return printCups(rest, data, timeoutMs, jobName);
    default:
      throw new UsbError('invalidRequest', 'Unknown printer id. List the printers again with USB_LIST and choose one.');
  }
}

function requirePlatform(p) {
  if (PLATFORM !== p) throw new UsbError('unsupported', 'This printer was set up on another operating system. Choose a printer on this computer.');
}

async function findMatchingPrinter(printerId, match) {
  const vendorId = Number(match.vendorId);
  const productId = Number(match.productId);
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null;
  const serial = typeof match.serialNumber === 'string' && match.serialNumber ? match.serialNumber : null;
  const scheme = printerId.slice(0, printerId.indexOf(':') + 1);
  let list;
  try {
    list = (await listUsbPrinters({ includeVirtual: false })).printers;
  } catch (_) {
    return null;
  }
  const candidates = list.filter((p) =>
    p.kind === 'device' && p.id.indexOf(scheme) === 0 &&
    p.vendorId === vendorId && p.productId === productId &&
    (!serial || p.serialNumber === serial));
  return candidates.length === 1 ? candidates[0] : null; // never guess between twins
}

// ─── Receipt printer detection ───────────────────────────────────────────────
// The bridge is for ESC/POS receipt printers, but the OS lists show office
// printers (laser, inkjet, PDF, label) too, and raw ESC/POS sent to those prints
// pages of symbols. Every printer gets a `category` so clients can lead with
// the receipt printers:
//   'receipt' — reports ESC/POS in its IEEE 1284 ID, or has a receipt-printer name
//   'other'   — reports an office/label command set, or has an office-printer name
//   'unknown' — nothing to go on (many unbranded receipt printers look like this)
// The printer's own command set wins over any name.

const RECEIPT_CMD = /ESC\s*\/?\s*POS|STAR\s*(LINE|PRNT)/i;
const OTHER_CMD = /\b(PCL\w*|PJL|POSTSCRIPT|PS|URF|PWG\w*|PDF|ESCPL2|ESC\/P-?R|ESCPR\w*|BDC|IPP\w*|XPS|LIPS\w*|RPCS|GDI|CAPT|ZPL\w*|EPL\d?|CPCL|TSPL\d?)\b/i;
const RECEIPT_NAME = new RegExp([
  'receipt', 'thermal', 'esc\\/?pos', '\\bpos[\\s_-]?(58|76|80)', '\\bpos\\b', 'kitchen', 'ticket',
  '\\btm[\\s_-]?[tmpuhl]\\d', '\\btsp\\s?\\d', '\\bsp\\s?7\\d\\d', 'mc-?print', '\\bsrp-?\\d', 'bixolon', 'posiflex',
  'xprinter', '\\bxp-?(58|80|n\\d{3}|q\\d{3}|t\\d{2})', 'rongta', '\\brp[\\s_-]?(58|80|\\d{3})', 'hprt', 'gprinter',
  '\\bgp-?\\d', 'zjiang', '\\bzj-?\\d', 'goojprt', 'munbyn', 'sunmi', '\\bct-?s\\d', '\\bdeli\\b',
  'generic\\s*\\/\\s*text only', '\\b(58|80)\\s?mm\\b'
].join('|'), 'i');
const OTHER_NAME = new RegExp([
  'laserjet', 'deskjet', 'officejet', '\\benvy\\b', 'pagewide', 'smart tank', 'pixma', 'imageclass', 'imagerunner',
  'maxify', 'selphy', 'ecotank', 'workforce', 'surecolor', 'stylus', 'epson\\s+(et|wf|xp|l)-?\\d{3,4}', '\\bhl-',
  '\\bmfc-', '\\bdcp-', 'kyocera', 'ecosys', 'taskalfa', 'ricoh', 'lexmark', 'xerox', 'workcentre', 'versalink',
  'phaser', 'bizhub', 'konica', '\\boki\\b', '\\blbp\\d', '\\bmf\\d{3}', '\\bg[1-7]0\\d0\\b', 'pdf', 'xps',
  'onenote', '\\bfax\\b', 'ipp class', 'mopria', 'postscript', '\\bpcl\\b', 'zebra', '\\bzpl\\b', 'label', 'dymo'
].join('|'), 'i');

// Paper width from the model name, when it says (XP-80C, POS-58, RP80, ...).
// Only ever a hint: the app's own paper-size setting stays the authority.
function paperWidthHint(text) {
  if (/\btm[\s_-]?(t(20|70|81|82|83|86|88|90)|m(30|50))/i.test(text)) return 80; // Epson TM-T/TM-m: 80 mm
  if (/\btm[\s_-]?p20/i.test(text)) return 58;
  const m = /(?:^|[^0-9])(58|80)(?:\s?mm)?(?![0-9])/i.exec(text);
  return m ? Number(m[1]) : null;
}

function classifyPrinter(p) {
  const cmd = p.commandSet || '';
  const text = [p.name, p.model, p.manufacturer, p.driver].filter(Boolean).join(' ');
  if (RECEIPT_CMD.test(cmd)) p.category = 'receipt';
  else if (cmd && OTHER_CMD.test(cmd)) p.category = 'other';
  else if (RECEIPT_NAME.test(text)) p.category = 'receipt';
  else if (OTHER_NAME.test(text)) p.category = 'other';
  else p.category = 'unknown';
  if (p.category === 'receipt') {
    const width = paperWidthHint(text);
    if (width) p.paperWidthMm = width;
  }
}

// Classifies every printer, lets a queue and the USB device it drives (one
// physical printer) share what each knows, and puts receipt printers first.
function classifyPrinters(printers) {
  printers.forEach(classifyPrinter);
  for (const q of printers) {
    if (!q.devicePrinterId) continue;
    const d = printers.find((p) => p.id === q.devicePrinterId);
    if (!d) continue;
    // The device's own command set is the better witness; the queue's driver
    // name fills in when the device said nothing.
    const known = d.category !== 'unknown' ? d : q;
    d.category = q.category = known.category;
    const width = d.paperWidthMm || q.paperWidthMm;
    if (width && known.category === 'receipt') d.paperWidthMm = q.paperWidthMm = width;
  }
  const rank = { receipt: 0, unknown: 1, other: 2 };
  // Stable sort: within a category, the platform order (devices first) stays.
  return printers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (rank[a.p.category] - rank[b.p.category]) || (a.i - b.i))
    .map((x) => x.p);
}

// ─── Shared parsing ──────────────────────────────────────────────────────────

// IEEE 1284 Device ID, e.g. "MFG:Xprinter;MDL:XP-80C;CMD:ESC/POS;".
function parse1284(id) {
  const out = {};
  if (!id) return out;
  for (const part of String(id).split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toUpperCase();
    const val = part.slice(i + 1).trim();
    if (!val) continue;
    if (key === 'MFG' || key === 'MANUFACTURER') out.manufacturer = val;
    else if (key === 'MDL' || key === 'MODEL') out.model = val;
    else if (key === 'CMD' || key === 'COMMAND SET') out.commandSet = val;
    else if (key === 'DES' || key === 'DESCRIPTION') out.description = val;
    else if (key === 'SN' || key === 'SERN' || key === 'SERIALNUMBER') out.serialNumber = val;
  }
  return out;
}

function hex4(n) {
  return ('0000' + n.toString(16)).slice(-4);
}

// The best human name available: 1284 make + model, then the USB product
// string, then the vendor/product ids.
function usbDisplayName(info, fallback, vendorId, productId) {
  const mfg = info.manufacturer;
  const mdl = info.model;
  if (mdl) return mfg && mdl.toLowerCase().indexOf(mfg.toLowerCase()) !== 0 ? `${mfg} ${mdl}` : mdl;
  if (info.description) return info.description;
  if (fallback) return fallback;
  if (vendorId != null && productId != null) return `USB printer ${hex4(vendorId)}:${hex4(productId)}`;
  return 'USB printer';
}

// ─── Linux: /dev/usb/lp* (usblp) ─────────────────────────────────────────────

function readSysfs(dir, file) {
  try {
    const v = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\0/g, '').trim();
    return v || null;
  } catch (_) {
    return null;
  }
}

function listLinuxDevices() {
  let names = [];
  try {
    names = fs.readdirSync('/dev/usb').filter((n) => /^lp\d+$/.test(n));
  } catch (_) {
    return [];
  }
  names.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  return names.map((n) => {
    const devPath = '/dev/usb/' + n;
    let ifaceDir = null;
    try { ifaceDir = fs.realpathSync(`/sys/class/usbmisc/${n}/device`); } catch (_) {}
    // ifaceDir is the USB interface (…/1-2:1.0); its parent is the device (…/1-2).
    const devDir = ifaceDir ? path.dirname(ifaceDir) : null;
    const info = parse1284(ifaceDir && readSysfs(ifaceDir, 'ieee1284_id'));
    const vendorId = devDir ? parseInt(readSysfs(devDir, 'idVendor') || '', 16) : NaN;
    const productId = devDir ? parseInt(readSysfs(devDir, 'idProduct') || '', 16) : NaN;
    const serialNumber = (devDir && readSysfs(devDir, 'serial')) || info.serialNumber || null;
    const product = devDir ? readSysfs(devDir, 'product') : null;
    const manufacturer = info.manufacturer || (devDir && readSysfs(devDir, 'manufacturer')) || null;
    const port = devDir ? path.basename(devDir) : null; // e.g. "1-2.3": the physical port path
    const hasIds = Number.isInteger(vendorId) && Number.isInteger(productId);
    // Id by identity (serial) or physical port, never by lpN, which changes on replug.
    let id = 'linux-usb:' + n;
    if (hasIds) id = `linux-usb:${hex4(vendorId)}:${hex4(productId)}:${serialNumber ? 'sn=' + serialNumber : 'port=' + (port || n)}`;
    let accessible = true;
    try { fs.accessSync(devPath, fs.constants.W_OK); } catch (_) { accessible = false; }
    return {
      id,
      kind: 'device',
      connection: 'usb',
      name: usbDisplayName(info, product, hasIds ? vendorId : null, hasIds ? productId : null),
      manufacturer,
      model: info.model || product || null,
      commandSet: info.commandSet || null,
      vendorId: hasIds ? vendorId : null,
      productId: hasIds ? productId : null,
      serialNumber,
      path: devPath,
      port,
      accessible,
    };
  });
}

// A printer-class (07) USB interface with no lp device means usblp isn't loaded
// (or is blacklisted). Worth telling the user, since the fix is one command.
function linuxHasUnboundPrinter() {
  try {
    return fs.readdirSync('/sys/bus/usb/devices')
      .filter((n) => n.indexOf(':') > 0)
      .some((n) => readSysfs('/sys/bus/usb/devices/' + n, 'bInterfaceClass') === '07');
  } catch (_) {
    return false;
  }
}

// Writes run in a child process (this same script in --lp-write mode). A usblp
// write blocks while the printer is out of paper or offline, and only a signal
// ends that wait: killing the child releases the device, whereas a blocked
// write inside this process would tie up a libuv thread for good.
function writeLinuxDevice(devicePath, data, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let errText = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    let child;
    try {
      child = spawn(process.execPath, [__filename, LP_WRITER_FLAG, devicePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish(new UsbError('ioError', 'Could not start the USB writer.', e.message));
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new UsbError('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errText = (errText + d).slice(-600); });
    child.on('error', (e) => finish(new UsbError('ioError', 'Could not start the USB writer.', e.message)));
    child.on('close', () => {
      let r = null;
      try { r = JSON.parse(out); } catch (_) {}
      if (r && r.ok) return finish(null, { bytes: r.bytes });
      const code = r && r.code;
      const detail = (r && r.message) || errText.trim() || 'the USB writer exited unexpectedly';
      finish(new UsbError(linuxErrnoToCode(code), null, detail));
    });
    child.stdin.on('error', () => {}); // EPIPE when the child failed before reading
    child.stdin.end(data);
  });
}

function linuxErrnoToCode(errno) {
  switch (errno) {
    case 'EACCES': case 'EPERM': return 'permissionDenied';
    case 'ENOENT': case 'ENODEV': case 'ENXIO': return 'notFound';
    case 'EBUSY': return 'busy';
    default: return 'ioError';
  }
}

// --lp-write mode: read the whole job from stdin, write it with blocking
// writes, report one JSON line on stdout. usblp returns from a blocking write
// only once the printer has taken the bytes, so closing afterwards is safe.
function runLpWriter(devicePath) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const data = Buffer.concat(chunks);
    let fd = null;
    try {
      fd = fs.openSync(devicePath, fs.constants.O_WRONLY);
      let off = 0;
      while (off < data.length) {
        off += fs.writeSync(fd, data, off, Math.min(USB_WRITE_CHUNK, data.length - off));
      }
      fs.closeSync(fd);
      process.stdout.write(JSON.stringify({ ok: true, bytes: data.length }));
      process.exitCode = 0;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      process.stdout.write(JSON.stringify({ ok: false, code: e.code || 'EIO', message: e.message }));
      process.exitCode = 1;
    }
  });
}

// ─── macOS / Linux: CUPS queues (lp -o raw) ──────────────────────────────────

function runTool(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    // The C locale keeps lpstat's output in English so it can be parsed.
    const env = Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' });
    execFile(cmd, args, { env, timeout: timeoutMs || 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function listCupsQueues(opts) {
  const [v, p, d] = await Promise.all([
    runTool('lpstat', ['-v']),
    runTool('lpstat', ['-l', '-p']),
    runTool('lpstat', ['-d']),
  ]);
  if (v.error && v.error.code === 'ENOENT') return { available: false, printers: [] };
  // "lpstat: No destinations added." exits non-zero but is just an empty list.
  if (v.error && !/no destinations/i.test(v.stderr + v.stdout) && !v.stdout.trim()) {
    return { available: false, printers: [] };
  }

  const uris = new Map();
  for (const line of v.stdout.split('\n')) {
    const m = /^device for (.+?):\s+(.+)$/.exec(line.trim());
    if (m) uris.set(m[1], m[2].trim());
  }

  const details = new Map();
  let current = null;
  for (const line of p.stdout.split('\n')) {
    const head = /^printer (\S+) (.*)$/.exec(line);
    if (head) {
      current = { status: /disabled/.test(head[2]) ? 'offline' : /now printing/.test(head[2]) ? 'printing' : 'ready' };
      details.set(head[1], current);
      continue;
    }
    const desc = /^\s+Description:\s*(.*)$/.exec(line);
    if (desc && current) current.description = desc[1].trim();
  }

  const defMatch = /system default destination:\s*(\S+)/.exec(d.stdout);
  const defaultName = defMatch ? defMatch[1] : null;

  const printers = [];
  for (const [name, uri] of uris) {
    const info = cupsUriInfo(uri);
    if (info.virtual && !opts.includeVirtual) continue;
    const det = details.get(name) || {};
    printers.push({
      id: 'cups:' + name,
      kind: 'queue',
      connection: info.connection,
      name: det.description || name.replace(/_/g, ' '),
      queue: name,
      manufacturer: info.manufacturer,
      model: info.model,
      serialNumber: info.serialNumber,
      uri,
      status: det.status || 'ready',
      isDefault: name === defaultName,
    });
  }
  // USB printers first, then network, then the rest.
  const rank = { usb: 0, network: 1, serial: 2, other: 3 };
  printers.sort((a, b) => (rank[a.connection] - rank[b.connection]) || a.name.localeCompare(b.name));
  return { available: true, printers };
}

function cupsUriInfo(uri) {
  const out = { connection: 'other', manufacturer: null, model: null, serialNumber: null, virtual: false };
  const m = /^([a-z0-9+.-]+):/i.exec(uri);
  const scheme = m ? m[1].toLowerCase() : '';
  if (scheme === 'usb') {
    out.connection = 'usb';
    // usb://Make/Model?serial=XXXX&interface=1   (macOS: ?location=14200000)
    const body = uri.slice('usb://'.length);
    const q = body.indexOf('?');
    const pathPart = q >= 0 ? body.slice(0, q) : body;
    const query = q >= 0 ? body.slice(q + 1) : '';
    const segs = pathPart.split('/').map(safeDecode).filter(Boolean);
    out.manufacturer = segs[0] || null;
    out.model = segs[1] || null;
    for (const kv of query.split('&')) {
      const [k, val] = kv.split('=');
      if (k === 'serial' && val) out.serialNumber = safeDecode(val);
    }
  } else if (['socket', 'ipp', 'ipps', 'lpd', 'http', 'https', 'dnssd', 'smb', 'mdns'].indexOf(scheme) >= 0) {
    out.connection = 'network';
  } else if (scheme === 'serial') {
    out.connection = 'serial';
  } else if (scheme === 'cups-pdf' || scheme === 'file' || scheme === 'pdf') {
    out.virtual = true;
  }
  return out;
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; }
}

// Ties each CUPS queue to the USB device it drives: same device URI (macOS),
// or same serial number (Linux).
function linkQueuesToDevices(devices, queues) {
  for (const q of queues) {
    if (q.connection !== 'usb') continue;
    const dev = devices.find((d) => (d.uri && d.uri === q.uri) ||
      (q.serialNumber && d.serialNumber && d.serialNumber === q.serialNumber));
    if (!dev) continue;
    q.devicePrinterId = dev.id;
    (dev.queues = dev.queues || []).push(q.name);
  }
}

function printCups(queue, data, timeoutMs, jobName) {
  return new Promise((resolve, reject) => {
    if (!queue) return reject(new UsbError('notFound'));
    const env = Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' });
    let out = '';
    let errText = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    // `-o raw` hands the bytes to the printer untouched, so ESC/POS commands
    // (cut, cash drawer, raster images) arrive exactly as the app built them.
    let child;
    try {
      child = spawn('lp', ['-d', queue, '-o', 'raw', '-t', jobName], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish(new UsbError('unsupported', 'The system printing tools (CUPS "lp") are not available.', e.message));
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new UsbError('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errText = (errText + d).slice(-600); });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') finish(new UsbError('unsupported', 'The system printing tools (CUPS "lp") are not available.'));
      else finish(new UsbError('ioError', null, e.message));
    });
    child.on('close', (code) => {
      if (code === 0) {
        const m = /request id is (\S+)/.exec(out);
        return finish(null, { jobId: m ? m[1] : null });
      }
      const msg = errText.trim() || out.trim();
      // Linux CUPS: "The printer or class does not exist."; macOS: "No such file or directory".
      if (/does not exist|unknown destination|not found|no such file/i.test(msg)) return finish(new UsbError('notFound', 'This printer is no longer installed on the computer.', msg));
      if (/not accepting/i.test(msg)) return finish(new UsbError('busy', 'The printer is paused or not accepting jobs. Resume it in the system printer settings.', msg));
      finish(new UsbError('ioError', null, msg || `lp exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(data);
  });
}

// ─── macOS: USB printers through the system's own USB backend ────────────────
// macOS ships its USB printer support as the CUPS `usb` backend, a program any
// user may run (r-xr-xr-x). Run with no arguments it lists the connected USB
// printers with their IEEE 1284 ID; run with a device URI it sends a job
// straight to that printer. So a plugged-in receipt printer prints with no
// driver and without being added in System Settings, as on Windows and Linux.
// No native code in the bridge, and nothing new for macOS privacy prompts.

const MAC_USB_BACKEND = '/usr/libexec/cups/backend/usb';

async function listMacUsbDevices() {
  if (!fs.existsSync(MAC_USB_BACKEND)) return [];
  const [found, usbTree] = await Promise.all([runTool(MAC_USB_BACKEND, [], 15000), macUsbTree()]);
  const devices = [];
  // One line per printer: class uri "make-and-model" "info" "device-id" "location"
  for (const line of found.stdout.split('\n')) {
    const m = /^\S+\s+(usb:\/\/\S+)\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"/.exec(line.trim());
    if (!m) continue;
    const uri = m[1];
    const info = parse1284(m[4]);
    const fromUri = cupsUriInfo(uri);
    const serialNumber = fromUri.serialNumber || info.serialNumber || null;
    const hw = macUsbIds(usbTree, serialNumber, uri);
    devices.push({
      id: 'mac-usb:' + uri,
      kind: 'device',
      connection: 'usb',
      name: usbDisplayName(info, m[3] || m[2], hw.vendorId, hw.productId),
      manufacturer: info.manufacturer || fromUri.manufacturer,
      model: info.model || fromUri.model,
      commandSet: info.commandSet || null,
      vendorId: hw.vendorId,
      productId: hw.productId,
      serialNumber,
      uri,
    });
  }
  return devices;
}

// USB vendor/product ids, which the backend doesn't report, from the IORegistry:
// shown in the popup and used to find a printer again after a replug.
async function macUsbTree() {
  const r = await runTool('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w', '0'], 8000);
  const nodes = [];
  let node = null;
  for (const line of r.stdout.split('\n')) {
    if (line.indexOf('+-o ') >= 0) {
      node = {};
      nodes.push(node);
      continue;
    }
    const m = node && /"([^"]+)" = (.+)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (m[1] === 'idVendor') node.vendorId = Number(value);
    else if (m[1] === 'idProduct') node.productId = Number(value);
    else if (m[1] === 'USB Serial Number' || m[1] === 'kUSBSerialNumberString') node.serial = value;
    else if (m[1] === 'locationID') node.locationId = Number(value);
  }
  return nodes;
}

function macUsbIds(tree, serial, uri) {
  const loc = /[?&]location=([0-9a-f]+)/i.exec(uri);
  const location = loc ? parseInt(loc[1], 16) : null;
  const node = tree.find((n) => (serial && n.serial === serial) || (location != null && n.locationId === location));
  const ok = node && Number.isInteger(node.vendorId) && Number.isInteger(node.productId);
  return { vendorId: ok ? node.vendorId : null, productId: ok ? node.productId : null };
}

// Runs the backend the way the print system would: argv[0] (and DEVICE_URI) is
// the printer's URI, then job-id user title copies options, with the job on
// stdin. fds 3 and 4 are the back- and side-channels it expects; the
// back-channel is drained so a chatty printer can never stall it.
//
// Two backend habits are worked around, both measured on a POS-80:
//  * Once every byte is written it announces +cups-waiting-for-job-completed,
//    then waits ~7 s for a status reply most receipt printers never send (no
//    option turns this off). The printer already has the whole receipt, so the
//    job counts as done there and the backend is stopped.
//  * macOS needs ~0.6 s to release the printer after that. A backend that
//    finds it still held hangs ~5 s in its open call before it even says
//    "Waiting for printer to become available". A healthy open takes ~15 ms,
//    so a run that hasn't connected within the watchdog (400 ms, then 800 ms,
//    1.6 s; after that the backend's own waiting applies, for a printer that
//    is slow to wake) is stopped and retried. Retries only happen before any
//    byte was written, so a receipt is never printed twice. Back-to-back
//    receipts go out in about a second instead of five.
const MAC_RETRY_MS = 250;
const MAC_CONNECT_WATCHDOG_MS = [400, 800, 1600];

async function printMacUsb(uri, data, timeoutMs, jobName) {
  if (!/^usb:\/\//.test(uri)) {
    throw new UsbError('invalidRequest', 'Unknown printer id. List the printers again with USB_LIST and choose one.');
  }
  const deadline = Date.now() + timeoutMs;
  for (let n = 0; ; n++) {
    const attempt = await macUsbAttempt(uri, data, Math.max(1000, deadline - Date.now()), jobName, MAC_CONNECT_WATCHDOG_MS[n] || 0);
    if (attempt.sent) return { bytes: data.length };
    if (!attempt.retry) throw attempt.error;
    if (Date.now() + MAC_RETRY_MS >= deadline) {
      // Still not free after the whole timeout: unplugged, switched off, or
      // held by another program.
      throw new UsbError('notFound', null, attempt.detail);
    }
    await new Promise((r) => setTimeout(r, MAC_RETRY_MS));
  }
}

// One backend run. Resolves { sent } | { retry, detail } | { error }; never rejects.
function macUsbAttempt(uri, data, timeoutMs, jobName, connectWatchdogMs) {
  return new Promise((resolve) => {
    let errText = '';
    let done = false;
    let watchdog = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      resolve(result);
    };
    let user = 'localtcp';
    try { user = require('os').userInfo().username || user; } catch (_) {}
    const env = Object.assign({}, process.env, {
      DEVICE_URI: uri,
      PRINTER: 'LocalTCP',
      CONTENT_TYPE: 'application/vnd.cups-raw',
      FINAL_CONTENT_TYPE: 'application/vnd.cups-raw',
      LC_ALL: 'C',
      LANG: 'C',
    });
    let child;
    try {
      child = spawn(MAC_USB_BACKEND, ['1', user, jobName, '1', ''],
        { argv0: uri, env, stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ error: new UsbError('unsupported', 'The macOS USB printing tool could not be started.', e.message) });
    }
    const stop = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 500).unref();
    };
    if (connectWatchdogMs > 0) {
      watchdog = setTimeout(() => {
        if (/STATE: -connecting-to-device/.test(errText) || /Wrote \d+ bytes/.test(errText)) return;
        try { child.kill('SIGKILL'); } catch (_) {}
        finish({ retry: true, detail: 'The printer was still held by the previous job.' });
      }, connectWatchdogMs);
    }
    const timer = setTimeout(() => {
      stop();
      const wrote = /Wrote \d+ bytes/.test(errText);
      if (!wrote && /Waiting for printer/i.test(errText)) finish({ retry: true, detail: errText });
      else finish({ error: new UsbError('timeout', null, errText) });
    }, timeoutMs);

    child.stderr.on('data', (d) => {
      errText = (errText + d).slice(-3000);
      if (/STATE: \+cups-waiting-for-job-completed/.test(errText)) {
        finish({ sent: true });
        stop();
      } else if (/Waiting for printer to become available/.test(errText) && !/Wrote \d+ bytes/.test(errText)) {
        // Nothing written yet: safe to start over.
        try { child.kill('SIGKILL'); } catch (_) {}
        finish({ retry: true, detail: errText });
      }
    });
    if (child.stdio[3]) child.stdio[3].on('data', () => {});
    if (child.stdio[4]) child.stdio[4].on('error', () => {});
    child.on('error', (e) => finish({ error: new UsbError('unsupported', 'The macOS USB printing tool could not be started.', e.message) }));
    child.on('close', (code) => {
      if (code === 0) return finish({ sent: true });
      const lines = errText.split('\n').filter((l) => /^(ERROR|ALERT|CRIT|EMERG):/.test(l));
      const detail = (lines.join(' ') || errText).trim() || `the USB backend exited with code ${code}`;
      if (/not found|no such|unable to (open|locate)/i.test(detail)) return finish({ error: new UsbError('notFound', null, detail) });
      if (/busy|in use|exclusive/i.test(detail)) return finish({ error: new UsbError('busy', null, detail) });
      finish({ error: new UsbError('ioError', null, detail) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(data);
  });
}

// ─── Windows: usbprint.sys devices + spooler queues ──────────────────────────
// Node has no way to call SetupAPI, CreateFile on a device interface, or the
// spooler without a native addon. usb_windows.ps1 compiles a small C# class
// once (cached as a DLL next to it) and serves line-based requests; it is
// started on the first USB request and stays up while the browser holds this
// host, so later prints don't pay its start-up time.

const WIN_HELPER_SCRIPT = path.join(__dirname, 'usb_windows.ps1');
const WIN_HELPER_READY_MS = 45000; // first run compiles the C# (csc.exe); AV scans can slow it
const WIN_LIST_TIMEOUT_MS = 20000;

let winHelper = null;

function getWinHelper() {
  if (!winHelper) winHelper = new WindowsUsbHelper(WIN_HELPER_SCRIPT);
  return winHelper;
}

class WindowsUsbHelper {
  constructor(script) {
    this.script = script;
    this.proc = null;
    this.ready = null;      // Promise resolved once the helper said {"ready":true}
    this.pending = new Map();
    this.seq = 0;
  }

  start() {
    if (this.ready) return this.ready;
    const promise = new Promise((resolve, reject) => {
      if (!fs.existsSync(this.script)) return reject(new UsbError('helperMissing'));
      const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      let proc;
      try {
        proc = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(new UsbError('helperFailed', null, e.message));
      }
      this.proc = proc;
      let isReady = false;
      let lineBuf = '';
      let errTail = '';
      const readyTimer = setTimeout(() => {
        fail(new UsbError('helperFailed', 'The Local TCP USB helper took too long to start.', errTail));
      }, WIN_HELPER_READY_MS);
      const fail = (err) => {
        clearTimeout(readyTimer);
        if (!isReady) reject(err);
        if (this.proc === proc) this.teardown(err); // a replaced helper is already gone
      };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        lineBuf += chunk;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line || line[0] !== '{') continue; // ignore anything PowerShell itself prints
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          if (!isReady) {
            if (msg.ready) { isReady = true; clearTimeout(readyTimer); resolve(); }
            else if (msg.fatal) fail(helperStartError(msg.error));
            continue;
          }
          const p = this.pending.get(String(msg.id));
          if (!p) continue;
          this.pending.delete(String(msg.id));
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
      proc.on('error', (e) => fail(new UsbError('helperFailed', 'Could not start Windows PowerShell.', e.message)));
      proc.on('exit', (code) => fail(new UsbError('helperFailed', `The Local TCP USB helper stopped unexpectedly (exit code ${code}).`, errTail)));
      proc.stdin.on('error', () => {});
    });
    this.ready = promise;
    // A failed start is not cached: the next request tries again.
    promise.catch(() => { if (this.ready === promise) this.ready = null; });
    return promise;
  }

  async request(cmd, args, timeoutMs) {
    await this.start();
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new UsbError('helperFailed', 'The Local TCP USB helper stopped unexpectedly.'));
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A write the driver won't cancel can wedge the helper. Start a fresh
        // one for the next request rather than queueing behind it.
        this.teardown(new UsbError('helperFailed', 'The Local TCP USB helper was restarted.'));
        reject(new UsbError('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write([id, cmd].concat(args).join('\t') + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new UsbError('helperFailed', null, e.message));
      }
    });
  }

  teardown(err) {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (proc) { try { proc.kill(); } catch (_) {} }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err || new UsbError('helperFailed'));
    }
    this.pending.clear();
  }

  stop() {
    this.teardown(null);
  }
}

function helperStartError(raw) {
  const text = String(raw || '');
  if (/language mode/i.test(text)) {
    return new UsbError('helperFailed',
      'Windows blocked the Local TCP USB helper (PowerShell Constrained Language Mode, usually set by company policy). Ask your IT administrator to allow it, or print to an installed Windows printer from another app.',
      text);
  }
  return new UsbError('helperFailed', null, text);
}

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// Turns a helper error reply into a UsbError, keeping the raw Win32 text as detail.
function helperError(r) {
  const code = USB_MESSAGES[r.code] ? r.code : 'ioError';
  const detail = r.error ? r.error + (r.win32 ? ` (Win32 error ${r.win32})` : '') : null;
  return new UsbError(code, null, detail);
}

const WIN_VIRTUAL_PORTS = /^(PORTPROMPT:|FILE:|NUL:?|SHRFAX:|XPSPORT:)$/i;
const WIN_VIRTUAL_DRIVERS = /Print To PDF|XPS Document Writer|Shared Fax|OneNote/i;

async function listWindowsPrinters(opts) {
  const r = await getWinHelper().request('LIST', [], WIN_LIST_TIMEOUT_MS);
  if (!r.ok) throw helperError(r);
  const queues = Array.isArray(r.queues) ? r.queues : [];
  const notes = [];
  if (r.queueError) {
    notes.push({ code: 'queuesUnavailable', level: 'warn', message: 'Installed Windows printers could not be listed (is the Print Spooler service running?).' });
  }

  const printers = [];
  for (const d of Array.isArray(r.devices) ? r.devices : []) {
    const ids = windowsUsbIds(d.instanceId || d.path);
    const info = parse1284(d.ieee1284);
    const queueNames = d.port ? queues.filter((q) => sameText(q.port, d.port)).map((q) => q.name) : [];
    printers.push({
      id: 'win-usb:' + d.path,
      kind: 'device',
      connection: 'usb',
      name: usbDisplayName(info, d.busName, ids.vendorId, ids.productId),
      manufacturer: info.manufacturer || null,
      model: info.model || d.busName || null,
      commandSet: info.commandSet || null,
      vendorId: ids.vendorId,
      productId: ids.productId,
      serialNumber: ids.serialNumber || info.serialNumber || null,
      port: d.port || null,
      queues: queueNames,
      busy: !!d.busy,
    });
  }

  for (const q of queues) {
    const virtual = WIN_VIRTUAL_PORTS.test(q.port || '') || WIN_VIRTUAL_DRIVERS.test(q.driver || '');
    if (virtual && !opts.includeVirtual) continue;
    const device = q.port ? printers.find((p) => p.kind === 'device' && sameText(p.port, q.port)) : null;
    printers.push({
      id: 'win-queue:' + q.name,
      kind: 'queue',
      connection: windowsPortConnection(q.port),
      name: q.name,
      driver: q.driver || null,
      port: q.port || null,
      status: windowsQueueStatus(q.status, q.attributes),
      isDefault: sameText(q.name, r.defaultQueue),
      devicePrinterId: device ? device.id : null,
    });
  }
  return { printers: classifyPrinters(printers), notes };
}

function sameText(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// USB\VID_0416&PID_5011\<instance>: the instance is the device's serial number
// when it has one (no '&'), otherwise a Windows-made, port-based id.
function windowsUsbIds(s) {
  const out = { vendorId: null, productId: null, serialNumber: null };
  const text = String(s || '');
  const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(text);
  if (m) {
    out.vendorId = parseInt(m[1], 16);
    out.productId = parseInt(m[2], 16);
  }
  const parts = text.split(/[\\#]/);
  const vidIdx = parts.findIndex((p) => /VID_[0-9A-F]{4}&PID_[0-9A-F]{4}/i.test(p));
  const inst = vidIdx >= 0 ? parts[vidIdx + 1] : null;
  if (inst && inst.indexOf('&') < 0 && !/MI_\d+/i.test(parts[vidIdx])) out.serialNumber = inst;
  return out;
}

function windowsPortConnection(port) {
  const p = String(port || '');
  if (/^USB\d+$/i.test(p)) return 'usb';
  if (/^(IP_)?\d{1,3}(\.\d{1,3}){3}/.test(p) || /^WSD-/i.test(p) || /^https?:/i.test(p)) return 'network';
  if (/^(COM|LPT)\d+:?$/i.test(p)) return 'serial';
  return 'other';
}

// PRINTER_INFO_2 Status / Attributes bits.
function windowsQueueStatus(status, attributes) {
  const s = Number(status) || 0;
  const a = Number(attributes) || 0;
  if ((a & 0x400) || (s & 0x80)) return 'offline';  // WORK_OFFLINE / STATUS_OFFLINE
  if (s & 0x10) return 'paperOut';
  if (s & 0x1) return 'paused';
  if (s & 0x2) return 'error';
  if (s & 0x400) return 'printing';
  return 'ready';
}

async function writeWindowsDevice(devicePath, data, timeoutMs) {
  // The helper bounds each chunk by timeoutMs; allow it a little longer before
  // deciding the helper itself is stuck.
  const r = await getWinHelper().request('WRITE_DEVICE', [b64(devicePath), String(timeoutMs), data.toString('base64')], timeoutMs + 10000);
  if (!r.ok) throw helperError(r);
  return { bytes: r.bytes };
}

async function writeWindowsQueue(name, data, timeoutMs, jobName) {
  const r = await getWinHelper().request('WRITE_QUEUE', [b64(name), b64(jobName), data.toString('base64')], timeoutMs + 10000);
  if (!r.ok) throw helperError(r);
  return { bytes: r.bytes, jobId: r.jobId ? String(r.jobId) : null };
}

// ─── Entry point ─────────────────────────────────────────────────────────────
if (process.argv[2] === LP_WRITER_FLAG) {
  runLpWriter(process.argv[3]);
} else {
  startNativeMessaging();
}
