# Agent Orchestrator MCP development tasks.

default:
    @just --list

# Sync generated tool-specific AI files from .agents/.
ai-sync:
    node scripts/sync-ai-workspace.mjs

# Check generated tool-specific AI files are up to date.
ai-sync-check:
    node scripts/sync-ai-workspace.mjs --check

# Show repository-local AI hook status.
ai-hooks-status:
    node scripts/ai-hooks.mjs status

# Enable repository-local AI hooks. This writes local git config:
# core.hooksPath=.githooks
ai-hooks-enable:
    node scripts/ai-hooks.mjs enable

# Disable repository-local AI hooks installed by this kit.
ai-hooks-disable:
    node scripts/ai-hooks.mjs disable

# Initialize or refresh the optional user-level MCP secrets file.
init-mcp-secrets:
    node scripts/init-mcp-secrets.mjs

# Bridge secret-bearing MCP stdio servers through the shared env contract.
mcp-secret-bridge *args:
    node scripts/mcp-secret-bridge.mjs {{args}}

# Show supported MCP bridge profiles.
mcp-profiles:
    node scripts/mcp-secret-bridge.mjs --list-profiles

# Build the local package before using the dogfood MCP config.
orchestrator-build:
    pnpm build

# Show local MCP server help from the current build.
orchestrator-help: orchestrator-build
    node dist/cli.js --help

# Check local worker CLI availability from the current build.
orchestrator-doctor: orchestrator-build
    node dist/cli.js doctor

# Show the current daemon status.
orchestrator-status: orchestrator-build
    node dist/daemonCli.js status

# Explicitly start the daemon. MCP clients also auto-start it via node dist/cli.js.
orchestrator-start: orchestrator-build
    node dist/daemonCli.js start

# Stop the daemon. Pass --force to cancel active runs first.
orchestrator-stop *args: orchestrator-build
    node dist/daemonCli.js stop {{args}}

# Restart the daemon so it picks up the current build.
orchestrator-restart: orchestrator-build
    -node dist/daemonCli.js stop --force
    sleep 1
    node dist/daemonCli.js start
    node dist/daemonCli.js status

# Preview terminal run pruning for runs older than the requested age.
orchestrator-prune-dry-run days="30": orchestrator-build
    node dist/daemonCli.js prune --older-than-days {{days}} --dry-run

# Prune terminal runs older than the requested age.
orchestrator-prune days="30": orchestrator-build
    node dist/daemonCli.js prune --older-than-days {{days}}

# Show AI workspace files.
ai-files:
    find AGENTS.md CLAUDE.md .agents .claude .cursor .codex .githooks docs/development -maxdepth 4 -type f 2>/dev/null | sort

# Create or attach a worktree for a branch.
worktree branch:
    node scripts/worktree.mjs create {{branch}}

# List all active worktrees.
worktree-list:
    node scripts/worktree.mjs list

# Remove a clean worktree by branch name.
worktree-remove branch:
    node scripts/worktree.mjs remove {{branch}}

# Remove clean worktrees whose tracking branch no longer exists on origin.
worktree-prune:
    node scripts/worktree.mjs prune
