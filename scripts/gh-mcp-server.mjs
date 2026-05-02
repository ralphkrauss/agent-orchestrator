#!/usr/bin/env node
/**
 * Minimal MCP wrapper around the GitHub CLI.
 *
 * It intentionally spawns `gh` without a shell. Use `command` for convenience
 * or `args` when exact argument boundaries matter.
 */

import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const outputLimit = Number.parseInt(process.env.MCP_OUTPUT_LIMIT ?? "120000", 10);
const defaultTimeoutMs = Number.parseInt(process.env.MCP_TIMEOUT_MS ?? "60000", 10);
const maxTimeoutMs = 300000;

const tools = [
  {
    name: "diagnose",
    description: "Check GitHub CLI availability and authentication status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "help",
    description: "Show `gh help` output for an optional command.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Optional command path, for example `pr` or `api`.",
        },
      },
    },
  },
  {
    name: "execute",
    description: "Run a bounded GitHub CLI command without a shell.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Arguments after `gh`, for example `pr list --state open --json number,title`.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Exact argument array after `gh`. Prefer this when quoting is important.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Defaults to 60000 and is capped at 300000.",
        },
      },
    },
  },
];

const server = new Server(
  { name: "agent-orchestrator-gh", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === "diagnose") {
      const version = await runGh(["--version"], defaultTimeoutMs);
      const auth = await runGh(["auth", "status"], defaultTimeoutMs);
      return jsonResponse({ version, auth });
    }

    if (request.params.name === "help") {
      const args = ["help", ...tokenize(String(request.params.arguments?.command ?? ""))];
      const result = await runGh(args, defaultTimeoutMs);
      return jsonResponse(result);
    }

    if (request.params.name === "execute") {
      const args = normalizeExecuteArgs(request.params.arguments ?? {});
      enforceGuardrails(args);
      const timeoutMs = normalizeTimeout(request.params.arguments?.timeout_ms);
      const result = await runGh(args, timeoutMs);
      return jsonResponse(result);
    }

    return jsonResponse({ ok: false, error: `Unknown tool: ${request.params.name}` }, true);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

function normalizeExecuteArgs(input) {
  if (Array.isArray(input.args)) {
    const args = input.args.map((value) => String(value)).filter((value) => value.length > 0);
    if (args.length > 0) return args;
  }

  if (typeof input.command === "string" && input.command.trim() !== "") {
    return tokenize(input.command);
  }

  throw new Error("Provide either `command` or `args`.");
}

function enforceGuardrails(args) {
  const commandText = args.join(" ").toLowerCase();
  for (const pattern of blockedPatterns()) {
    if (matchesPattern(commandText, pattern.toLowerCase())) {
      throw new Error(`Blocked gh command pattern: ${pattern}`);
    }
  }
}

function blockedPatterns() {
  const configured = process.env.MCP_BLOCKED_PATTERNS?.trim();
  const value =
    configured ||
    "auth token,auth login,auth logout,auth refresh,repo delete,repo archive,ssh-key delete,gpg-key delete,secret set,secret delete";
  return value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function matchesPattern(text, pattern) {
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", ".*")}$`);
    return regex.test(text);
  }

  return text.includes(pattern);
}

function normalizeTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultTimeoutMs;
  }

  return Math.min(Math.floor(value), maxTimeoutMs);
}

function runGh(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command: ["gh", ...args],
        exit_code: null,
        signal: null,
        timed_out: false,
        stdout: "",
        stderr: redact(error.message),
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        command: ["gh", ...args],
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (next.length <= outputLimit) return next;
  return `${next.slice(0, outputLimit)}\n[output truncated at ${outputLimit} characters]\n`;
}

function tokenize(input) {
  const args = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in command.");
  if (current.length > 0) args.push(current);
  return args;
}

function jsonResponse(payload, isError = false) {
  return {
    content: [{ type: "text", text: `${JSON.stringify(payload, null, 2)}\n` }],
    isError,
  };
}

function redact(value) {
  let output = String(value);
  for (const token of [process.env.GITHUB_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_PERSONAL_ACCESS_TOKEN]) {
    if (token && token.length > 8) {
      output = output.split(token).join("[redacted]");
    }
  }

  return output.replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, "[redacted]");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
