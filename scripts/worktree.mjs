#!/usr/bin/env node
/**
 * Cross-platform git worktree management for this repository.
 *
 * Subcommands:
 *   create <branch>  - create or attach a worktree for a branch
 *   remove <branch>  - remove a worktree
 *   list             - list all worktrees
 *   prune            - remove clean worktrees whose remote branch is gone
 *
 * Usage:
 *   node scripts/worktree.mjs create my-feature-branch
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const REPO_NAME = "agent-orchestrator-mcp";
const WORKTREE_BASE = join(homedir(), "worktrees-agent-orchestrator-mcp");
const MAIN_BRANCH = "main";

function git(args, opts = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (error) {
    if (opts.suppressErrors) return "";
    die(`git ${args[0]} failed: ${error.stderr || error.message}`);
  }
}

function gitIn(dir, args, opts = {}) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (opts.suppressErrors) return "";
    die(`git -C ${dir} ${args[0]} failed: ${error.stderr || error.message}`);
  }
}

function tryPull(dir) {
  try {
    execFileSync("git", ["-C", dir, "pull", "--ff-only"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    console.log("Pull skipped (no upstream or diverged).");
  }
}

function normalizePath(path) {
  return resolve(path);
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function preflight() {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    die("not inside a git repository.");
  }

  const toplevel = git(["rev-parse", "--show-toplevel"]);
  const repoName = basename(toplevel);
  if (repoName !== REPO_NAME) {
    die(`expected repository '${REPO_NAME}', but you're in '${repoName}'.`);
  }

  const gitCommon = normalizePath(git(["rev-parse", "--git-common-dir"]));
  const gitDir = normalizePath(git(["rev-parse", "--git-dir"]));
  if (gitCommon !== gitDir) {
    die("run this from the main repository, not from inside a worktree.");
  }
}

function parseWorktreeList() {
  const raw = git(["worktree", "list", "--porcelain"], { suppressErrors: true });
  if (!raw) return [];

  const entries = [];
  let current = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }

  return entries;
}

function create(branch) {
  validateBranchName(branch);
  preflight();

  mkdirSync(WORKTREE_BASE, { recursive: true });

  const worktreePath = join(WORKTREE_BASE, branch);
  const absPath = normalizePath(worktreePath);
  const entries = parseWorktreeList();

  const existingWorktree = entries.find(
    (entry) => normalizePath(entry.worktree) === absPath,
  );
  if (existingWorktree) {
    console.log(`Worktree already exists at ${absPath}`);
    console.log("Pulling latest changes...");
    tryPull(absPath);
    console.log(`\n${absPath}`);
    return;
  }

  if (existsSync(absPath)) {
    die(
      `directory '${absPath}' exists but is not a registered worktree.\n` +
        `If stale, remove it manually after checking contents: rm -rf ${absPath}`,
    );
  }

  const branchRef = `refs/heads/${branch}`;
  const checkedOut = entries.find((entry) => entry.branch === branchRef);
  if (checkedOut) {
    die(`branch '${branch}' is already checked out in: ${checkedOut.worktree}`);
  }

  console.log("Fetching from origin...");
  git(["fetch", "origin", "--prune"], { suppressErrors: true });

  const hasLocal = git(["branch", "--list", branch], { suppressErrors: true }).trim();
  const hasRemote = git(["branch", "-r", "--list", `origin/${branch}`], {
    suppressErrors: true,
  }).trim();

  if (hasLocal) {
    console.log(`Branch '${branch}' found locally.`);
    git(["worktree", "add", worktreePath, branch]);
    console.log("Pulling latest changes...");
    tryPull(absPath);
  } else if (hasRemote) {
    console.log(`Branch '${branch}' found on origin.`);
    git(["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`]);
  } else {
    const base = resolveBaseBranch();
    console.log(`Branch '${branch}' not found locally or on origin.`);
    console.log(`Creating it from ${base}.`);
    git(["worktree", "add", "-b", branch, worktreePath, base]);
  }

  console.log(`Worktree ready at ${absPath}`);
}

function list() {
  const output = git(["worktree", "list"]);
  console.log(output);
}

function remove(branch) {
  validateBranchName(branch);

  const worktreePath = join(WORKTREE_BASE, branch);
  const absPath = normalizePath(worktreePath);
  const entries = parseWorktreeList();
  const found = entries.find((entry) => normalizePath(entry.worktree) === absPath);
  if (!found) {
    die(`no worktree found at '${absPath}'.`);
  }

  const status = gitIn(absPath, ["status", "--porcelain"], { suppressErrors: true });
  if (status) {
    die(`worktree '${absPath}' has uncommitted changes. Commit, stash, or clean it first.`);
  }

  console.log(`Removing worktree: ${absPath}`);
  git(["worktree", "remove", absPath]);
  console.log("Worktree removed.");
}

async function prune() {
  preflight();

  console.log("Fetching from origin...");
  git(["fetch", "origin", "--prune"]);

  const entries = parseWorktreeList();
  const secondaryEntries = entries.slice(1);
  const candidates = [];
  const skipped = [];

  for (const entry of secondaryEntries) {
    if (!entry.branch) continue;

    const branchMatch = entry.branch.match(/^refs\/heads\/(.+)$/);
    if (!branchMatch) continue;
    const branchName = branchMatch[1];

    const hasRemote = git(["branch", "-r", "--list", `origin/${branchName}`], {
      suppressErrors: true,
    }).trim();

    if (hasRemote) continue;

    const dirtyOutput = gitIn(entry.worktree, ["status", "--porcelain"], {
      suppressErrors: true,
    }).trim();

    if (dirtyOutput) {
      skipped.push(`${entry.worktree} (branch: ${branchName}) - has uncommitted changes`);
    } else {
      candidates.push({ path: entry.worktree, branch: branchName });
    }
  }

  if (skipped.length > 0) {
    console.log("\nSkipped:");
    for (const item of skipped) {
      console.log(`  ${item}`);
    }
  }

  if (candidates.length === 0) {
    console.log("\nNo worktrees to prune.");
    return;
  }

  console.log("\nThe following worktrees have no remote tracking branch:");
  for (const candidate of candidates) {
    console.log(`  ${candidate.path} (branch: ${candidate.branch})`);
  }
  console.log("");

  if (!process.stdin.isTTY) {
    console.log("Run from an interactive shell to confirm removal.");
    return;
  }

  const answer = await prompt(`Remove these ${candidates.length} worktrees? [y/N] `);
  if (answer !== "y" && answer !== "Y") {
    console.log("Aborted.");
    return;
  }

  let removed = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      execFileSync("git", ["worktree", "remove", candidate.path], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(`  Removed: ${candidate.path}`);
      removed += 1;
    } catch {
      console.error(`  Failed:  ${candidate.path}`);
      failed += 1;
    }
  }

  console.log(`\nDone. Removed ${removed} worktree(s).`);
  if (failed > 0) {
    console.log(`Failed to remove ${failed} worktree(s).`);
  }
}

function resolveBaseBranch() {
  const remoteMain = git(["rev-parse", "--verify", `origin/${MAIN_BRANCH}`], {
    suppressErrors: true,
  });
  if (remoteMain) return `origin/${MAIN_BRANCH}`;

  const localMain = git(["rev-parse", "--verify", MAIN_BRANCH], { suppressErrors: true });
  if (localMain) return MAIN_BRANCH;

  return "HEAD";
}

function validateBranchName(branch) {
  if (!branch) {
    die("branch name is required.");
  }

  if (branch.startsWith("-")) {
    die("branch name cannot start with '-'.");
  }

  try {
    execFileSync("git", ["check-ref-format", "--branch", branch], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    die(`invalid branch name '${branch}'.`);
  }
}

function prompt(question) {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer);
    });
  });
}

const args = process.argv.slice(2);
const subcommand = args[0];

switch (subcommand) {
  case "create": {
    create(args[1]);
    break;
  }
  case "remove": {
    remove(args[1]);
    break;
  }
  case "list": {
    list();
    break;
  }
  case "prune": {
    await prune();
    break;
  }
  default: {
    die("usage: node scripts/worktree.mjs <create|remove|list|prune> [branch]");
  }
}
