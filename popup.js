// Local TCP - popup.js
// Handles configuration, UI states, bridge status, USB printers, and the security
// allowlist. The Setup Kit button downloads a one-click installer from GitHub Releases.

const RELEASE_BASE = 'https://github.com/algoramming/local_tcp/releases/latest/download/';
// Full single-page documentation (features, architecture, protocol, install/uninstall guides).
// index.html is bundled INSIDE the extension, so it opens from the extension's own
// origin (chrome-extension://<id>/index.html) — offline, no CDN, always version-matched.
const DOCS_URL = chrome.runtime.getURL('index.html');
const INSTALLER_ASSETS = {
  win: 'localtcp-windows-installer.exe',
  mac: 'localtcp-mac-installer.pkg',
  linux: 'localtcp-linux-installer.run'
};

// Detect the user's OS so we hand them the right one-click installer.
function detectOs() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (platform.includes('win')) return 'win';
  if (platform.includes('linux')) return 'linux';
  return 'mac';
}

// One-click uninstaller, mirroring the Setup Kit: each OS gets a downloadable
// package that removes the bridge when run (pkg/exe/run).
const UNINSTALLER_ASSETS = {
  win: 'localtcp-windows-uninstaller.exe',
  mac: 'localtcp-mac-uninstaller.pkg',
  linux: 'localtcp-linux-uninstaller.run'
};

// Static icon markup for rows built in JS (never mixed with printer data).
const ICONS = {
  printer: '<polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect>',
  usb: '<circle cx="10" cy="7" r="1"></circle><circle cx="4" cy="20" r="1"></circle><path d="M4.7 19.3 19 5"></path><path d="m21 3-3 1 2 2Z"></path><path d="M9.26 7.68 5 12l2 5"></path><path d="m10 14 5 2 3.5-3.5"></path><path d="m18 12 1-1 1 1-1 1Z"></path>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
  info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
  warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
  error: '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>'
};

