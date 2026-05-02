#!/usr/bin/env node
/**
 * Cross-platform launcher for MCP servers distributed via `npx`.
 *
 * Native Windows cannot execute `npx` directly from shared MCP configs because
 * it is typically exposed as a `.cmd` shim. This wrapper keeps project configs
 * portable by routing Windows launches through `cmd /c`.
 */

import { spawn } from "node:child_process";

const npxArgs = process.argv.slice(2);

if (npxArgs.length === 0) {
  fail("Expected at least one npx argument. Example: node scripts/run-npx-mcp.mjs @playwright/mcp@latest");
}

const isWindows = process.platform === "win32";
const command = isWindows ? "cmd" : "npx";
const args = isWindows ? ["/c", "npx", ...npxArgs] : npxArgs;

const child = spawn(command, args, {
  env: process.env,
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
  fail(`Failed to start npx command: ${error.message}`);
});

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

function fail(message) {
  console.error(`[run-npx-mcp] ${message}`);
  process.exit(1);
}
