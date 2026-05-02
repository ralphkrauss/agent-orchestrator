#!/usr/bin/env node
/**
 * Launch an MCP server command after mapping canonical user-level secret names
 * to the child-process env names expected by the server.
 *
 * Secret sources for canonical names, in precedence order:
 * 1. Non-blank values in ~/.config/agent-orchestrator/mcp-secrets.env
 *    (override with AGENT_ORCHESTRATOR_MCP_SECRETS_FILE)
 * 2. Current process environment
 * 3. `gh auth token` for GITHUB_TOKEN/GH_TOKEN
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const defaultSecretsFile = join(os.homedir(), ".config", "agent-orchestrator", "mcp-secrets.env");

const profiles = {
  github: {
    mappings: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_TOKEN" },
    required: ["GITHUB_TOKEN"],
  },
  gh: {
    mappings: { GH_TOKEN: "GITHUB_TOKEN" },
    required: [],
    defaults: {
      MCP_BLOCKED_PATTERNS:
        "auth token,auth login,auth logout,auth refresh,repo delete,repo archive,ssh-key delete,gpg-key delete,secret set,secret delete",
      MCP_DESCRIPTION: "GitHub CLI wrapper for repos, pull requests, issues, actions, and GitHub API calls",
      MCP_EXAMPLES:
        '["pr list --state open --json number,title","repo view --json nameWithOwner,url","run list --limit 5","api repos/ralphkrauss/agent-orchestrator/actions/runs --jq .workflow_runs[0].status"]',
    },
  },
};

const helpText = `Usage:
  node scripts/mcp-secret-bridge.mjs <profile> -- <command> [args...]
  node scripts/mcp-secret-bridge.mjs --list-profiles
  node scripts/mcp-secret-bridge.mjs --print-secrets-path
  node scripts/mcp-secret-bridge.mjs --help

Default secret file:
  ${defaultSecretsFile}

Override with:
  AGENT_ORCHESTRATOR_MCP_SECRETS_FILE=/custom/path.env`;

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText);
    return;
  }

  if (args.includes("--list-profiles")) {
    console.log(Object.keys(profiles).sort().join("\n"));
    return;
  }

  if (args.includes("--print-secrets-path")) {
    console.log(resolveSecretsPath());
    return;
  }

  const separatorIndex = args.indexOf("--");
  if (separatorIndex <= 0 || separatorIndex === args.length - 1) {
    fail("Expected: <profile> -- <command> [args...]");
  }

  const profileName = args[0];
  const profile = profiles[profileName];
  if (!profile) {
    fail(`Unknown profile '${profileName}'. Use --list-profiles to inspect supported profiles.`);
  }

  const command = args[separatorIndex + 1];
  const commandArgs = args.slice(separatorIndex + 2);
  const secrets = loadSecrets();
  const childEnv = { ...process.env };

  for (const [targetName, sourceName] of Object.entries(profile.mappings)) {
    const sourceValue = secrets[sourceName];
    if (hasValue(sourceValue)) {
      childEnv[targetName] = sourceValue;
    }
  }

  for (const [targetName, defaultValue] of Object.entries(profile.defaults ?? {})) {
    if (!hasValue(childEnv[targetName])) {
      childEnv[targetName] = defaultValue;
    }
  }

  const missing = profile.required.filter((sourceName) => !hasValue(secrets[sourceName]));
  if (missing.length > 0) {
    fail(
      `Missing required secret(s) for ${profileName}: ${missing.join(", ")}. ` +
        `Run gh auth login, export GITHUB_TOKEN, or set ${resolveSecretsPath()}.`,
    );
  }

  const expandedArgs = commandArgs.map((arg) => interpolate(arg, childEnv));
  await spawnAndExit(command, expandedArgs, childEnv);
}

function loadSecrets() {
  const fileSecrets = readSecretFile(resolveSecretsPath());
  const secrets = { ...process.env };
  for (const [key, value] of Object.entries(fileSecrets)) {
    if (hasValue(value)) {
      secrets[key] = value;
    }
  }

  if (!hasValue(secrets.GITHUB_TOKEN) && hasValue(secrets.GH_TOKEN)) {
    secrets.GITHUB_TOKEN = secrets.GH_TOKEN;
  }

  if (!hasValue(secrets.GH_TOKEN) && hasValue(secrets.GITHUB_TOKEN)) {
    secrets.GH_TOKEN = secrets.GITHUB_TOKEN;
  }

  if (!hasValue(secrets.GITHUB_TOKEN)) {
    const token = readGhAuthToken();
    if (hasValue(token)) {
      secrets.GITHUB_TOKEN = token;
      secrets.GH_TOKEN = token;
    }
  }

  return secrets;
}

function resolveSecretsPath() {
  const override = process.env.AGENT_ORCHESTRATOR_MCP_SECRETS_FILE?.trim();
  return override ? resolve(override) : defaultSecretsFile;
}

function readSecretFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = unquote(match[2]);
  }
  return result;
}

function readGhAuthToken() {
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  });

  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function interpolate(value, env) {
  return value.replace(/@@([A-Za-z_][A-Za-z0-9_]*)@@/g, (_match, key) => env[key] ?? "");
}

function spawnAndExit(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: "inherit",
    });

    const stopForwarding = forwardSignals(child);

    child.on("exit", (code, signal) => {
      stopForwarding();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exit(code ?? 0);
    });

    child.on("error", (error) => {
      stopForwarding();
      fail(`Failed to start ${command}: ${error.message}`);
    });

    child.on("close", () => resolve());
  });
}

function forwardSignals(childProcess) {
  const handlers = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      childProcess.kill(signal);
    };
    handlers.push([signal, handler]);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
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

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function fail(message) {
  console.error(`[mcp-secret-bridge] ${message}`);
  process.exit(1);
}
