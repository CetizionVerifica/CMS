#!/usr/bin/env bash
# Cloud Claude sessions start from a fresh clone: install dependencies so lint, typecheck and tests run immediately.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
pnpm install --frozen-lockfile
