# Agent Orchestrator development tasks.
#
# Cross-shell invariant: recipe bodies must be either (a) a single
# external-program invocation that works in any shell (PowerShell
# Desktop, sh, cmd.exe), or (b) `[script("node")]` recipes that import
# a helper under `scripts/just/`. Never use POSIX-only shell idioms
# (`[ ... ]`, `printf`, `find`, `rm`, `|`, `&&`) in a recipe body.
#
# `set positional-arguments` is required so that `[script("node")]`
# recipes receive their arguments via `process.argv`. Without it,
# `process.argv.slice(2)` is empty inside the script body and recipe
# args are dropped on the floor. The directive does NOT permit
# parameter-taking shell recipes; those remain forbidden by the rule
# above.
#
# `just >= 1.44` required (the version that stabilized the `[script]`
# attribute). Older `just` parses with an unstable-attribute error.

set positional-arguments
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

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
[script("node")]
mcp-secret-bridge *args:
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/passthrough.mjs')).href).then(m => m.default({ script: 'scripts/mcp-secret-bridge.mjs' }));

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
[script("node")]
agent-orchestrator *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/local-cli.mjs')).href).then(m => m.default());

# Short alias for running the local branch CLI against its isolated daemon store.
[script("node")]
local *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/local-cli.mjs')).href).then(m => m.default());

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
    @node scripts/local-orchestrator-home.mjs

# Stop the local branch daemon and remove its isolated store and command shims.
agent-orchestrator-local-clean:
    @node scripts/just/local-clean.mjs

# Print the generated OpenCode orchestration config for inspection.
[script("node")]
orchestrator-opencode-config *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['opencode', '--print-config'] }));

# Start OpenCode in constrained orchestration mode.
[script("node")]
orchestrator-opencode *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['opencode'] }));

# Check local worker CLI availability from the current build.
orchestrator-doctor: orchestrator-build
    node dist/cli.js doctor

# Show the current daemon status. Pass --verbose or --json for observability output.
[script("node")]
orchestrator-status *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['status'] }));

# Show session and run observability output.
[script("node")]
orchestrator-runs *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['runs'] }));

# Open the interactive terminal observability dashboard.
[script("node")]
orchestrator-watch *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['watch'] }));

# Explicitly start the daemon. MCP clients also auto-start it via node dist/cli.js.
orchestrator-start: orchestrator-build
    node dist/cli.js start

# Stop the daemon. Pass --force to cancel active runs first.
[script("node")]
orchestrator-stop *args: orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['stop'] }));

# Restart the daemon so it picks up the current build.
orchestrator-restart: orchestrator-build
    node dist/cli.js restart --force

# Preview terminal run pruning for runs older than the requested age.
[script("node")]
orchestrator-prune-dry-run days="30": orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['prune', '--older-than-days'], suffix: ['--dry-run'] }));

# Prune terminal runs older than the requested age.
[script("node")]
orchestrator-prune days="30": orchestrator-build
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/cli.mjs')).href).then(m => m.default({ prefix: ['prune', '--older-than-days'] }));

# Show AI workspace files.
ai-files:
    @node scripts/just/ai-files.mjs

# Create or attach a worktree for a branch.
[script("node")]
worktree branch:
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/passthrough.mjs')).href).then(m => m.default({ script: 'scripts/worktree.mjs', prefix: ['create'] }));

# List all active worktrees.
worktree-list:
    node scripts/worktree.mjs list

# Remove a clean worktree by branch name.
[script("node")]
worktree-remove branch:
    const { pathToFileURL } = require('node:url'); const { resolve } = require('node:path');
    import(pathToFileURL(resolve('scripts/just/passthrough.mjs')).href).then(m => m.default({ script: 'scripts/worktree.mjs', prefix: ['remove'] }));

# Remove clean worktrees whose tracking branch no longer exists on origin.
worktree-prune:
    node scripts/worktree.mjs prune
