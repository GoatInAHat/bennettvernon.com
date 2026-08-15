# Agent configuration

This directory is the canonical home for portable agent assets. Shared skills
are symlinked into tool-native discovery paths; MCP definitions are rendered
into each tool’s configuration format.

## Commands

```bash
# Install development tooling and refresh agent configuration
.agents/scripts/bootstrap.sh

# Create or refresh shared-skill symlinks
.agents/scripts/link-skills.sh

# Regenerate Claude, Cursor, and Codex MCP adapters
.agents/scripts/sync-mcp.sh

# Fail if an MCP adapter is missing or stale
.agents/scripts/sync-mcp.sh check

# Explicitly install this repo's managed MCP block in the user Codex config
.agents/scripts/sync-mcp.sh install-codex
```

## Cloud environments

Use the same command as the setup and maintenance script in Codex cloud:

```bash
bash .agents/scripts/bootstrap.sh
```

Claude Code runs it automatically at session start through the committed
`.claude/settings.json` hook. Other development environments can call the same
script from their native setup hook.

Generated MCP outputs are `.mcp.json`, `.cursor/mcp.json`, and
`.codex/config.toml`. The source of truth is `.agents/mcp/servers.json`. The
`Validate agent configuration` GitHub Actions workflow enforces synchronization
on pull requests and pushes to `main`; the bootstrap installs the local hook.
