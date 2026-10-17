// Local TCP - background.js
// Bridges web app messages to the Native Messaging Host for raw TCP and USB printing.
//
// Design:
//  - Request/response correlation via `reqId` (safe under concurrent print jobs)
//  - Origin allowlist: only approved web origins may use the bridge
//  - Per-request timeout so callers never hang forever
//  - Single persistent native port with one dispatcher listener
//
// MV3 lifecycle note: this service worker can be terminated when idle, which
// kills `nativePort` and ends the native host process (and therefore its TCP
// connection pool). Callers must NOT assume a prior CONNECT survives — it is
// best-effort. PRINT/SEND are self-healing: the native host re-dials the socket
// if no live connection exists, so they always work standalone after a restart.

const HOST_NAME = 'com.algoramming.localtcp';
// 30s gives the bridge enough time to wake a deep-sleeping Wi-Fi printer via the
// connect-retry loop in host/index.js; it must stay above that loop's ~25s retry
// budget so the bridge's real error surfaces before this timeout fires.
const REQUEST_TIMEOUT_MS = 30000;

// USB requests can wait on more than the printer: on Windows the host starts a
// PowerShell helper on first use (compiling it the very first time, up to
// ~45s). These budgets sit above the host's own limits for the same reason as
// above: the host's specific error should reach the page, not this timeout.
const USB_LIST_TIMEOUT_MS = 75000;
const USB_PRINT_DEFAULT_MS = 20000;   // the host's default write timeout
const USB_PRINT_MAX_MS = 120000;      // the host's upper bound
const USB_STARTUP_ALLOWANCE_MS = 60000;

let nativePort = null;
let reqCounter = 0;
const pending = new Map(); // reqId -> { resolve, timer }

// ─── Native Port Management ──────────────────────────────────────────────────

function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      if (msg && msg.reqId && pending.has(msg.reqId)) {
        const { resolve, timer } = pending.get(msg.reqId);
        clearTimeout(timer);
        pending.delete(msg.reqId);
        resolve(msg);
      } else if (msg && msg.error) {
        console.error('Bridge Error (uncorrelated):', msg.error);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'Native host disconnected';
      console.error('Native Host disconnected:', err);
      nativePort = null;
      // Fail every in-flight request instead of leaving callers hanging
      for (const [id, { resolve, timer }] of pending) {
        clearTimeout(timer);
        resolve({ success: false, error: 'Bridge disconnected: ' + err });
      }
      pending.clear();
    });
  } catch (e) {
    console.error('Failed to connect to native host:', e);
    nativePort = null;
  }
  return nativePort;
}

function sendToHost(message, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const p = getNativePort();
    if (!p) {
      return resolve({ success: false, error: 'Bridge not available. Please install the native host.' });
    }
    const reqId = `req_${Date.now()}_${++reqCounter}`;
    const timer = setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        resolve({ success: false, error: 'Bridge timeout: no response within ' + timeoutMs + 'ms' });
      }
    }, timeoutMs);

    pending.set(reqId, { resolve, timer });

    try {
      p.postMessage({ ...message, reqId });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve({ success: false, error: 'Bridge communication failure: ' + err.message });
    }
  });
}

// ─── Origin Allowlist ────────────────────────────────────────────────────────
// Stored in chrome.storage.local as `allowedOrigins`: array of origin strings,
// e.g. ["https://app.algoramming.com", "http://localhost:3000"].
// An EMPTY list means "allow all" (backward compatible). Configure it from the
// extension popup to lock the bridge down to your own apps.

async function isOriginAllowed(sender) {
  // Messages from the extension's own pages (popup AND the setup tab) are always
  // allowed. We identify them by the chrome-extension://<our id> origin/url —
  // NOT by `!sender.tab`, because our setup page runs as a full tab (sender.tab
  // is set there) yet must still pass even when a strict allowlist is configured.
  const selfOrigin = `chrome-extension://${chrome.runtime.id}`;
  if (sender.id === chrome.runtime.id &&
      (sender.origin === selfOrigin || sender.url?.startsWith(selfOrigin + '/'))) {
    return true;
  }
  const { allowedOrigins } = await chrome.storage.local.get(['allowedOrigins']);
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return true; // open mode
  }
  let origin = sender.origin;
  if (!origin && sender.url) {
    try { origin = new URL(sender.url).origin; } catch (_) { /* ignore */ }
  }
  return !!origin && allowedOrigins.includes(origin);
}

// ─── Shared Message Handler ──────────────────────────────────────────────────