function icon(name, extraClass) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'spinner' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (extraClass) svg.setAttribute('class', extraClass);
  svg.innerHTML = ICONS[name];
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// chrome.runtime.sendMessage as a promise that always resolves to an object.
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { success: false, error: 'No response from the extension.' });
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const setupState = document.getElementById('setupState');
  const dashboardState = document.getElementById('dashboardState');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Show the extension version from the manifest in the header.
  const appVersionEl = document.getElementById('appVersion');
  if (appVersionEl) {
    appVersionEl.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  const hostInput = document.getElementById('hostInput');
  const portInput = document.getElementById('portInput');
  const originsInput = document.getElementById('originsInput');

  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const saveOriginsBtn = document.getElementById('saveOriginsBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const uninstallBtn = document.getElementById('uninstallBtn');
  const resetConfigBtn = document.getElementById('resetConfigBtn');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const logBox = document.getElementById('logBox');
  const docsBtn = document.getElementById('docsBtn');

  // Last CHECK_BRIDGE reply: version, features, platform.
  let bridge = null;

  // 1. Check Bridge Status
  async function checkBridge() {
    statusText.textContent = 'Checking...';
    statusDot.className = 'dot';

    const res = await sendMessage({ action: 'CHECK_BRIDGE' });
    if (res && res.connected) {
      bridge = res;
      statusText.textContent = res.version ? `Bridge v${res.version}` : 'Bridge Linked';
      statusDot.className = 'dot active';
      setupState.classList.remove('active');
      dashboardState.classList.add('active');
      return true;
    }
    bridge = null;
    statusText.textContent = 'Setup Required';
    statusDot.className = 'dot error';
    setupState.classList.add('active');
    dashboardState.classList.remove('active');
    return false;
  }

  // 2. Load settings
  async function loadSettings() {
    const stored = await chrome.storage.local.get(['printerHost', 'printerPort', 'allowedOrigins', 'usbDefaultPrinter']);
    if (stored.printerHost) hostInput.value = stored.printerHost;
    if (stored.printerPort) portInput.value = stored.printerPort;
    if (originsInput && Array.isArray(stored.allowedOrigins)) {
      originsInput.value = stored.allowedOrigins.join('\n');
    }
    usb.defaultPrinter = stored.usbDefaultPrinter && stored.usbDefaultPrinter.id ? stored.usbDefaultPrinter : null;
  }

  // 3. Logging Helper (text only: messages can contain printer names)
  function addLog(msg, type = 'info') {
    const entry = el('div', 'log-entry');
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.append(el('span', 'log-time', `[${time}]`), ' ', el('span', `log-msg ${type}`, msg));
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;

    logBox.classList.add('active');
    setTimeout(() => logBox.classList.remove('active'), 500);
  }

  // Shared installer download (used by the button and by first-run auto-setup)
  function downloadInstaller() {
    const os = detectOs();
    const asset = INSTALLER_ASSETS[os];
    addLog(`Downloading ${asset}...`, 'info');
    chrome.tabs.create({ url: RELEASE_BASE + asset });
  }

  // OS-matched one-click uninstaller download.
  function downloadUninstaller() {
    const os = detectOs();
    const asset = UNINSTALLER_ASSETS[os];
    addLog(`Downloading ${asset}...`, 'info');
    chrome.tabs.create({ url: RELEASE_BASE + asset });
  }

  // ─── Network | USB tabs ──────────────────────────────────────────────────────
  const segButtons = document.querySelectorAll('.seg-btn');
  const panes = document.querySelectorAll('.pane');

  function showPane(name) {
    segButtons.forEach((b) => {
      const on = b.dataset.pane === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panes.forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    chrome.storage.local.set({ popupPane: name });
    if (name === 'usb' && !usb.loaded && !usb.loading) loadUsbPrinters();
  }
  segButtons.forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));

  // ─── USB printers ────────────────────────────────────────────────────────────
  const usbNotices = document.getElementById('usbNotices');
  const usbLoadingEl = document.getElementById('usbLoading');
  const usbListEl = document.getElementById('usbList');
  const usbEmpty = document.getElementById('usbEmpty');
  const usbEmptyHint = document.getElementById('usbEmptyHint');
  const usbFoot = document.getElementById('usbFoot');
  const usbCount = document.getElementById('usbCount');
  const usbRefreshBtn = document.getElementById('usbRefreshBtn');

  const usb = {
    loaded: false,
    loading: false,
    printers: [],
    notes: [],
    platform: null,
    error: null,
    showNetwork: false,
    defaultPrinter: null,
    results: {} // printer id -> { type, text } from the last test print
  };

  function bridgeSupportsUsb() {
    return !!(bridge && Array.isArray(bridge.features) && bridge.features.includes('usb'));
  }

  async function loadUsbPrinters({ quiet = false } = {}) {
    if (!bridgeSupportsUsb()) {
      usb.loaded = true;
      renderUsb();
      return;
    }
    usb.loading = true;
    renderUsb();
    const res = await sendMessage({ action: 'USB_LIST' });
    usb.loading = false;
    usb.loaded = true;
    if (res.success) {
      usb.printers = Array.isArray(res.printers) ? res.printers : [];
      usb.notes = Array.isArray(res.notes) ? res.notes : [];
      usb.platform = res.platform || detectOs();
      usb.error = null;
      if (!quiet) {
        const n = visiblePrinters().length;
        addLog(n ? `Found ${n} USB printer${n === 1 ? '' : 's'}.` : 'No USB printers found.', n ? 'success' : 'info');
      }
    } else {
      usb.printers = [];
      usb.notes = [];
      usb.error = res;
      addLog(`USB: ${res.error || 'Could not list printers.'}`, 'error');
    }
    renderUsb();
  }

  // Network queues belong to the Network tab; they stay folded away here.
  function isNetworkQueue(p) {
    return p.kind === 'queue' && p.connection === 'network';
  }
  function visiblePrinters() {
    return usb.printers.filter((p) => !isNetworkQueue(p));
  }

  function matchOf(p) {
    if (p.kind !== 'device' || p.vendorId == null || p.productId == null) return null;
    const m = { vendorId: p.vendorId, productId: p.productId };
    if (p.serialNumber) m.serialNumber = p.serialNumber;
    return m;
  }

  function hex4(n) {
    return ('0000' + Number(n).toString(16)).slice(-4);
  }

  // Detail lines under the printer name: [text, optional trailing id kept on one line].
  function describe(p) {
    const lines = [];
    if (p.kind === 'device') {
      const id = p.vendorId != null && p.productId != null ? `${hex4(p.vendorId)}:${hex4(p.productId)}` : null;
      lines.push(['Direct USB · no driver needed', id]);
      if (Array.isArray(p.queues) && p.queues.length) {
        lines.push([`Also installed as: ${p.queues.join(', ')}`, null]);
      }
    } else {
      const where = usb.platform === 'win' ? 'Windows printer' : 'System printer';
      const via = { usb: 'USB', network: 'network', serial: 'serial port' }[p.connection];
      const port = p.port && usb.platform === 'win' ? `(${p.port})` : null;
      lines.push([via ? `${where} · ${via}` : where, port]);
    }
    return lines;
  }

  function statusChip(p) {
    if (p.accessible === false) return { cls: 'chip-warn', text: 'Needs permission' };
    if (p.busy) return { cls: 'chip-warn', text: 'In use' };
    switch (p.status) {
      case 'offline': return { cls: 'chip-error', text: 'Offline' };
      case 'paperOut': return { cls: 'chip-error', text: 'Out of paper' };
      case 'paused': return { cls: 'chip-warn', text: 'Paused' };
      case 'error': return { cls: 'chip-error', text: 'Error' };
      default: return null;
    }
  }

  function addNotice(level, body, options = {}) {
    const box = el('div', `notice ${level}`);
    box.appendChild(icon(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'));
    const content = el('div', 'notice-body');
    if (options.title) {
      content.appendChild(el('b', null, options.title));
      content.appendChild(document.createTextNode(' '));
    }
    content.appendChild(document.createTextNode(body));
    if (options.command) {
      const cmd = el('div', 'cmd');
      cmd.appendChild(el('code', null, options.command));
      const copy = el('button', 'mini-btn ghost', 'Copy');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(options.command);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        } catch (_) {
          addLog('Could not copy — select the command and copy it by hand.', 'error');
        }
      });
      cmd.appendChild(copy);
      content.appendChild(cmd);
    }
    if (options.action) {
      const btn = el('button', 'mini-btn');
      if (options.action.icon) btn.appendChild(icon(options.action.icon));
      btn.appendChild(document.createTextNode(options.action.label));
      btn.addEventListener('click', options.action.onClick);
      content.appendChild(btn);
    }
    box.appendChild(content);
    usbNotices.appendChild(box);
  }

  function renderNotes() {
    for (const note of usb.notes) {
      const level = note.level === 'warn' ? 'warn' : note.level === 'error' ? 'error' : 'info';
      const opts = {};
      if (note.code === 'permissionDenied' && usb.platform === 'linux') opts.command = 'sudo usermod -aG lp $USER';
      if (note.code === 'usblpMissing') opts.command = 'sudo modprobe usblp';
      addNotice(level, note.message, opts);
    }
  }

  function renderError(res) {
    const code = res.code;
    if (code === 'bridgeOutdated') {
      addNotice('warn', res.error, {
        title: 'Update needed.',
        action: { label: 'Download update', icon: 'download', onClick: downloadInstaller }
      });
      return;
    }
    // Only a missing file is fixed by reinstalling; a blocked or slow helper isn't.
    const hint = code === 'helperMissing'
      ? { label: 'Reinstall the bridge', icon: 'download', onClick: downloadInstaller }
      : { label: 'Try again', onClick: () => loadUsbPrinters() };
    addNotice('error', res.error || 'Could not list USB printers.', { action: hint });
    if (res.detail) addLog(`USB details: ${res.detail}`, 'error');
  }

  function buildRow(p) {
    const isDefault = !!(usb.defaultPrinter && usb.defaultPrinter.id === p.id);
    const row = el('div', 'usb-row' + (isDefault ? ' is-default' : ''));
    const top = el('div', 'usb-top');

    const ico = el('div', 'usb-ico');
    ico.appendChild(icon(p.kind === 'device' ? 'usb' : 'printer'));
    top.appendChild(ico);

    const main = el('div', 'usb-main');
    const name = el('div', 'usb-name', p.name || 'USB printer');
    if (isDefault) name.appendChild(el('span', 'chip chip-default', 'Default'));
    if (p.isDefault && p.kind === 'queue') name.appendChild(el('span', 'chip chip-default', 'System default'));
    const chip = statusChip(p);
    if (chip) name.appendChild(el('span', `chip ${chip.cls}`, chip.text));
    main.appendChild(name);
    for (const [text, tail] of describe(p)) {
      const meta = el('div', 'usb-meta', text);
      if (tail) {
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(el('span', 'usb-id', tail));
      }
      main.appendChild(meta);
    }
    top.appendChild(main);
    row.appendChild(top);

    const actions = el('div', 'usb-actions');
    const testBtnRow = el('button', 'mini-btn');
    testBtnRow.appendChild(icon('spinner', 'spinner'));
    testBtnRow.appendChild(icon('printer'));
    testBtnRow.appendChild(el('span', null, 'Test print'));
    testBtnRow.disabled = p.accessible === false;
    testBtnRow.title = p.accessible === false ? 'Allow USB printer access first (see the note above).' : 'Print a short test receipt';
    testBtnRow.addEventListener('click', () => testUsbPrint(p, testBtnRow));
    actions.appendChild(testBtnRow);

    const defBtn = el('button', 'mini-btn ghost');
    defBtn.appendChild(icon('star'));
    defBtn.appendChild(el('span', null, isDefault ? 'Remove default' : 'Set as default'));
    defBtn.title = 'Web apps that print without naming a USB printer use the default one.';
    defBtn.addEventListener('click', () => toggleDefault(p));
    actions.appendChild(defBtn);
    row.appendChild(actions);

    const result = usb.results[p.id];
    if (result) row.appendChild(el('div', `usb-result ${result.type}`, result.text));

    return row;
  }

  function emptyHint() {
    switch (usb.platform || detectOs()) {
      case 'win':
        return 'Connect the printer with USB, switch it on and press Refresh. Most receipt printers work without installing a driver.';
      case 'mac':
        return 'Add the printer in System Settings → Printers & Scanners, then press Refresh.';
      default:
        return 'Connect the printer with USB, switch it on and press Refresh.';
    }
  }

  function renderUsb() {
    usbNotices.replaceChildren();
    usbListEl.replaceChildren();
    usbEmpty.hidden = true;
    usbFoot.hidden = true;
    usbLoadingEl.hidden = !usb.loading;
    usbRefreshBtn.disabled = usb.loading;
    usbRefreshBtn.classList.toggle('spinning', usb.loading);

    if (bridge && !bridgeSupportsUsb()) {
      usbRefreshBtn.disabled = true;
      usbCount.hidden = true;
      renderError({
        code: 'bridgeOutdated',
        error: `The installed bridge${bridge.version ? ` (v${bridge.version})` : ''} can't print to USB printers yet. Download the latest Setup Kit and run it; your settings are kept.`
      });
      return;
    }
    if (usb.loading) return;
    if (usb.error) {
      usbCount.hidden = true;
      renderError(usb.error);
      return;
    }

    renderNotes();

    const visible = visiblePrinters();
    const devices = visible.filter((p) => p.kind === 'device');
    const queues = visible.filter((p) => p.kind === 'queue');
    const networkQueues = usb.printers.filter(isNetworkQueue);

    usbCount.textContent = String(visible.length);
    usbCount.hidden = !usb.loaded || visible.length === 0;

    if (devices.length) {
      if (queues.length) usbListEl.appendChild(el('div', 'usb-group', 'Connected by USB'));
      devices.forEach((p) => usbListEl.appendChild(buildRow(p)));
    }
    if (queues.length) {
      usbListEl.appendChild(el('div', 'usb-group', usb.platform === 'win' ? 'Installed Windows printers' : 'Installed printers'));
      queues.forEach((p) => usbListEl.appendChild(buildRow(p)));
    }
    if (networkQueues.length) {
      const toggle = el('button', 'link-btn', usb.showNetwork
        ? 'Hide network printers'
        : `Show ${networkQueues.length} network printer${networkQueues.length === 1 ? '' : 's'}`);
      toggle.addEventListener('click', () => { usb.showNetwork = !usb.showNetwork; renderUsb(); });
      usbListEl.appendChild(toggle);
      if (usb.showNetwork) networkQueues.forEach((p) => usbListEl.appendChild(buildRow(p)));
    }

    if (usb.loaded && !visible.length) {
      usbEmptyHint.textContent = emptyHint();
      usbEmpty.hidden = false;
    }

    const def = usb.defaultPrinter;
    if (usb.loaded && def && !usb.printers.some((p) => p.id === def.id)) {
      usbFoot.textContent = `Your default USB printer “${def.name || 'USB printer'}” isn't connected right now.`;
      usbFoot.hidden = false;
    }
  }

  async function toggleDefault(p) {
    if (usb.defaultPrinter && usb.defaultPrinter.id === p.id) {
      await chrome.storage.local.remove('usbDefaultPrinter');
      usb.defaultPrinter = null;
      addLog('Default USB printer cleared.', 'warning');
    } else {
      const def = { id: p.id, name: p.name, match: matchOf(p) };
      await chrome.storage.local.set({ usbDefaultPrinter: def });
      usb.defaultPrinter = def;
      addLog(`Default USB printer: ${p.name}.`, 'success');
    }
    renderUsb();
  }

  // A short ESC/POS receipt: plain ASCII, readable on 58 mm and 80 mm paper.
  function buildTestTicket(printerName) {
    const ascii = (s) => Array.from(String(s), (c) => {
      const code = c.charCodeAt(0);
      return code >= 0x20 && code < 0x7f ? code : 0x3f; // '?' for anything else
    });
    const LF = 0x0a;
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const rule = ascii('-'.repeat(32));
    return [
      0x1b, 0x40,                         // ESC @  initialise
      0x1b, 0x61, 0x01,                   // ESC a 1  centre
      0x1d, 0x21, 0x11, 0x1b, 0x45, 0x01, // GS ! double size, ESC E bold
      ...ascii('Local TCP'), LF,
      0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00,
      ...ascii('USB test print'), LF, LF,
      0x1b, 0x61, 0x00,                   // left
      ...rule, LF,
      ...ascii(`Printer: ${printerName || 'USB printer'}`), LF,
      ...ascii(`Time:    ${stamp}`), LF,
      ...rule, LF,
      0x1b, 0x61, 0x01,
      ...ascii('USB printing works!'), LF,
      0x1b, 0x64, 0x04,                   // ESC d 4  feed four lines
      0x1d, 0x56, 0x42, 0x00              // GS V 66 0  feed and partial cut
    ];
  }

  function toBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  async function testUsbPrint(p, button) {
    button.disabled = true;
    button.classList.add('loading');
    addLog(`Sending a test print to ${p.name}...`, 'info');
    const res = await sendMessage({
      action: 'USB_PRINT',
      printerId: p.id,
      match: matchOf(p),
      dataB64: toBase64(buildTestTicket(p.name)),
      jobName: 'Local TCP test print'
    });
    if (res.success) {
      usb.results[p.id] = { type: 'success', text: 'Test print sent. Check the printer.' };
      addLog(`Test print sent to ${p.name} (${res.bytesSent} bytes).`, 'success');
      // The printer came back under another id (new USB port): follow it.
      if (res.resolvedPrinterId && usb.defaultPrinter && usb.defaultPrinter.id === p.id) {
        usb.defaultPrinter = { ...usb.defaultPrinter, id: res.resolvedPrinterId };
        await chrome.storage.local.set({ usbDefaultPrinter: usb.defaultPrinter });
      }
    } else {
      usb.results[p.id] = { type: 'error', text: res.error || 'The test print failed.' };
      addLog(`Test print failed: ${res.error || 'unknown error'}`, 'error');
      if (res.detail) addLog(`Details: ${res.detail}`, 'error');
      if (res.code === 'bridgeOutdated') bridge = { ...bridge, features: ['tcp'] };
    }
    if (res.resolvedPrinterId) {
      await loadUsbPrinters({ quiet: true });
      return;
    }
    renderUsb();
  }

  usbRefreshBtn.addEventListener('click', async () => {
    usb.results = {};
    // Re-check the bridge too: the user may have just installed an update.
    await checkBridge();
    await loadUsbPrinters();
  });

  // Auto-poll: once the user runs the installer, the bridge registers and we flip
  // to "Bridge Linked" on our own — no Chrome restart, no manual re-check.
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const linked = await checkBridge();
      if (linked) {
        clearInterval(pollTimer);
        pollTimer = null;
        await loadSettings();
        await restorePane();
        addLog('Bridge linked — you\'re ready to print.', 'success');
      }
    }, 2500);
  }
  window.addEventListener('unload', () => { if (pollTimer) clearInterval(pollTimer); });

  async function restorePane() {
    const { popupPane } = await chrome.storage.local.get(['popupPane']);
    showPane(popupPane === 'usb' ? 'usb' : 'network');
  }

  // Initial check
  const isLinked = await checkBridge();
  if (isLinked) {
    await loadSettings();
    await restorePane();
  } else {
    startPolling();
    // First-run setup tab (opened by background.js on install): auto-start the
    // OS-matched download so the user doesn't have to find the button.
    if (new URLSearchParams(location.search).get('setup') === '1') {
      addLog('Welcome! Fetching your one-click installer...', 'info');
      downloadInstaller();
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    const host = hostInput.value.trim();
    const port = parseInt(portInput.value.trim());

    if (!host || !port) {
      addLog('Error: Host and Port are required.', 'error');
      return;
    }

    saveBtn.classList.add('loading');
    saveBtn.disabled = true;

    chrome.storage.local.set({ printerHost: host, printerPort: port }, () => {
      setTimeout(() => {
        saveBtn.classList.remove('loading');
        saveBtn.disabled = false;
        addLog('Configuration saved locally.', 'success');
      }, 300);
    });
  });

  if (saveOriginsBtn && originsInput) {
    saveOriginsBtn.addEventListener('click', async () => {
      const lines = originsInput.value
        .split('\n')
        .map((s) => s.trim().replace(/\/+$/, '')) // strip trailing slashes
        .filter(Boolean);

      // Validate each entry is a proper origin
      const invalid = [];
      const origins = [];
      for (const line of lines) {
        try {
          const u = new URL(line);
          origins.push(u.origin);
        } catch (_) {
          invalid.push(line);
        }
      }
      if (invalid.length) {
        addLog(`Invalid origin(s): ${invalid.join(', ')}`, 'error');
        return;
      }
      await chrome.storage.local.set({ allowedOrigins: origins });
      if (origins.length === 0) {
        addLog('Allowlist cleared — bridge is open to ALL websites.', 'warning');
      } else {
        addLog(`Allowlist saved (${origins.length} origin${origins.length > 1 ? 's' : ''}).`, 'success');
      }
    });
  }

  testBtn.addEventListener('click', () => {
    const host = hostInput.value.trim();
    const port = parseInt(portInput.value.trim());

    if (!host || !port) {
      addLog('Error: Set config before testing.', 'error');
      return;
    }

    testBtn.classList.add('loading');
    testBtn.disabled = true;

    addLog(`Testing connection to ${host}:${port}...`, 'info');

    chrome.runtime.sendMessage({
      type: 'LOCAL_TCP_PRINT',
      // DLE EOT 1: real-time status request. readTimeoutMs asks the host to wait
      // briefly for the printer's status byte so we can confirm it actually replied.
      payload: { host, port, bytes: [0x10, 0x04, 0x01], readTimeoutMs: 1500 }
    }, (response) => {
      testBtn.classList.remove('loading');
      testBtn.disabled = false;

      if (chrome.runtime.lastError) {
        addLog(`System Error: ${chrome.runtime.lastError.message}`, 'error');
      } else if (response && response.success) {
        if (Array.isArray(response.data) && response.data.length) {
          const hex = response.data.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ');
          addLog(`Success: printer replied (status ${hex}).`, 'success');
        } else {
          addLog('Connected & wrote OK, but the device sent no status reply.', 'info');
        }
      } else {
        addLog(`Failed: ${response?.error || 'Unknown error'}`, 'error');
      }
    });
  });

  downloadBtn.addEventListener('click', downloadInstaller);

  // Open the full documentation site in a new tab.
  if (docsBtn) docsBtn.addEventListener('click', () => chrome.tabs.create({ url: DOCS_URL }));

  // ─── Uninstall ───────────────────────────────────────────────────────────────
  if (uninstallBtn) uninstallBtn.addEventListener('click', downloadUninstaller);

  clearLogsBtn.addEventListener('click', () => {
    logBox.replaceChildren();
    addLog('Logs cleared.');
  });

  resetConfigBtn.addEventListener('click', async () => {
    if (confirm('Reset the printer IP/port? Your security allowlist will be kept.')) {
      // Only clear printer config — NOT allowedOrigins. Wiping the allowlist here
      // would silently revert the bridge to open mode (allow all websites).
      await chrome.storage.local.remove(['printerHost', 'printerPort']);
      hostInput.value = '';
      portInput.value = '';
      addLog('Printer config reset. Security allowlist kept.', 'warning');
    }
  });
});
