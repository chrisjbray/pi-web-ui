#!/bin/bash
# Build and validate this source set. Exit non-zero on the first failure,
# so `scripts/build.sh && scripts/restart.sh` is a fair "can we build and
# restart this code" gate. Mirrors the fast CI jobs in order (format, lint,
# protocol sync, locales, typecheck, unit tests, build). Slow/heavy CI-only
# gates stay out: plugin-bundle freshness (nested npm ci), extension pack,
# and protocol smoke tests (needs ports, runs in CI/nightly).
set -Eeuo pipefail
cd "$(dirname "$0")/.."

# Deploy env (e.g. PI_WEB_TOOL_TIMEOUT_MS=3600000 from the systemd unit)
# must not leak into the gates: default-value tests assume code defaults.
unset PI_WEB_TOOL_TIMEOUT_MS

npm run format:check
npm run lint
node scripts/check-protocol-sync.mjs
npm run i18n:check
npm run typecheck
npx vitest run
npm run build
