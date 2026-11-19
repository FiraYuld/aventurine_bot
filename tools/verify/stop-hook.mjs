#!/usr/bin/env node
// Claude Code Stop hook: when the agent finishes a turn with uncommitted changes in
// src/, api/ or tests/, run `npm run verify` (typecheck + all tests incl. the webhook
// dry run). On failure exit 2 so the agent sees the output and fixes it.
// Never loops: a turn that was already continued by this hook is let through.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  // no or invalid stdin: treat as a normal stop
}
if (input.stop_hook_active) process.exit(0);

let changed = "";
try {
  changed = execFileSync("git", ["status", "--porcelain", "--", "src", "api", "tests", "package.json"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {
  process.exit(0); // not a git checkout: nothing to judge
}
if (!changed) process.exit(0);

const run = spawnSync("npm", ["run", "--silent", "verify"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (run.status === 0) process.exit(0);

const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.split("\n");
const tail = out.slice(-80).join("\n");
process.stderr.write(
  `npm run verify failed (uncommitted changes in src/api/tests). Fix before finishing:\n${tail}\n`,
);
process.exit(2);
