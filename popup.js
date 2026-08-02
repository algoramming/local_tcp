// Local TCP - popup.js
// Handles configuration, UI states, bridge status, and the security allowlist.
// The Setup Kit button downloads a one-click installer from GitHub Releases.

const RELEASE_BASE = 'https://github.com/algonize/local_tcp/releases/latest/download/';
// Full single-page documentation (features, architecture, protocol, install/uninstall guides).
const DOCS_URL = 'https://algonize.github.io/local_tcp/';
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

  // 1. Check Bridge Status
  async function checkBridge() {
    statusText.textContent = 'Checking...';
    statusDot.className = 'dot';

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'CHECK_BRIDGE' }, (res) => {
        if (res && res.connected) {
          statusText.textContent = res.version ? `Bridge v${res.version}` : 'Bridge Linked';
          statusDot.className = 'dot active';
          setupState.classList.remove('active');
          dashboardState.classList.add('active');
          resolve(true);
        } else {
          statusText.textContent = 'Setup Required';
          statusDot.className = 'dot error';
          setupState.classList.add('active');
          dashboardState.classList.remove('active');
          resolve(false);
        }
      });
    });
  }

  // 2. Load settings
  async function loadSettings() {
    const stored = await chrome.storage.local.get(['printerHost', 'printerPort', 'allowedOrigins']);
    if (stored.printerHost) hostInput.value = stored.printerHost;
    if (stored.printerPort) portInput.value = stored.printerPort;
    if (originsInput && Array.isArray(stored.allowedOrigins)) {
      originsInput.value = stored.allowedOrigins.join('\n');
    }
  }

  // 3. Logging Helper
  function addLog(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-msg ${type}">${msg}</span>`;
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
        addLog('Bridge linked — you\'re ready to print.', 'success');
      }
    }, 2500);
  }
  window.addEventListener('unload', () => { if (pollTimer) clearInterval(pollTimer); });

  // Initial check
  const isLinked = await checkBridge();
  if (isLinked) {
    await loadSettings();
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
    logBox.innerHTML = '';
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
