#!/usr/bin/env bash
# Agent-agnostic environment setup for a fresh checkout.
#
# Safe to re-run; every step is idempotent. Works locally and in remote agent
# containers (Claude Code on the web, Codex cloud, Codespaces, CI).
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! command -v pre-commit >/dev/null 2>&1; then
    if command -v uv >/dev/null 2>&1; then
        uv tool install pre-commit
        export PATH="$(uv tool dir --bin):$PATH"
    else
        python3 -m pip install --user pre-commit ||
            python3 -m pip install --user --break-system-packages pre-commit
        export PATH="$(python3 -m site --user-base)/bin:$PATH"
    fi
fi

.agents/scripts/link-skills.sh
.agents/scripts/sync-mcp.sh
.agents/scripts/check-skills.py
pre-commit install

npm ci