async function handleMessage(request, sender) {
  // 1. Unwrap the 'LOCAL_TCP_PRINT' wrapper used by external apps & the test button
  if (request.type === 'LOCAL_TCP_PRINT' && request.payload) {
    request = {
      action: 'PRINT',
      ...request.payload,
      data: request.payload.bytes // map 'bytes' -> 'data' expected by the host
    };
  }

  let { action, host, port, data, connectionId, readTimeoutMs } = request;

  // 2. Internal action: bridge health check. `features` tells callers what the
  //    installed host can do (a host without 'usb' predates USB printing).
  if (action === 'CHECK_BRIDGE') {
    const res = await sendToHost({ action: 'PING' });
    return {
      success: !!res.success,
      connected: !!res.success,
      version: res.version,
      extensionVersion: chrome.runtime.getManifest().version,
      features: Array.isArray(res.features) ? res.features : (res.success ? ['tcp'] : []),
      platform: res.platform,
      usb: res.usb,
      error: res.error
    };
  }

  // 3. Security gate for everything that touches hardware
  if (!(await isOriginAllowed(sender))) {
    console.warn('Blocked request from unauthorized origin:', sender.origin || sender.url);
    return { success: false, error: 'Origin not allowed. Add this origin in the Local TCP extension settings.' };
  }

  // 4. USB printers are addressed by printer id, never by host/port.
  if (action === 'USB_LIST' || action === 'USB_PRINT') {
    return handleUsb(request);
  }

  // 5. Resolve host/port. Explicit values from the request win for THIS request;
  //    otherwise fall back to the user's saved defaults. We do NOT persist values
  //    coming from web requests — defaults are only set from the popup's Save
  //    button, so one web app can't silently overwrite another's configuration.
  if (!host || !port) {
    const stored = await chrome.storage.local.get(['printerHost', 'printerPort']);
    host = host || stored.printerHost;
    port = port || stored.printerPort;
  }

  if (['CONNECT', 'PRINT', 'SEND', 'DISCONNECT'].includes(action)) {
    if (!host || !port) {
      return { success: false, error: 'Host/Port not configured.' };
    }
  }

  // 6. Relay to native host (correlated + timeout-protected)
  return sendToHost({
    action,
    host,
    port: parseInt(port),
    data,
    connectionId: connectionId || `${host}:${port}`,
    ...(readTimeoutMs ? { readTimeoutMs } : {})
  });
}

// ─── USB ─────────────────────────────────────────────────────────────────────
// USB_LIST                      → { success, platform, printers: [...], notes: [...] }
// USB_PRINT { printerId?, match?, dataB64 | data, timeoutMs?, jobName? }
//                               → { success, printerId, resolvedPrinterId?, bytesSent }
// Failures carry a stable `code` (notFound, busy, permissionDenied, timeout,
// ioError, ..., plus bridgeOutdated / noPrinter from here) next to `error`.

async function handleUsb(request) {
  if (request.action === 'USB_LIST') {
    return relayUsb({ action: 'USB_LIST', includeVirtual: !!request.includeVirtual }, USB_LIST_TIMEOUT_MS);
  }

  // USB_PRINT. With no printerId, fall back to the default USB printer chosen in
  // the popup — the same convenience the TCP actions get from the saved IP/port.
  let printerId = typeof request.printerId === 'string' ? request.printerId : '';
  let match = sanitizeMatch(request.match);
  if (!printerId) {
    const { usbDefaultPrinter } = await chrome.storage.local.get(['usbDefaultPrinter']);
    if (usbDefaultPrinter && usbDefaultPrinter.id) {
      printerId = usbDefaultPrinter.id;
      match = match || sanitizeMatch(usbDefaultPrinter.match);
    }
  }
  if (!printerId) {
    return {
      success: false,
      code: 'noPrinter',
      error: 'No USB printer chosen. Pass a printerId from USB_LIST, or pick a default USB printer in the Local TCP popup.'
    };
  }

  const msg = { action: 'USB_PRINT', printerId };
  if (match) msg.match = match;
  if (typeof request.dataB64 === 'string') msg.dataB64 = request.dataB64;
  else if (Array.isArray(request.data)) msg.data = request.data;
  if (request.timeoutMs) msg.timeoutMs = Number(request.timeoutMs);
  if (typeof request.jobName === 'string') msg.jobName = request.jobName.slice(0, 100);

  const writeBudget = Math.min(USB_PRINT_MAX_MS, Math.max(0, Number(request.timeoutMs) || USB_PRINT_DEFAULT_MS));
  return relayUsb(msg, writeBudget + USB_STARTUP_ALLOWANCE_MS);
}

function sanitizeMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const vendorId = Number(m.vendorId);
  const productId = Number(m.productId);
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null;
  const out = { vendorId, productId };
  if (typeof m.serialNumber === 'string' && m.serialNumber) out.serialNumber = m.serialNumber;
  return out;
}

async function relayUsb(msg, timeoutMs) {
  const res = await sendToHost(msg, timeoutMs);
  // A host installed before USB support answers "Unknown action: USB_…".
  if (res && !res.success && typeof res.error === 'string' && res.error.startsWith('Unknown action')) {
    return {
      success: false,
      code: 'bridgeOutdated',
      error: 'USB printing needs a newer Local TCP bridge. Open the extension popup, click Download Setup Kit and run the installer again.'
    };
  }
  return res;
}

// ─── Listeners ───────────────────────────────────────────────────────────────

const messageListener = (request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message || 'Internal logic error' }));
  return true; // keep the channel open for the async response
};

// Web apps reach the bridge through content.js (window.postMessage -> internal
// sendMessage), and the popup uses the same internal channel. We intentionally do
// NOT register onMessageExternal: the manifest declares no `externally_connectable`
// (the bridge must serve arbitrary customer origins, which can't be wildcarded
// there), so an external listener would be unreachable dead code.
chrome.runtime.onMessage.addListener(messageListener);

// ─── First-run setup ─────────────────────────────────────────────────────────
// The browser can't open TCP sockets on its own, so the native host still has to
// be installed once. To make that feel like a single step, the moment the
// extension is installed we open the setup page in a full tab and have it auto-
// start the OS-matched installer download (see popup.js `?setup=1`). The popup
// then auto-polls and flips to "Bridge Linked" as soon as the host registers —
// no Chrome restart, no hunting for buttons.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?setup=1') });
  }
});
