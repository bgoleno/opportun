#!/usr/bin/env node
// Thin CLI wrapper (#63): reads changed file paths one per line from stdin (so it has no limit
// on how many files a PR touches, unlike argv), and prints the ones that match a
// security-sensitive glob, one per line, or nothing at all. All the matching logic lives in
// security-paths.mjs and is unit-tested there; this file is deliberately just stdin/stdout glue
// so the workflow step that invokes it stays a one-liner.
import { createInterface } from 'node:readline';
import { matchingSecurityPaths } from './security-paths.mjs';

const changed = [];
for await (const line of createInterface({ input: process.stdin })) {
  const trimmed = line.trim();
  if (trimmed !== '') changed.push(trimmed);
}

for (const matched of matchingSecurityPaths(changed)) console.log(matched);
