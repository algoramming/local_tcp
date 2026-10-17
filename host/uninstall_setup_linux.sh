#!/bin/bash

# Local TCP - Professional Linux Uninstaller
# Removes the hardware bridge and Chrome registration.

HOST_NAME="com.algoramming.localtcp"
INSTALL_DIR="$HOME/.local/lib/algoramming/localtcp"
TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"

echo "----------------------------------------------------"
echo "🗑️ Local TCP Bridge - Uninstaller (Linux)"
echo "----------------------------------------------------"

# 1. Remove Chrome Registration
if [ -f "$TARGET_DIR/$HOST_NAME.json" ]; then
    rm -f "$TARGET_DIR/$HOST_NAME.json"
    echo "✅ Chrome registration removed."
fi

# 2. Remove Installed Files
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    echo "✅ Bridge files removed."
fi

# 3. Remove the USB printer access rule (added by the installer; needs sudo)
UDEV_RULE_PATH="/etc/udev/rules.d/70-localtcp-usb-printers.rules"
if [ -f "$UDEV_RULE_PATH" ]; then
    echo "🖨️  Removing USB printer access (sudo may ask for your password)..."
    if sudo sh -c 'rm -f "$1" && { udevadm control --reload-rules; true; }' sh "$UDEV_RULE_PATH"; then
        echo "✅ USB printer access rule removed."
    else
        echo "⚠️ Could not remove $UDEV_RULE_PATH. Remove it with: sudo rm -f $UDEV_RULE_PATH"
    fi
fi

echo "----------------------------------------------------"
echo "Done. The bridge has been completely removed."
