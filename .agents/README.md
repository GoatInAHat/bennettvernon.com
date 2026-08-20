# Agent configuration

This directory is the canonical home for portable agent assets. Shared skills
are symlinked into tool-native discovery paths; MCP definitions are rendered
into each tool's configuration format.

## Commands

```bash
# Install development tooling and refresh agent configuration
.agents/scripts/bootstrap.sh

# Create or refresh shared-skill symlinks
.agents/scripts/link-skills.sh

# Regenerate the Claude, Cursor, Codex, and Gemini MCP adapters
.agents/scripts/sync-mcp.sh

# Fail if an MCP adapter is missing or stale
.agents/scripts/sync-mcp.sh check

# Explicitly install this repo's managed MCP block in the user Codex config
.agents/scripts/sync-mcp.sh install-codex

# Verify skills-lock.json against the skills on disk (--update to re-lock)
.agents/scripts/check-skills.py
```

## Cloud environments

Every environment runs the same script. Nothing is environment-specific except
the hook that calls it:

| Environment | Entry point |
|---|---|
| Local | `.agents/scripts/bootstrap.sh`, once per checkout |
| Claude Code (web) | `SessionStart` hook → `.claude/hooks/session-start.sh` |
| Codex cloud | `.codex/environments/environment.toml` `[setup] script` |
| GitHub Codespaces / devcontainers | `.devcontainer/devcontainer.json` `postCreateCommand` |
| CI | `.github/workflows/agent-config.yml` |

To add another environment, call `bash .agents/scripts/bootstrap.sh` from its
native setup hook. Do not fork the setup logic.

## Generated files

`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, and the `mcpServers` and
`enabledMcpjsonServers` keys of `.gemini/settings.json` and
`.claude/settings.json` are generated from `.agents/mcp/servers.json`. The
`Validate agent configuration` workflow enforces synchronization on pull
requests and pushes to `main`; the bootstrap installs the local hook.
