#!/bin/bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/sample-user"
cd /Users/sample-user/Projects/TeleCodex
exec /opt/homebrew/bin/node dist/index.js
