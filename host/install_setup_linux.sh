#!/bin/bash

# Local TCP Bridge - Smart Linux Installer
# Registers the bridge with Chrome and ensures Node.js is ready.

set -e

HOST_NAME="com.algoramming.localtcp"
INSTALL_DIR="$HOME/.local/lib/algoramming/localtcp"
TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"

# Colors for professional output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

error_handler() {
    echo -e "\n${RED}❌ ERROR: Installation failed at line $1${NC}"
    echo -e "${YELLOW}Troubleshooting:${NC}"
    echo "1. Ensure you have an active internet connection."
    echo "2. Visit https://nodejs.org/ to install Node.js manually if auto-install fails."
    exit 1
}

trap 'error_handler $LINENO' ERR

ensure_node_installed() {
    echo -e "🔍 Detecting Node.js environment..."
    if ! command -v node &> /dev/null; then
        echo -e "${YELLOW}⚠️ Node.js not found. Attempting automatic installation...${NC}"
        
        if command -v apt-get &> /dev/null; then
            echo -e "${CYAN}📦 Found apt. Installing Node.js...${NC}"
            sudo apt-get update && sudo apt-get install -y nodejs npm
        elif command -v dnf &> /dev/null; then
            echo -e "${CYAN}📦 Found dnf. Installing Node.js...${NC}"
            sudo dnf install -y nodejs
        elif command -v pacman &> /dev/null; then
            echo -e "${CYAN}📦 Found pacman. Installing Node.js...${NC}"
            sudo pacman -S --noconfirm nodejs npm
        else
            echo -e "${RED}❌ Error: Node.js is missing and no supported package manager found.${NC}"
            echo "Please install Node.js manually: https://nodejs.org/"
            exit 1
        fi
    fi
    echo -e "📍 Found Node at: ${GREEN}$(command -v node)${NC}"
}

# Linux keeps /dev/usb/lp* for root and the `lp` group. This udev rule hands USB
# printers to whoever is signed in at the screen (systemd-logind "uaccess"), with
# no re-login. Needs sudo once; skipped (with instructions) if that fails.
UDEV_RULE_PATH="/etc/udev/rules.d/70-localtcp-usb-printers.rules"
UDEV_RULE='# Local TCP Bridge: lets the signed-in user print to USB receipt printers
# (/dev/usb/lp*) without root. Added by the Local TCP installer, removed by its
# uninstaller.
SUBSYSTEM=="usbmisc", KERNEL=="lp[0-9]*", TAG+="uaccess"'

setup_usb_access() {
    echo "🖨️  Setting up USB printer access (sudo may ask for your password)..."
    if [ "$(cat "$UDEV_RULE_PATH" 2>/dev/null)" = "$UDEV_RULE" ]; then
        echo -e "${GREEN}✅ USB printer access is already set up.${NC}"
        return 0
    fi
    # The rule goes in on stdin: no temp file that someone could swap out.
    if printf '%s\n' "$UDEV_RULE" | sudo sh -c 'umask 022 && cat > "$1" && { udevadm control --reload-rules; udevadm trigger --subsystem-match=usbmisc --action=change; true; }' sh "$UDEV_RULE_PATH"; then
        echo -e "${GREEN}✅ USB printer access enabled.${NC}"
    else
        echo -e "${YELLOW}⚠️ USB printer access was not set up. To use USB printers later, run once:${NC}"
        echo "   sudo usermod -aG lp \$USER   (then log out and back in)"
    fi
    return 0
}

run_installer() {
    echo -e "${BLUE}--------------------------------------------------${NC}"
    echo -e "${CYAN}           🚀 Local TCP Bridge - Smart Setup      ${NC}"
    echo -e "${BLUE}--------------------------------------------------${NC}"

    # 1. Ensure Node is present
    ensure_node_installed
    NODE_PATH=$(command -v node)

    # 2. Create directories
    echo "📁 Creating application directories..."
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$TARGET_DIR"

    # 3. Get the directory where the script is located
    SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

    # 4. Copy files
    echo "📂 Installing bridge files..."
    cp "$SCRIPT_DIR/index.js" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/$HOST_NAME.json" "$INSTALL_DIR/"

    # 5. Patch Shebang with Absolute Path
    echo "🔧 Patching execution path for stability..."
    # Linux sed -i is straightforward
    sed -i "1s|.*|#!$NODE_PATH|" "$INSTALL_DIR/index.js"
    chmod +x "$INSTALL_DIR/index.js"

    # 6. Generate manifest
    sed "s|HOST_PATH|$INSTALL_DIR/index.js|g" "$INSTALL_DIR/$HOST_NAME.json" > "$TARGET_DIR/$HOST_NAME.json"

    # 7. USB printer access (optional; network printing works without it)
    setup_usb_access

    echo -e "\n${GREEN}✅ Bridge installed successfully!${NC}"
    echo -e "📍 Location: $INSTALL_DIR"
    echo -e "${YELLOW}👉 IMPORTANT: Please restart Chrome fully to complete setup.${NC}"
    echo -e "${BLUE}--------------------------------------------------${NC}"
}

run_installer
