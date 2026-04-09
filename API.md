# Local TCP Web API Reference

The Local TCP extension exposes its Socket capability universally by injecting a native bridge into all websites. Any Web App in the world can safely connect without any special manifest whitelists by using standard `window.postMessage` events!

## Integration Basics

To use the API from your web application, create a standard asynchronous utility function to relay messages via the system.

```javascript
// A simple Promise-wrapper to make API calls beautifully async!
function sendLocalTCPRequest(payload) {
  return new Promise((resolve) => {
    const messageId = Math.random().toString(36).substring(7);

    // 1. Create a dynamic one-time listener for the response
    const handler = (event) => {
      if (event.source === window && event.data?.source === 'localtcp_res' && event.data.messageId === messageId) {
        window.removeEventListener('message', handler);
        resolve(event.data.response);
      }
    };
    window.addEventListener('message', handler);

    // 2. Send the outbound payload into the extension content script
    window.postMessage({
      source: 'localtcp_req',
      messageId: messageId,
      ...payload
    }, '*');
  });
}
```

> [!NOTE]
> **Implicit Parameter Fallback**  
> For commands that require interacting with a specific device (`CONNECT`, `PRINT`, `SEND`), if you **omit** the `host` and `port` fields from your payload, the extension will automatically retrieve and safely use the primary IP and Port that the user saved inside the Extension popup UI interface!
> 
> Oppositely, if you **provide** `host` and `port`, the extension uses those explicitly, and it also automatically saves those back into the extension UI parameters for future use.

---

## Allowed Actions

### 1. `PING`
Verifies if the Local TCP extension is successfully installed, active, and accessible from the web page context.

**Invocation:**
```javascript
const res = await sendLocalTCPRequest({ action: 'PING' });
console.log(res);
```

**Response:**
```json
{
  "success": true,
  "name": "Local TCP",
  "version": "1.0.0",
  "message": "Your browser can finally talk with your local TCP."
}
```

---

### 2. `CONNECT`
Explicitly opens a raw TCP socket connection and holds it open in the background.

**Invocation:**
```javascript
const req = {
  action: "CONNECT",
  host: "192.168.1.50", // Optional (Fallback automatically applies)
  port: 9100,           // Optional (Fallback automatically applies)
  connectionId: "printer_1" // Optional text identifier
};
const res = await sendLocalTCPRequest(req);
```

**Response:**
```json
{
  "success": true,
  "connectionId": "printer_1",
  "socketId": 45,
  "message": "Connected to 192.168.1.50:9100"
}
```

---

### 3. `PRINT` or `SEND`
Sends binary/byte data over the TCP socket. The `data` parameter is rigidly bound and immediately throws an error if it is not a valid Array of numbers.
*If `CONNECT` was never explicitly called, it will immediately open, send, and hold the connection open anyway!*

**Invocation:**
```javascript
const req = {
  action: "PRINT",
  host: "192.168.1.50", // Optional
  port: 9100,           // Optional 
  data: [27, 64, 104, 101, 108, 108, 111, 10] // Mandatory: Array of Bytes
};
const res = await sendLocalTCPRequest(req);
```

**Response:**
```json
{
  "success": true,
  "bytesSent": 8
}
```

---

### 4. `STATUS`
Gets an array of all currently active background TCP socket connections established by the extension.

**Invocation:**
```javascript
const res = await sendLocalTCPRequest({ action: 'STATUS' });
```

**Response:**
```json
{
  "success": true,
  "connections": [
    {
      "connectionId": "printer_1",
      "socketId": 45
    }
  ]
}
```

---

### 5. `DISCONNECT`
Disconnects and elegantly closes the TCP socket tied to the connection.

**Invocation:**
```javascript
const req = {
  action: "DISCONNECT",
  host: "192.168.1.50", // Optional
  port: 9100            // Optional
};
const res = await sendLocalTCPRequest(req);
```

**Response:**
```json
{
  "success": true,
  "message": "Disconnected: 192.168.1.50:9100"
}
```

---

## Handling Errors

If a socket timeouts, fails to route naturally, or invalid data parameters are sent, the extension catches them natively and returns an explicit boolean.

**Failure Responses Example:**
```json
{
  "success": false,
  "error": "Host and port are required. Pass them in the API or configure them in the Local TCP extension."
}
```
