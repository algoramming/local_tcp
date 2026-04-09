![Local TCP Chrome Extension Promotional Banner](promo_banner.png)

# Local TCP

A Chrome Extension that bridges any web app to any local TCP device.
No native app. No server. Just install and print.

---

## Project Structure

```
local_tcp/
├── chrome_extension/          ← Publish this to Chrome Web Store
│   ├── manifest.json
│   ├── background.js          ← Core TCP bridge logic
│   ├── popup.html             ← Extension UI (dark/light theme)
│   ├── popup.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
└── flutter_integration/       ← Drop these into your CRM
    └── lib/services/
        ├── local_tcp_config.dart          ← Set your Extension ID here
        ├── local_tcp_web_bridge.dart      ← Web: JS interop to extension
        ├── local_tcp_native.dart          ← Mobile/Desktop: raw TCP
        ├── printer_service.dart           ← Unified platform-aware service
        ├── local_tcp_banner.dart          ← "Install Extension" banner widget
        └── printer_settings_screen.dart   ← Settings UI screen
```

---

## Setup Guide

### Step 1 — Load Chrome Extension

1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load Unpacked**
4. Select the `chrome_extension/` folder
5. Turn the extension toggle ON!

### Step 2 — No Extension ID Required!

Because Local TCP automatically injects the networking APIs directly into standard web pages natively, you do **not** need to configure, hardcode, or memorize your Extension ID anywhere in your codebase! Just trigger your payloads dynamically.

### Step 3 — Add to your Flutter CRM

Copy the `lib/services/` files into your project.

Add dependencies to `pubspec.yaml`:
```yaml
dependencies:
  hive_ce: ^2.0.0
  js: ^0.6.7
```

### Step 4 — Use in your CRM

```dart
import 'services/printer_service.dart';

// Generate ESC/POS bytes using esc_pos_utils
final profile = await CapabilityProfile.load();
final generator = Generator(PaperSize.mm80, profile);
List<int> bytes = [];
bytes += generator.text('Receipt', styles: PosStyles(bold: true));
bytes += generator.feed(2);
bytes += generator.cut();

// Print — works on both Web and Mobile automatically
final result = await PrinterService.print(bytes);

if (result.success) {
  print('Printed!');
} else if (result.error == 'localtcp_not_installed') {
  // Show install banner
} else {
  print('Error: ${result.error}');
}
```

### Step 5 — Add Printer Settings Screen

```dart
// In your router
GoRoute(
  path: '/settings/printer',
  builder: (_, __) => const PrinterSettingsScreen(),
),
```

### Step 6 — Wrap your app with install banner (optional)

```dart
// In your main scaffold or print screen
LocalTcpBanner(
  child: YourPrintScreen(),
)
```

---

## Chrome Extension API

Any web app can use Local TCP directly to connect to TCP devices. 

We have compiled a complete reference manual demonstrating how to execute commands like `PING`, `CONNECT`, `PRINT`, `SEND`, `STATUS`, and `DISCONNECT`, including our very helpful **Implicit Fallback** storage feature.

📚 **[Read the Full API Documentation (API.md)](API.md)**

---

## Publishing to Chrome Web Store

1. Zip the `chrome_extension/` folder contents (not the folder itself)
2. Go to https://chrome.google.com/webstore/devconsole
3. Register with $5 one-time fee
4. Upload zip → fill details → submit
5. Review takes 1–3 weeks (sockets permission = manual review)
6. After approval: update `extensionId` in `local_tcp_config.dart`

---

## How It Works

```
Flutter Web CRM
     │
     │ dart:js (chrome.runtime.sendMessage)
     ▼
Local TCP Chrome Extension (background.js)
     │
     │ chrome.sockets.tcp
     ▼
Local TCP Device (Printer / Scale / Scanner)
192.168.10.199:9100
```

No server. No native app. Pure Chrome Extension TCP.
