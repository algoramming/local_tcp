// Local TCP - background.js
// Core TCP bridge service worker
// Handles all TCP connections from external web apps

const connections = {}; // connectionId -> socketId

// ─── Shared Message Handler ───────────────────────────────────────────────────
async function handleMessage(request, sender) {
  let { action, host, port, data, connectionId } = request;

  // Handle fallback to local storage for connection-oriented actions
  if (['CONNECT', 'PRINT', 'SEND', 'DISCONNECT'].includes(action)) {
    if (host && port) {
      // Save it explicitly
      await chrome.storage.local.set({ printerHost: host, printerPort: port });
    } else {
      // Load it from local storage
      const stored = await chrome.storage.local.get(['printerHost', 'printerPort']);
      host = stored.printerHost;
      port = stored.printerPort;
      
    if (!host || !port) {
        return { 
          success: false, 
          error: 'Host and port are required. Pass them in the API or configure them in the Local TCP extension.' 
        };
      }
    }
  }

  switch (action) {
    // ── PING: Check if Local TCP extension is installed & active ──────────────
    case 'PING': {
      return {
        success: true,
        name: 'Local TCP',
        version: chrome.runtime.getManifest().version,
        message: 'Your browser can finally talk with local TCP.'
      };
    }

    // ── CONNECT: Open TCP socket to host:port ────────────────────────────────
    case 'CONNECT': {
      const id = connectionId || `${host}:${port}`;

      // Close existing connection with same ID if any
      if (connections[id]) {
        await new Promise((resolve) => {
          chrome.sockets.tcp.disconnect(connections[id], () => {
            chrome.sockets.tcp.close(connections[id], resolve);
          });
        });
        delete connections[id];
      }

      return new Promise((resolve) => {
        chrome.sockets.tcp.create({}, (createInfo) => {
          if (chrome.runtime.lastError) {
            return resolve({ success: false, error: chrome.runtime.lastError.message });
          }

          const socketId = createInfo.socketId;

          chrome.sockets.tcp.connect(socketId, host, parseInt(port), (result) => {
            if (result < 0) {
              chrome.sockets.tcp.close(socketId);
              resolve({
                success: false,
                error: `Failed to connect to ${host}:${port} (code: ${result})`
              });
            } else {
              connections[id] = socketId;
              resolve({
                success: true,
                connectionId: id,
                socketId,
                message: `Connected to ${host}:${port}`
              });
            }
          });
        });
      });
    }

    // ── PRINT / SEND: Send raw bytes over TCP ────────────────────────────────
    case 'PRINT':
    case 'SEND': {
      const id = connectionId || `${host}:${port}`;
      const socketId = connections[id];

      if (!socketId) {
        return { success: false, error: `No active connection for: ${id}` };
      }

      if (!data || !Array.isArray(data)) {
        return { success: false, error: 'Invalid data: expected array of bytes' };
      }

      const buffer = new Uint8Array(data).buffer;

      return new Promise((resolve) => {
        chrome.sockets.tcp.send(socketId, buffer, (sendInfo) => {
          if (chrome.runtime.lastError || sendInfo.resultCode < 0) {
            const err = chrome.runtime.lastError?.message || `Send failed (code: ${sendInfo?.resultCode})`;
            resolve({ success: false, error: err });
          } else {
            resolve({ success: true, bytesSent: sendInfo.bytesSent });
          }
        });
      });
    }

    // ── DISCONNECT: Close TCP socket ─────────────────────────────────────────
    case 'DISCONNECT': {
      const id = connectionId || `${host}:${port}`;
      const socketId = connections[id];

      if (socketId) {
        return new Promise((resolve) => {
          chrome.sockets.tcp.disconnect(socketId, () => {
            chrome.sockets.tcp.close(socketId, () => {
              delete connections[id];
              resolve({ success: true, message: `Disconnected: ${id}` });
            });
          });
        });
      } else {
        return { success: true, message: 'No connection found, nothing to disconnect' };
      }
    }

    // ── STATUS: Check all active connections ─────────────────────────────────
    case 'STATUS': {
      const activeConnections = Object.keys(connections).map((id) => ({
        connectionId: id,
        socketId: connections[id]
      }));
      return { success: true, connections: activeConnections };
    }

    default: {
      return { success: false, error: `Unknown action: ${action}` };
    }
  }
}

const messageListener = (request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message || JSON.stringify(err) }));
  return true; // Keep channel open for async response
};

chrome.runtime.onMessageExternal.addListener(messageListener);
chrome.runtime.onMessage.addListener(messageListener);

// ─── Cleanup on suspend ───────────────────────────────────────────────────────
chrome.runtime.onSuspend?.addListener(() => {
  Object.entries(connections).forEach(([id, socketId]) => {
    chrome.sockets.tcp.disconnect(socketId, () => {
      chrome.sockets.tcp.close(socketId);
    });
    delete connections[id];
  });
});
