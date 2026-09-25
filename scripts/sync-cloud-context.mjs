#!/usr/bin/env node
// sync-cloud-context.mjs
// ---------------------------------------------------------------------------
// Mirror the laptop-only knowledge layers INTO the repo so a CLOUD session —
// which is an isolated git clone and never sees ~/.claude — wakes up knowing
// Phoenix. A local session ignores the mirror; it has the live originals.
//
// Copies, into <repo>/.claude/cloud-context/ :
//   memory-mirror/           <- ~/.claude/projects/<slug>/memory/   (index + every file)
//   global-standing-rules.md <- ~/.claude/CLAUDE.md                 (verbatim)
//   README.md                <- generated metadata (counts, bytes, when)
//
// NOTE: the subdir is memory-mirror/, NOT memory/, on purpose — .gitignore has a
// bare `memory/` rule (protects against committing a real auto-memory dir), so a
// folder literally named `memory` here would be silently ignored and never ship.
//
// The output always lands in the checkout THIS script lives in (resolved from
// import.meta.url), so running it from the control-tower primary refreshes the
// primary's mirror and running it from a worktree refreshes that worktree's.
//
// Refresh + ship: run this, then commit the mirror through the normal PR flow.
// Cloud sees the mirror as of the last commit on the branch it clones (usually
// main), so the mirror is only as fresh as its last merged refresh.
//
// Env overrides: PHX_MEMORY_DIR, PHX_GLOBAL_RULES (absolute paths).
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, '.claude', 'cloud-context');
const OUT_MEMORY = path.join(OUT_DIR, 'memory-mirror');

const MEMORY_SLUG = 'F--Phoenix-Workforce-phoenix-workforce';
const MEMORY_DIR =
  process.env.PHX_MEMORY_DIR ||
  path.join(os.homedir(), '.claude', 'projects', MEMORY_SLUG, 'memory');
const GLOBAL_RULES =
  process.env.PHX_GLOBAL_RULES || path.join(os.homedir(), '.claude', 'CLAUDE.md');

function fail(msg) {
  console.error(`sync-cloud-context: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(MEMORY_DIR)) {
  fail(
    `memory source not found: ${MEMORY_DIR}\n` +
      `  (a cloud session HAS no local memory — run this from the laptop, not the cloud.)`,
  );
}

// 1) Mirror the memory directory faithfully: wipe the old mirror so a memory
//    file deleted upstream does not linger, then copy every .md across.
fs.rmSync(OUT_MEMORY, { recursive: true, force: true });
fs.mkdirSync(OUT_MEMORY, { recursive: true });

const memFiles = fs
  .readdirSync(MEMORY_DIR, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
  .map((d) => d.name)
  .sort();

let bytes = 0;
for (const name of memFiles) {
  const buf = fs.readFileSync(path.join(MEMORY_DIR, name));
  fs.writeFileSync(path.join(OUT_MEMORY, name), buf);
  bytes += buf.length;
}

// 2) The global standing rules, verbatim. Missing is a warning, not fatal —
//    the memory mirror is still worth shipping on its own.
let rulesBytes = 0;
if (fs.existsSync(GLOBAL_RULES)) {
  const buf = fs.readFileSync(GLOBAL_RULES);
  fs.writeFileSync(path.join(OUT_DIR, 'global-standing-rules.md'), buf);
  rulesBytes = buf.length;
} else {
  console.warn(`sync-cloud-context: WARN global rules not found: ${GLOBAL_RULES}`);
}

// 3) A generated README so the mirror is self-explaining and reproducible.
const whenCairo = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo',
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date());
const hasIndex = memFiles.some((n) => n === 'MEMORY.md');

const readme = `# Cloud context mirror — generated, do not hand-edit

A **cloud** session is an isolated git clone of this repo. It never sees the laptop's
\`~/.claude/\` — so the two knowledge layers a **local** session wakes up with are missing:
the global standing rules and the entire auto-memory. This directory mirrors both INTO the
repo so a cloud session can read them, giving it the same two-tier recall a local session has.

**A cloud session, before its first substantive answer, should read:**
- \`memory-mirror/${hasIndex ? 'MEMORY.md' : '(index missing — read the files directly)'}\` — the memory index (the map of every known fact)
- \`global-standing-rules.md\` — the owner's global standing rules (the machine/RAM sections are laptop-only; ignore them in cloud)
- then grep \`memory-mirror/\` for any specific fact, exactly as local recall does on demand.

**Local sessions ignore this mirror** — they have the live originals under \`~/.claude/\`.

## What is here (generated ${whenCairo} Cairo)
- Memory files: **${memFiles.length}** (${(bytes / 1024 / 1024).toFixed(2)} MB)
- Global standing rules: ${rulesBytes ? `${(rulesBytes / 1024).toFixed(1)} KB` : 'MISSING at generation time'}

## Refreshing
Run from a **local** checkout (it needs \`~/.claude/\`):

    node scripts/sync-cloud-context.mjs

then commit the change through the normal PR flow. Cloud sees the mirror as of the last commit
on the branch it clones (usually \`main\`), so it is only as fresh as its last merged refresh.
Source: \`~/.claude/projects/${MEMORY_SLUG}/memory/\` and \`~/.claude/CLAUDE.md\`.
`;
fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme);

console.log(
  `sync-cloud-context: mirrored ${memFiles.length} memory files ` +
    `(${(bytes / 1024 / 1024).toFixed(2)} MB) + ` +
    `${rulesBytes ? 'global rules' : 'NO global rules'} -> ${path.relative(REPO_ROOT, OUT_DIR)}`,
);
