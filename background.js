// LocalTCP - background.js
// Core TCP bridge service worker
// Handles all TCP connections from external web apps

const connections = {}; // connectionId -> socketId

// ─── External Message Handler ─────────────────────────────────────────────────
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  const { action, host, port, data, connectionId } = request;

  switch (action) {

    // ── PING: Check if LocalTCP extension is installed & active ──────────────
    case 'PING': {
      sendResponse({
        success: true,
        name: 'LocalTCP',
        version: chrome.runtime.getManifest().version,
        message: 'Your browser can finally talk with your local TCP.'
      });
      break;
    }

    // ── CONNECT: Open TCP socket to host:port ────────────────────────────────
    case 'CONNECT': {
      const id = connectionId || `${host}:${port}`;

      // Close existing connection with same ID if any
      if (connections[id]) {
        chrome.sockets.tcp.disconnect(connections[id], () => {
          chrome.sockets.tcp.close(connections[id]);
          delete connections[id];
        });
      }

      chrome.sockets.tcp.create({}, (createInfo) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }

        const socketId = createInfo.socketId;

        chrome.sockets.tcp.connect(socketId, host, parseInt(port), (result) => {
          if (result < 0) {
            chrome.sockets.tcp.close(socketId);
            sendResponse({
              success: false,
              error: `Failed to connect to ${host}:${port} (code: ${result})`
            });
          } else {
            connections[id] = socketId;
            sendResponse({
              success: true,
              connectionId: id,
              socketId,
              message: `Connected to ${host}:${port}`
            });
          }
        });
      });

      return true; // async
    }

    // ── PRINT / SEND: Send raw bytes over TCP ────────────────────────────────
    case 'PRINT':
    case 'SEND': {
      const id = connectionId || `${host}:${port}`;
      const socketId = connections[id];

      if (!socketId) {
        sendResponse({ success: false, error: `No active connection for: ${id}` });
        return;
      }

      if (!data || !Array.isArray(data)) {
        sendResponse({ success: false, error: 'Invalid data: expected array of bytes' });
        return;
      }

      const buffer = new Uint8Array(data).buffer;

      chrome.sockets.tcp.send(socketId, buffer, (sendInfo) => {
        if (chrome.runtime.lastError || sendInfo.resultCode < 0) {
          const err = chrome.runtime.lastError?.message || `Send failed (code: ${sendInfo.resultCode})`;
          sendResponse({ success: false, error: err });
        } else {
          sendResponse({ success: true, bytesSent: sendInfo.bytesSent });
        }
      });

      return true; // async
    }

    // ── DISCONNECT: Close TCP socket ─────────────────────────────────────────
    case 'DISCONNECT': {
      const id = connectionId || `${host}:${port}`;
      const socketId = connections[id];

      if (socketId) {
        chrome.sockets.tcp.disconnect(socketId, () => {
          chrome.sockets.tcp.close(socketId, () => {
            delete connections[id];
            sendResponse({ success: true, message: `Disconnected: ${id}` });
          });
        });
      } else {
        sendResponse({ success: true, message: 'No connection found, nothing to disconnect' });
      }

      return true; // async
    }

    // ── STATUS: Check all active connections ─────────────────────────────────
    case 'STATUS': {
      const activeConnections = Object.keys(connections).map((id) => ({
        connectionId: id,
        socketId: connections[id]
      }));
      sendResponse({ success: true, connections: activeConnections });
      break;
    }

    default: {
      sendResponse({ success: false, error: `Unknown action: ${action}` });
    }
  }
});

// ─── Cleanup on suspend ───────────────────────────────────────────────────────
chrome.runtime.onSuspend?.addListener(() => {
  Object.entries(connections).forEach(([id, socketId]) => {
    chrome.sockets.tcp.disconnect(socketId, () => {
      chrome.sockets.tcp.close(socketId);
    });
    delete connections[id];
  });
});
