// Local TCP - popup.js

const hostInput   = document.getElementById('hostInput');
const portInput   = document.getElementById('portInput');
const testBtn     = document.getElementById('testBtn');
const saveBtn     = document.getElementById('saveBtn');
const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const logBox      = document.getElementById('logBox');
const themeToggle = document.getElementById('themeToggle');
const toggleIcon  = document.getElementById('toggleIcon');

// ── Theme ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['theme'], ({ theme }) => {
  const isDark = theme !== 'light';
  applyTheme(isDark ? 'dark' : 'light');
  themeToggle.checked = !isDark;
});

themeToggle.addEventListener('change', () => {
  const theme = themeToggle.checked ? 'light' : 'dark';
  applyTheme(theme);
  chrome.storage.local.set({ theme });
});

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  toggleIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
}

// ── Load saved settings ────────────────────────────────────────────────────────
chrome.storage.local.get(['printerHost', 'printerPort'], (data) => {
  if (data.printerHost) hostInput.value = data.printerHost;
  if (data.printerPort) portInput.value = data.printerPort;
});

// ── Save ───────────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const host = hostInput.value.trim();
  const port = parseInt(portInput.value.trim());

  if (!host || !port || port < 1 || port > 65535) {
    setStatus('error', 'Enter a valid host and port (1–65535)');
    return;
  }

  chrome.storage.local.set({ printerHost: host, printerPort: port }, () => {
    setStatus('active', `Saved: ${host}:${port}`);
    addLog('info', `Settings saved → ${host}:${port}`);
  });
});

// ── Test Connection ────────────────────────────────────────────────────────────
testBtn.addEventListener('click', async () => {
  const host = hostInput.value.trim();
  const port = parseInt(portInput.value.trim());

  if (!host || !port) {
    setStatus('error', 'Enter host and port first');
    return;
  }

  testBtn.disabled = true;
  testBtn.textContent = 'Connecting...';
  setStatus('idle', `Connecting to ${host}:${port}...`);
  addLog('info', `Testing ${host}:${port}...`);

  const connectionId = `test-${host}:${port}`;

  // CONNECT
  const connectResult = await sendMessage({ action: 'CONNECT', host, port, connectionId });

  if (!connectResult.success) {
    setStatus('error', `Failed: ${connectResult.error}`);
    addLog('error', `Connect failed → ${connectResult.error}`);
    resetBtn();
    return;
  }

  addLog('success', `Connected to ${host}:${port}`);
  setStatus('active', `Connected to ${host}:${port}`);

  // DISCONNECT immediately (just testing)
  await sendMessage({ action: 'DISCONNECT', connectionId });
  addLog('info', `Disconnected from ${host}:${port}`);
  setStatus('active', `✓ ${host}:${port} is reachable`);

  // Save on successful test
  chrome.storage.local.set({ printerHost: host, printerPort: port });

  resetBtn();
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function sendMessage(data) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(data, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'No response' });
      }
    });
  });
}

function setStatus(type, message) {
  statusDot.className = 'status-dot';
  if (type === 'active') statusDot.classList.add('active');
  if (type === 'error')  statusDot.classList.add('error');
  statusText.textContent = message;
}

function addLog(type, message) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg ${type}">${message}</span>
  `;

  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;

  // Keep max 50 entries
  while (logBox.children.length > 50) {
    logBox.removeChild(logBox.firstChild);
  }
}

function resetBtn() {
  testBtn.disabled = false;
  testBtn.textContent = 'Test Connection';
}
