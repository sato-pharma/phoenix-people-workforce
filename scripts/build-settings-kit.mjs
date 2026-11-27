#!/usr/bin/env node
// Rebuilds the Claude settings kit that lives in F:\Claude Settings Kit.
//
//   node ~/.claude/scripts/build-settings-kit.mjs --out <folder>          # stage a kit, report the diff
//   node ~/.claude/scripts/build-settings-kit.mjs --out <folder> --quiet  # same, fewer lines
//
// WHY IT EXISTS. Before 2026-09-21 the kit was assembled BY HAND, every time, and the 121 sha256
// hashes in manifest.json with it. That is how the 18 Sep kit came to carry a stale CLAUDE.md and
// roll two of the owner's later rules back when he applied it on 21 Sep. Nothing about a hand build
// tells you what changed; this prints it.
//
// WHAT IT COPIES IS A CURATED LIST, NOT A SCAN. The list comes from the PREVIOUS manifest.json
// (kit path, destination, mode) plus the ADDITIONS below. That is deliberate: ~/.claude/scripts also
// holds logs, .dll payloads, registry backups and one-off credential-rotation scripts, and a
// directory scan would sweep them all into an archive the owner copies to Google Drive. To add a
// file to the kit, add it to ADDITIONS once - the next build inherits it from that manifest.
//
// NO SECRETS, EVER (RESTORE.md rule 4). Every candidate is checked by name AND by content, and a
// hit ABORTS the build rather than warning - see SECRET_NAME / SECRET_CONTENT.
//
// It writes only into --out. It never touches ~/.claude, and never deletes anything.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HOME = process.env.USERPROFILE || process.env.HOME;
const CLAUDE = path.join(HOME, ".claude");
const PREV_MANIFEST = process.env.PHX_KIT_PREV ||
  "F:/Claude Settings Kit/claude-settings-kit-2026-09-21/manifest.json";

// Files the previous manifest does not know about yet. kit = path inside the kit, dest = where it
// belongs on a machine, mode = how restore.ps1 treats it:
//   overwrite   - the kit's copy wins (code the owner does not hand-edit per machine)
//   add-missing - only written where absent; a newer copy on the machine always wins
//   reference   - never written at all; it is there to read
const ADDITIONS = [
  {
    // This builder itself, so the next machine can rebuild the kit instead of hand-assembling one.
    kit: "files/home-claude/scripts/build-settings-kit.mjs",
    dest: String.raw`%USERPROFILE%\.claude\scripts\build-settings-kit.mjs`,
    mode: "overwrite",
  },
  {
    kit: "files/home-claude/scripts/xlsx-snapshot-fetch.ps1",
    dest: String.raw`%USERPROFILE%\.claude\scripts\xlsx-snapshot-fetch.ps1`,
    mode: "overwrite",
  },
  {
    // The weekly review's settled findings. add-missing, NOT overwrite: each key is a recorded
    // owner decision, so a machine that has settled more than this kit knows about keeps its own.
    kit: "files/home-claude/reviews/accepted.json",
    dest: String.raw`%USERPROFILE%\.claude\reviews\accepted.json`,
    mode: "add-missing",
  },
];

// Windows Task Scheduler exports, added as reference entries by --tasks-from <folder>. The kit has
// never restored these and still does not: re-registering a task is an elevated, machine-specific
// act, and the XML carries this laptop's own user SID. They are here so a new machine can see what
// was meant to run the scripts it just received.
const TASKS_KIT_DIR = "files/windows-tasks";

const SECRET_NAME = /(credential|\.env|secret|token|password|apikey|api-key|\.pem$|\.key$|id_(rsa|ed25519)$)/i;
const SECRET_CONTENT = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, "OpenAI-style key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bsbp_[a-f0-9]{40,}/, "Supabase access token"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/, "connection string with a password"],
];

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const OUT = argOf("--out");
const TASKS_FROM = argOf("--tasks-from");
const QUIET = args.includes("--quiet");
if (!OUT) { console.error("usage: build-settings-kit.mjs --out <folder> [--tasks-from <folder>]"); process.exit(2); }

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const expand = (p) => p.replace(/%USERPROFILE%/gi, HOME);

const prev = JSON.parse(fs.readFileSync(PREV_MANIFEST, "utf8"));
const prevHash = new Map(prev.files.map((f) => [f.kit, f.sha256]));

const spec = [...prev.files.map((f) => ({ kit: f.kit, dest: f.dest, mode: f.mode })), ...ADDITIONS];

// Task XMLs, if any were exported for this build.
if (TASKS_FROM) {
  for (const name of fs.readdirSync(TASKS_FROM).filter((n) => n.toLowerCase().endsWith(".xml") || n.toLowerCase().endsWith(".md")).sort()) {
    spec.push({
      kit: `${TASKS_KIT_DIR}/${name}`,
      dest: "(reference only - a Windows Task Scheduler export; restore.ps1 never writes it)",
      mode: "reference",
      from: path.join(TASKS_FROM, name),
    });
  }
}

const seen = new Set();
for (const s of spec) {
  if (seen.has(s.kit)) { console.error(`DUPLICATE kit path in the spec: ${s.kit}`); process.exit(1); }
  seen.add(s.kit);
}

const files = [];
const changed = [];
const added = [];
const missing = [];

for (const s of spec) {
  const src = s.from || expand(s.dest);
  if (!fs.existsSync(src)) { missing.push({ kit: s.kit, src }); continue; }

  const buf = fs.readFileSync(src);
  if (SECRET_NAME.test(path.basename(src))) {
    console.error(`ABORT - the name of ${src} looks like a secret. RESTORE.md rule 4.`);
    process.exit(1);
  }
  // Only text is content-scanned; a font or a .png cannot hide a key in a way this would find,
  // and scanning binaries only produces false positives.
  const isText = !buf.includes(0) && buf.length < 4_000_000;
  if (isText) {
    const text = buf.toString("utf8");
    for (const [re, what] of SECRET_CONTENT) {
      const m = text.match(re);
      if (m) {
        const line = text.slice(0, m.index).split("\n").length;
        // The value itself is NEVER printed - the owner's rule, and this output goes to a log.
        console.error(`ABORT - ${src}:${line} contains what looks like a ${what} (${m[0].length} chars). RESTORE.md rule 4.`);
        process.exit(1);
      }
    }
  }

  const dst = path.join(OUT, s.kit.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);

  const hash = sha(buf);
  const before = prevHash.get(s.kit);
  if (before === undefined) added.push(s.kit);
  else if (before !== hash) changed.push(s.kit);

  files.push({ kit: s.kit, dest: s.dest, mode: s.mode, sha256: hash, bytes: buf.length });
}

const manifest = { built: new Date().toISOString(), files };
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

const dropped = prev.files.filter((f) => !seen.has(f.kit)).map((f) => f.kit);

if (!QUIET) {
  for (const k of changed) console.log(`CHANGED  ${k}`);
  for (const k of added) console.log(`ADDED    ${k}`);
  for (const k of dropped) console.log(`DROPPED  ${k}`);
  for (const m of missing) console.log(`MISSING  ${m.kit}  (no ${m.src})`);
}
console.log(`\n${files.length} files | ${changed.length} changed | ${added.length} added | ${dropped.length} dropped | ${missing.length} missing`);
if (missing.length) { console.error("A file in the spec is not on this machine - the kit would ship without it."); process.exit(1); }
