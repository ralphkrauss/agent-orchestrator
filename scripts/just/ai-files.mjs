#!/usr/bin/env node
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { sep } from 'node:path';

const ROOTS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.agents',
  '.claude',
  '.cursor',
  '.codex',
  '.githooks',
  'docs/development',
];
const MAX_DEPTH = 4;

const results = [];
for (const root of ROOTS) {
  walk(root, 0);
}

results.sort();
process.stdout.write(results.map(toSlash).join('\n'));
if (results.length > 0) process.stdout.write('\n');

function walk(entryPath, depth) {
  let entryStat;
  try {
    entryStat = lstatSync(entryPath);
  } catch {
    return;
  }
  if (entryStat.isSymbolicLink()) {
    return;
  }
  if (entryStat.isFile()) {
    results.push(entryPath);
    return;
  }
  if (!entryStat.isDirectory()) {
    return;
  }
  if (depth >= MAX_DEPTH) {
    return;
  }
  let children;
  try {
    children = readdirSync(entryPath);
  } catch {
    return;
  }
  for (const child of children) {
    walk(joinPath(entryPath, child), depth + 1);
  }
}

function joinPath(parent, child) {
  if (parent.endsWith('/') || parent.endsWith(sep)) {
    return `${parent}${child}`;
  }
  return `${parent}/${child}`;
}

function toSlash(p) {
  return sep === '/' ? p : p.split(sep).join('/');
}
