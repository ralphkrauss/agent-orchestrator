#!/usr/bin/env node
// Manage repository-local AI workspace git hooks.
//
// Usage:
//   node scripts/ai-hooks.mjs status
//   node scripts/ai-hooks.mjs enable
//   node scripts/ai-hooks.mjs disable

import { existsSync, readdirSync, statSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(__filename));
const command = process.argv[2] || "status";
const force = process.argv.includes("--force");
const hooksPath = ".githooks";
const hooksDir = join(root, hooksPath);

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });

  if (options.allowFailure) return result;

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }

  return result.stdout ? result.stdout.trim() : "";
}

function ensureGitRepo() {
  git(["rev-parse", "--show-toplevel"]);
}

function currentHooksPath() {
  const result = git(["config", "--local", "--get", "core.hooksPath"], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function listHooks() {
  if (!existsSync(hooksDir)) return [];
  return readdirSync(hooksDir)
    .map((entry) => join(hooksDir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function makeHooksExecutable() {
  if (process.platform === "win32") return;
  for (const file of listHooks()) {
    chmodSync(file, 0o755);
  }
}

function status() {
  ensureGitRepo();
  const current = currentHooksPath();
  const hooks = listHooks().map((path) => relative(root, path));

  console.log(`core.hooksPath: ${current || "(not set)"}`);
  console.log(`hooks directory: ${existsSync(hooksDir) ? hooksPath : "(missing)"}`);
  if (hooks.length === 0) {
    console.log("hooks: (none found)");
  } else {
    console.log("hooks:");
    for (const hook of hooks) console.log(`  ${hook}`);
  }
}

function enable() {
  ensureGitRepo();

  if (!existsSync(hooksDir)) {
    throw new Error(`Cannot enable hooks: ${hooksPath}/ does not exist.`);
  }

  const hooks = listHooks();
  if (hooks.length === 0) {
    throw new Error(`Cannot enable hooks: ${hooksPath}/ contains no hook files.`);
  }

  const current = currentHooksPath();
  if (current && current !== hooksPath && !force) {
    throw new Error(
      `Refusing to overwrite existing core.hooksPath (${current}). ` +
        "Inspect it first, or rerun with --force if replacing it is intended.",
    );
  }

  makeHooksExecutable();
  git(["config", "--local", "core.hooksPath", hooksPath], { stdio: "inherit" });
  console.log(`Enabled repository hooks: core.hooksPath=${hooksPath}`);
}

function disable() {
  ensureGitRepo();

  const current = currentHooksPath();
  if (!current) {
    console.log("core.hooksPath is already unset.");
    return;
  }

  if (current !== hooksPath && !force) {
    throw new Error(
      `Refusing to unset non-kit core.hooksPath (${current}). ` +
        "Inspect it first, or rerun with --force if removing it is intended.",
    );
  }

  git(["config", "--local", "--unset", "core.hooksPath"], { stdio: "inherit" });
  console.log("Disabled repository hooks: core.hooksPath unset.");
}

try {
  if (command === "status") status();
  else if (command === "enable") enable();
  else if (command === "disable") disable();
  else {
    throw new Error(`Unknown command "${command}". Use status, enable, or disable.`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
