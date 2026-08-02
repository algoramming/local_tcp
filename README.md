<div align="center">

<img src="icons/banner.png" alt="Local TCP Bridge" width="100%" />

<br /><br />

# 🛰️ Local TCP Bridge

### The missing link between web browsers and local TCP hardware.

Local&nbsp;TCP is a Native Messaging bridge that lets web applications talk directly to local TCP hardware, like ESC/POS thermal printers, over a secure, millisecond-latency binary protocol. No cloud hop, no print server.

<br />

![Version](https://img.shields.io/badge/version-2.1.1-5DC095?style=for-the-badge)
![Manifest](https://img.shields.io/badge/Manifest-V3-12876B?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-0B5C43?style=for-the-badge)
![Platforms](https://img.shields.io/badge/macOS·Windows·Linux-1E293B?style=for-the-badge)

<br />

**[📖 Documentation](https://algoramming.github.io/local_tcp/)** &nbsp;·&nbsp;
**[🧩 Add to Chrome](https://chromewebstore.google.com/detail/local-tcp/ngbakchodnmhndnghhejmocfadjfekkf)** &nbsp;·&nbsp;
**[🐦 Flutter Package](https://pub.dev/packages/flutter_esc_pos_network_universal)** &nbsp;·&nbsp;
**[✨ Algonize](https://www.algonize.xyz)**

</div>

---

## 🚀 Key Features

| | |
|---|---|
| ⚡ **One-click setup** | Native installers for macOS `.pkg`, Windows `.exe`, and Linux `.run`. No terminal needed, and Node.js is auto-installed if it isn't already present. |
| 🪶 **Lightweight host** | The bridge is a small Node.js script. Running through the system `node` is exactly what keeps it working under macOS 15/26 Local Network Privacy, where an unsigned standalone binary gets silently blocked from the LAN. |
| 🛡️ **Enterprise security** | Chrome's Native Messaging sandbox plus a configurable **origin allowlist**, so you can lock the bridge down to only your own web apps. |
| 🏎️ **Binary performance** | Streams raw ESC/POS bytes with millisecond precision and safe concurrent request correlation via `reqId`. |
| 🌍 **Framework agnostic** | Works with Flutter Web, React, Vue, Angular, or any standard web framework. Registers with Chrome, Edge, Chromium, and Brave. |

---

## 🏗️ Architecture

Local&nbsp;TCP operates as a multi-layer relay. Each request is tagged, gated, and correlated on its way from the page to the printer, then the response travels the same wire back.

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#12876B','primaryTextColor':'#ffffff','primaryBorderColor':'#5DC095','lineColor':'#17A673','edgeLabelBackground':'#0B3D2E','fontFamily':'ui-sans-serif, system-ui, sans-serif','fontSize':'15px'}}}%%
flowchart LR
    A["🌐 Web App"] -->|"window.postMessage"| B["🧩 Content Script"]
    B -->|"runtime.sendMessage"| C["⚙️ Background<br/>Service Worker"]
    C -->|"Native Messaging<br/>reqId · JSON"| D["🔌 Native Host<br/>node index.js"]
    D -->|"raw TCP · :9100"| E["🖨️ Thermal Printer"]
```

| Step | Layer | Responsibility |
|:---:|---|---|
| 1 | **Web App** | Sends a `window.postMessage` tagged with a unique `messageId`. |
| 2 | **Content Script** | Forwards it to the background, then posts the reply back scoped to the page's own origin, never a `*` wildcard. |
| 3 | **Background (Service Worker)** | Checks the origin allowlist, then relays the request (tagged with a `reqId`) to the native host over a single persistent port. |
| 4 | **Native Host (Node.js)** | Opens a raw TCP socket to your hardware on port `9100`, writes the bytes, and echoes the `reqId` back so concurrent jobs never cross wires. |

---

## 📥 Installation

1. Add the extension to Chrome from the **[Chrome Web Store](https://chromewebstore.google.com/detail/local-tcp/ngbakchodnmhndnghhejmocfadjfekkf)**.
2. Open the extension popup and click **Download Setup Kit** (it auto-detects your OS).
3. Run the installer for your platform:

<table>
<tr>
<td width="33%" valign="top">

### 🍎 macOS

Double-click `localtcp-mac-installer.pkg` → **Continue** → **Install**.

macOS prompts for your password; the host installs for your user account.

</td>
<td width="33%" valign="top">

### 🪟 Windows

Double-click `localtcp-windows-installer.exe` → **Install**.

No admin rights needed; it installs per-user. If SmartScreen warns, choose **More info → Run anyway**.

</td>
<td width="33%" valign="top">

### 🐧 Linux

```bash
chmod +x localtcp-linux-installer.run
./localtcp-linux-installer.run
```

</td>
</tr>
</table>

4. **Restart Chrome** completely. The popup shows **Bridge Linked**. Done.

> That is the entire process, no copying files by hand. The installer needs Node.js; if it is missing, it installs it for you via your system package manager.

---

## ⚡ Quick Start

There are two supported ways to talk to the bridge:

- **JavaScript / any web framework** (React, Vue, Angular, plain JS). Post messages to the page `window`; the content script relays them to the printer. No SDK required.
- **Flutter** (web **and** mobile/desktop). Use the official package, which auto-detects the platform and routes through this extension on web.

> In all cases the end user must have the extension installed and the bridge **Linked**. Always check availability first with `CHECK_BRIDGE`.

---

## 🟨 JavaScript / Web

The extension injects a content script into **every page**, bridging `window.postMessage` with the native host. You send a request tagged with a unique `messageId` and listen for the correlated response. No imports, no globals to load.

<details open>
<summary><b>1 · Drop-in client</b></summary>

```js
// localtcp.js — a tiny promise-based client for the Local TCP bridge.
export class LocalTcp {
  constructor({ timeoutMs = 30000 } = {}) {
    this._timeout = timeoutMs;
    this._pending = new Map();
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.source !== 'localtcp_res') return;
      const p = this._pending.get(d.messageId);
      if (!p) return;
      clearTimeout(p.timer);
      this._pending.delete(d.messageId);
      p.resolve(d.response || { success: false, error: 'Empty response' });
    });
  }

  _send(message) {
    return new Promise((resolve) => {
      const messageId =
        (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        this._pending.delete(messageId);
        resolve({ success: false, error: 'Bridge timeout — is the extension installed & linked?' });
      }, this._timeout);
      this._pending.set(messageId, { resolve, timer });
      window.postMessage({ source: 'localtcp_req', messageId, ...message }, '*');
    });
  }

  /** Is the extension installed AND the native host linked? → {success, connected, version} */
  checkBridge()              { return this._send({ action: 'CHECK_BRIDGE' }); }
  connect(host, port = 9100) { return this._send({ action: 'CONNECT', host, port }); }
  /** Send raw ESC/POS bytes (Array<number>). */
  print(host, port, bytes)   { return this._send({ action: 'PRINT', host, port, data: bytes }); }
  disconnect(host, port)     { return this._send({ action: 'DISCONNECT', host, port }); }
}
```

</details>

### 2 · Print a receipt

Generate ESC/POS bytes with any encoder (for example [`esc-pos-encoder`](https://www.npmjs.com/package/esc-pos-encoder)), then send them:

```js
import EscPosEncoder from 'esc-pos-encoder';
import { LocalTcp } from './localtcp.js';

const printer = new LocalTcp();

// 1. Make sure the bridge is ready
const bridge = await printer.checkBridge();
if (!bridge.connected) {
  alert('Please install the Local TCP extension and run the one-click installer.');
  return;
}

// 2. Build the receipt
const data = new EscPosEncoder()
  .initialize()
  .align('center').bold(true).line('ALGORAMMING CAFE').bold(false)
  .align('left')
  .line('1x Espresso         $3.00')
  .line('1x Croissant        $2.50')
  .newline().line('TOTAL               $5.50')
  .newline().newline().cut()
  .encode(); // → Uint8Array

// 3. Print — pass a PLAIN Array, then close the socket
const res = await printer.print('192.168.1.50', 9100, Array.from(data));
if (!res.success) console.error('Print failed:', res.error);
await printer.disconnect('192.168.1.50', 9100);
```

> [!WARNING]
> **Always pass a plain `Array<number>`** (`Array.from(uint8array)`). A raw `Uint8Array` does not survive the extension's JSON message hop and arrives malformed.

<details>
<summary><b>3 · Read a status reply (optional)</b></summary>

For ESC/POS status queries (for example `DLE EOT`), set `readTimeoutMs`; the response's `data` holds the bytes the printer returned:

```js
const res = await printer._send({
  action: 'PRINT', host: '192.168.1.50', port: 9100,
  data: [0x10, 0x04, 0x01], readTimeoutMs: 1500,
});
console.log('Printer replied:', res.data); // e.g. [22]
```

</details>

---

## 🐦 Flutter

Use the official package, one type-safe API for **mobile, desktop, and web**. On web it automatically routes through this extension; on mobile/desktop it opens a direct TCP socket. **Your code is identical on every platform.**

**Pub.dev:** [`flutter_esc_pos_network_universal`](https://pub.dev/packages/flutter_esc_pos_network_universal)

### 1 · Add the dependency

```yaml
dependencies:
  flutter_esc_pos_network_universal: ^1.1.0
```

### 2 · Print raw ESC/POS bytes

```dart
import 'package:flutter/material.dart';
import 'package:flutter_esc_pos_network_universal/flutter_esc_pos_network_universal.dart';

Future<void> printReceipt() async {
  final printer = PrinterNetworkManager(
    '192.168.1.50',
    port: 9100,
    paperSize: ThermalPosPrinterPageSize.size80mm,
    // On web, give the bridge time to wake a sleeping Wi-Fi printer.
    timeout: const Duration(seconds: 30),
  );

  final profile = await CapabilityProfile.load();
  final g = Generator(PaperSize.mm80, profile);
  final bytes = <int>[
    ...g.text('ALGORAMMING CAFE',
        styles: const PosStyles(align: PosAlign.center, bold: true)),
    ...g.text('Espresso .......... \$3.00'),
    ...g.feed(2),
    ...g.cut(),
  ];

  final result = await printer.printTicket(bytes); // connect → print → disconnect
  if (result != PosPrintResult.success) debugPrint(result.msg);

  printer.dispose(); // closes the socket (IO) / removes the bridge listener (web)
}
```

<details>
<summary><b>3 · Print any Flutter widget as a receipt</b></summary>

```dart
await printer.printWidget(context, child: const MyReceiptWidget());
```

The widget is rendered to a bitmap and sent as a single ESC/POS raster image, which is perfect for logos, QR codes, and rich layouts.

</details>

### Platform notes

| Platform | Transport | Extension needed? |
|---|---|:---:|
| Android · iOS · Windows · macOS · Linux | Direct TCP socket | No |
| **Web** | This Local TCP extension | **Yes** |

- Always call `printer.dispose()` when finished (especially on web, where it removes the message listener).
- 58mm and 80mm map 1:1; **72mm** renders at 512 px and prints via the 80mm profile.
- On web, image processing runs on the main thread; for very large receipts prefer `printTicket` with pre-built bytes over `printWidget`.

---

## 📨 Message Protocol Reference

For any other client, this is the full contract. Post to `window` with `source: "localtcp_req"` and a unique `messageId`; the response returns on a `window` `message` event with `source: "localtcp_res"` and the **same** `messageId`.

<table>
<tr><td valign="top" width="50%">

**→ Request**

| Field | Type | Notes |
|---|---|---|
| `source` | string | must be `"localtcp_req"` |
| `messageId` | string | your unique id, echoed back |
| `action` | string | see actions below |
| `host` | string | printer IP on the LAN |
| `port` | number | default `9100` |
| `data` | number[] | ESC/POS bytes, a plain array |
| `readTimeoutMs` | number | optional; wait for a reply |

</td><td valign="top" width="50%">

**← Response**

| Field | Type | Notes |
|---|---|---|
| `success` | bool | overall result |
| `connected` | bool | `CHECK_BRIDGE`, host reachable |
| `version` | string | installed host version |
| `bytesSent` | number | `PRINT` / `SEND` |
| `data` | number[] | bytes read back |
| `error` | string | present on failure |

</td></tr>
</table>

**Actions:** &nbsp; `CHECK_BRIDGE` · `CONNECT` · `PRINT` · `SEND` · `DISCONNECT` · `PING`

A high-level alias is also accepted: `{ type: "LOCAL_TCP_PRINT", payload: { host, port, bytes, readTimeoutMs } }`, where `bytes` maps to `data`. Concurrent jobs to the same printer are serialized by the native host, so byte streams never interleave.

---

## 🗑️ Uninstallation

Just as easy as installing. In the extension popup click **Uninstall Setup Kit** to download the uninstaller for your OS, then run it:

| Platform | How to remove |
|---|---|
| 🪟 **Windows** | Run `localtcp-windows-uninstaller.exe`, or Start Menu → **Uninstall Local TCP Bridge**, or Settings → **Apps** → Uninstall. |
| 🍎 **macOS** | Double-click `localtcp-mac-uninstaller.pkg` → **Continue** → **Install** → enter your password → **Done**. |
| 🐧 **Linux** | Run `localtcp-linux-uninstaller.run` the same way you ran the installer. |

To remove the extension itself, open `chrome://extensions` and remove **Local TCP**.

---

## 🛠️ Building From Source

The native host is `host/index.js` (Node.js), no build step. The cross-platform installer that registers it lives in `installers/rust/`:

```bash
# Build the installer for the machine you're on (requires Rust)
cd installers/rust && cargo build --release
# → target/release/localtcp-installer   (run with: install | uninstall)
```

For local development you can also register the host directly with the scripts in `host/` (for example `bash host/install_setup_mac.sh`), no Rust needed.

Or just **push to `main`**: the GitHub Actions workflow builds all three installers and publishes them to a GitHub Release automatically, tagged from the `version` field in `manifest.json`. To cut a new version, bump `manifest.json` `version` and push; re-pushing the same version refreshes the existing release's files. The extension popup always downloads from `releases/latest`, so users get the newest build without any link changes.

---

## 📖 Documentation

A full single-page reference (features, architecture, protocol, and step-by-step install / uninstall guides) ships in two places:

**🌐 Online** — public, shareable, works for everyone:

<div align="center">

### **[algoramming.github.io/local_tcp](https://algoramming.github.io/local_tcp/)**

</div>

**🧩 Inside the extension** — bundled and reachable offline from the popup's **Documentation** button. For installed users it is served straight from the extension's own origin:

```text
chrome-extension://ngbakchodnmhndnghhejmocfadjfekkf/index.html
```

> This `chrome-extension://` address only resolves for users who have the extension installed (paste it into the address bar). It is not a public web link.

---

<div align="center">

## ✨ Built for Algonize

Local&nbsp;TCP&nbsp;Bridge began as a piece of **[Algonize](https://www.algonize.xyz)**, a business platform that needed the browser to print straight to local hardware. Solving that once turned into a tool anyone can use, so we opened it up.

<br />

**[Explore Algonize →](https://www.algonize.xyz)**

<br />

---

<sub>© 2026 **Algoramming Systems Ltd.** · MIT License · Distributed for professional hardware integration globally.</sub>

</div>
