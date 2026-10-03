#!/usr/bin/env bash
# needs-hosts: deb.debian.org security.debian.org
# note: Chromium is installed at /usr/bin/chromium with fonts. For Playwright use the system browser: set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium and launch with executablePath, headless; do not run `playwright install`, its download hosts are not allowed.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji
# Verification: the browser starts headless.
chromium --headless=new --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null
echo "chromium $(chromium --version)"
