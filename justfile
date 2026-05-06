# Agent Orchestrator development tasks.

# Bind recipe args to $1, $2, ... so quoted arguments containing shell
# metacharacters (semicolons, pipes, redirects, etc.) do not expand as live
# shell syntax. Without this, `{{args}}` interpolation pastes raw user input
# into the recipe body and makes quoted prompts unsafe.
set positional-arguments

# Recipes use POSIX shell idioms ([ ... ], printf, rm -rf, ...) so on Windows
# just must invoke Git Bash's sh.exe rather than the default lookup, which
# fails under PowerShell or CMD with "could not find the shell: program not
# found". Run from inside Git Bash, or ensure Git's usr\bin is on PATH so
# sh.exe resolves.
set windows-shell := ["sh.exe", "-cu"]

repo_root := justfile_directory()
local_orchestrator_home := `node scripts/local-orchestrator-home.mjs`
local_cli := repo_root + "/dist/cli.js"
local_shim_root := repo_root + "/.agent-orchestrator-local"
local_bin_dir := local_shim_root + "/bin"

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

# Run the local branch CLI against its isolated daemon store.
agent-orchestrator *args: orchestrator-build
    @if [ "${1:-}" = "--" ]; then shift; fi; AGENT_ORCHESTRATOR_HOME="{{local_orchestrator_home}}" node "{{local_cli}}" "$@"

# Short alias for running the local branch CLI against its isolated daemon store.
local *args: orchestrator-build
    @if [ "${1:-}" = "--" ]; then shift; fi; AGENT_ORCHESTRATOR_HOME="{{local_orchestrator_home}}" node "{{local_cli}}" "$@"

# Short alias for creating npm-style local command shims and printing a shell export.
local-env:
    @just agent-orchestrator-local-env

# Short alias for printing the isolated local branch daemon store.
local-home:
    @just agent-orchestrator-local-home

# Short alias for cleaning up the local branch daemon store and command shims.
local-clean:
    @just agent-orchestrator-local-clean

# Create npm-style local command shims and print a shell export for this session.
agent-orchestrator-local-env:
    @node scripts/local-orchestrator-shims.mjs --print-env

# Create npm-style local command shims and print their bin directory.
agent-orchestrator-local-bin:
    @node scripts/local-orchestrator-shims.mjs --print-bin

# Print the isolated store used by the local branch daemon.
agent-orchestrator-local-home:
    @printf '%s\n' "{{local_orchestrator_home}}"

# Stop the local branch daemon and remove its isolated store and command shims.
agent-orchestrator-local-clean:
    @if [ -f "{{local_cli}}" ]; then AGENT_ORCHESTRATOR_HOME="{{local_orchestrator_home}}" node "{{local_cli}}" stop --force >/dev/null 2>&1 || true; fi
    @rm -rf "{{local_orchestrator_home}}" "{{local_shim_root}}"
    @printf 'removed %s\n' "{{local_orchestrator_home}}"
    @printf 'removed %s\n' "{{local_shim_root}}"

# Print the generated OpenCode orchestration config for inspection.
orchestrator-opencode-config *args: orchestrator-build
    node dist/cli.js opencode --print-config {{args}}

# Start OpenCode in constrained orchestration mode.
orchestrator-opencode *args: orchestrator-build
    node dist/cli.js opencode {{args}}

# Check local worker CLI availability from the current build.
orchestrator-doctor: orchestrator-build
    node dist/cli.js doctor

# Show the current daemon status. Pass --verbose or --json for observability output.
orchestrator-status *args: orchestrator-build
    node dist/cli.js status {{args}}

# Show session and run observability output.
orchestrator-runs *args: orchestrator-build
    node dist/cli.js runs {{args}}

# Open the interactive terminal observability dashboard.
orchestrator-watch *args: orchestrator-build
    node dist/cli.js watch {{args}}

# Explicitly start the daemon. MCP clients also auto-start it via node dist/cli.js.
orchestrator-start: orchestrator-build
    node dist/cli.js start

# Stop the daemon. Pass --force to cancel active runs first.
orchestrator-stop *args: orchestrator-build
    node dist/cli.js stop {{args}}

# Restart the daemon so it picks up the current build.
orchestrator-restart: orchestrator-build
    node dist/cli.js restart --force

# Preview terminal run pruning for runs older than the requested age.
orchestrator-prune-dry-run days="30": orchestrator-build
    node dist/cli.js prune --older-than-days {{days}} --dry-run

# Prune terminal runs older than the requested age.
orchestrator-prune days="30": orchestrator-build
    node dist/cli.js prune --older-than-days {{days}}

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
