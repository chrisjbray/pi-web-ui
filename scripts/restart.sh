#!/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
npm run build

XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi-web-ui-local
