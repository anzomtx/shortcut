#!/bin/bash
# Shortcut launcher — double-click to start the local video editor server.
# Requires Node.js 22 and FFmpeg with libx264 + AAC (see README.md).

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 22 from https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close... "
  exit 1
fi

echo "Starting Shortcut at http://127.0.0.1:4173"
echo "Press Ctrl+C in this window to stop the server."

# Give the server a moment to boot, then open the browser.
( sleep 1 && open "http://127.0.0.1:4173" ) &

exec npm start