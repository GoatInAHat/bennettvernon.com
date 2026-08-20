#!/usr/bin/env bash
# Claude Code SessionStart hook: bootstrap remote sessions (Claude Code on the
# web) automatically. Local sessions skip it — run .agents/scripts/bootstrap.sh
# once per fresh checkout instead of paying for it on every session start.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

project_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
exec "$project_dir/.agents/scripts/bootstrap.sh"
