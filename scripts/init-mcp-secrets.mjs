#!/usr/bin/env node
/**
 * Initialize the optional user-level MCP secret file.
 *
 * Target file:
 *   ~/.config/agent-orchestrator/mcp-secrets.env
 *
 * The MCP bridge can also use process env or `gh auth token`, so this file is
 * a convenience for explicit local configuration rather than a requirement.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";

const defaultTargetPath = join(os.homedir(), ".config", "agent-orchestrator", "mcp-secrets.env");

const templateText = `# Shared MCP secret contract for agent-orchestrator.
#
# This file lives outside the repo so one developer-owned copy works across
# worktrees, tools, and fresh clones.
#
# Target path:
#   ~/.config/agent-orchestrator/mcp-secrets.env
#
# Secret-bearing MCP servers read this path through
# scripts/mcp-secret-bridge.mjs. Non-blank values here override process env for
# canonical names so stale shell exports do not silently win.

# GitHub PAT used by both the official GitHub MCP server and the gh CLI wrapper.
# If this is blank, the bridge falls back to process env and then gh auth token.
GITHUB_TOKEN=
`;

const helpText = `Usage:
  node scripts/init-mcp-secrets.mjs
  node scripts/init-mcp-secrets.mjs --print-path
  node scripts/init-mcp-secrets.mjs --help

Initializes or updates the optional user-level MCP secret file at:
  ${defaultTargetPath}

Environment override:
  AGENT_ORCHESTRATOR_MCP_SECRETS_FILE=/custom/path.env`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(helpText);
  process.exit(0);
}

const targetPath = resolveTargetPath();
if (args.includes("--print-path")) {
  console.log(targetPath);
  process.exit(0);
}

const existingText = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
const existing = parseEnv(existingText);
const template = parseEnv(templateText);
const values = new Map(template.entries);

for (const [key, entry] of existing.entries) {
  if (entry.value !== "") {
    values.set(key, entry);
  }
}

const rendered = renderTemplate(templateText, values);
mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, rendered, { mode: 0o600 });
try {
  chmodSync(targetPath, 0o600);
} catch {
  // chmod is best-effort on platforms where it is a no-op.
}

console.log(`Shared MCP secrets ${existingText ? "updated" : "created"}: ${targetPath}`);
console.log("Set GITHUB_TOKEN there, export it in your shell, or rely on local gh auth.");

function resolveTargetPath() {
  const override = process.env.AGENT_ORCHESTRATOR_MCP_SECRETS_FILE?.trim();
  return override ? resolve(override) : defaultTargetPath;
}

function parseEnv(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    entries.set(match[1], { raw: match[2], value: unquote(match[2]) });
  }
  return { entries };
}

function renderTemplate(text, values) {
  return text.replace(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm, (line, key) => {
    const entry = values.get(key);
    return entry ? `${key}=${entry.raw}` : line;
  });
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
