#!/usr/bin/env node
// Sync canonical AI workspace files into tool-specific projections.
//
// Canonical sources:
//   .agents/skills/{name}/SKILL.md
//   .agents/rules/{name}.md
//   .agents/agents/{name}.md
//
// Generated projections:
//   .claude/skills/
//   .claude/rules/
//   .claude/agents/
//   .cursor/rules/
//
// Usage:
//   node scripts/sync-ai-workspace.mjs
//   node scripts/sync-ai-workspace.mjs --check

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, parse, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(__filename));
const checkOnly = process.argv.includes("--check");

const generatedHeader =
  "<!-- Generated from .agents/ by scripts/sync-ai-workspace.mjs. Do not edit directly. -->\n\n";
const expectedGeneratedPaths = new Set();

function addGeneratedHeader(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) return generatedHeader + content;
  return match[0] + generatedHeader + content.slice(match[0].length);
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

function collectFiles(dir, base = dir) {
  if (!isDirectory(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, base));
    } else {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

function cleanDir(dir, predicate = () => true) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (predicate(entry, full)) {
      rmSync(full, { recursive: true, force: true });
    }
  }
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function processToolBlocks(content, targetTool) {
  const blockRegex =
    /^[ \t]*<!-- tool:([\w,-]+) -->[ \t]*\n([\s\S]*?)^[ \t]*<!-- \/tool:\1 -->[ \t]*\n?/gm;

  return content.replace(blockRegex, (_match, toolList, body) => {
    const tools = toolList.split(",").map((tool) => tool.trim());
    return tools.includes(targetTool) ? body : "";
  });
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { blocks: [], body: content };

  const blocks = [];
  let current = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) {
      current = { key: line.slice(0, line.indexOf(":")), lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  return { blocks, body: content.slice(match[0].length) };
}

function buildFrontmatter(blocks) {
  if (blocks.length === 0) return "";
  return `---\n${blocks.flatMap((block) => block.lines).join("\n")}\n---`;
}

function convertRuleForClaude(content) {
  const { blocks, body } = parseFrontmatter(content);
  if (blocks.length === 0) return addGeneratedHeader(content);
  const kept = blocks.filter(
    (block) => block.key !== "description" && block.key !== "globs" && block.key !== "alwaysApply",
  );
  return addGeneratedHeader(buildFrontmatter(kept) + body);
}

function convertRuleForCursor(content) {
  const { blocks, body } = parseFrontmatter(content);
  if (blocks.length === 0) return addGeneratedHeader(content);
  const kept = blocks.filter((block) => block.key !== "paths");
  if (!kept.some((block) => block.key === "alwaysApply")) {
    kept.push({ key: "alwaysApply", lines: ["alwaysApply: false"] });
  }
  return addGeneratedHeader(buildFrontmatter(kept) + body);
}

function readMaybe(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeOrCheck(path, content, drift) {
  expectedGeneratedPaths.add(path);
  if (checkOnly) {
    if (readMaybe(path) !== content) {
      drift.push(path);
    }
    return;
  }
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf8");
}

function copyOrCheck(src, dest, drift) {
  expectedGeneratedPaths.add(dest);
  if (checkOnly) {
    if (!existsSync(dest)) {
      drift.push(dest);
      return;
    }
    const srcBuf = readFileSync(src);
    const destBuf = readFileSync(dest);
    if (!srcBuf.equals(destBuf)) drift.push(dest);
    return;
  }
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}

function syncSkills(drift) {
  const source = join(root, ".agents", "skills");
  const dest = join(root, ".claude", "skills");
  if (!isDirectory(source)) return;

  if (!checkOnly) {
    ensureDir(dest);
    cleanDir(dest);
  }

  for (const skill of readdirSync(source).sort()) {
    const skillSource = join(source, skill);
    if (!isDirectory(skillSource)) continue;
    for (const rel of collectFiles(skillSource)) {
      const src = join(skillSource, rel);
      const out = join(dest, skill, rel);
      if (extname(src) === ".md") {
        const content = addGeneratedHeader(processToolBlocks(readFileSync(src, "utf8"), "claude"));
        writeOrCheck(out, content, drift);
      } else {
        copyOrCheck(src, out, drift);
      }
    }
  }
}

function syncRules(drift) {
  const source = join(root, ".agents", "rules");
  const claudeDest = join(root, ".claude", "rules");
  const cursorDest = join(root, ".cursor", "rules");
  if (!isDirectory(source)) return;

  if (!checkOnly) {
    ensureDir(claudeDest);
    ensureDir(cursorDest);
    cleanDir(claudeDest, (entry) => entry.endsWith(".md"));
    cleanDir(cursorDest, (entry) => entry.endsWith(".mdc"));
  }

  for (const file of readdirSync(source).filter((entry) => entry.endsWith(".md")).sort()) {
    const content = readFileSync(join(source, file), "utf8");
    const { name } = parse(file);
    writeOrCheck(join(claudeDest, file), convertRuleForClaude(content), drift);
    writeOrCheck(join(cursorDest, `${name}.mdc`), convertRuleForCursor(content), drift);
  }
}

function syncAgents(drift) {
  const source = join(root, ".agents", "agents");
  const dest = join(root, ".claude", "agents");
  if (!isDirectory(source)) return;

  if (!checkOnly) {
    ensureDir(dest);
    cleanDir(dest, (entry) => entry.endsWith(".md"));
  }

  for (const file of readdirSync(source).filter((entry) => entry.endsWith(".md")).sort()) {
    const content = addGeneratedHeader(processToolBlocks(readFileSync(join(source, file), "utf8"), "claude"));
    writeOrCheck(join(dest, file), content, drift);
  }
}

function checkStaleGeneratedFiles(drift) {
  const generatedTargets = [
    { dir: join(root, ".claude", "skills"), includes: () => true },
    { dir: join(root, ".claude", "rules"), includes: (rel) => isTopLevelFileWithExtension(rel, ".md") },
    { dir: join(root, ".claude", "agents"), includes: (rel) => isTopLevelFileWithExtension(rel, ".md") },
    { dir: join(root, ".cursor", "rules"), includes: (rel) => isTopLevelFileWithExtension(rel, ".mdc") },
  ];

  for (const target of generatedTargets) {
    for (const rel of collectFiles(target.dir)) {
      const path = join(target.dir, rel);
      if (target.includes(rel) && !expectedGeneratedPaths.has(path)) {
        drift.push(path);
      }
    }
  }
}

function isTopLevelFileWithExtension(path, extension) {
  return !path.includes("/") && !path.includes("\\") && extname(path) === extension;
}

const drift = [];
syncSkills(drift);
syncRules(drift);
syncAgents(drift);

if (checkOnly) {
  checkStaleGeneratedFiles(drift);
  drift.sort();
  if (drift.length > 0) {
    console.error("AI workspace projections are out of sync:");
    for (const path of drift) console.error(`  ${relative(root, path)}`);
    process.exit(1);
  }
  console.log("AI workspace projections are in sync.");
} else {
  console.log("AI workspace projections synced.");
}
