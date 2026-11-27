// Prunes ~/.claude.json project entries: folders that no longer exist, and the backslash twin of a
// project that also has a forward-slash key (its non-empty settings are merged into the forward-slash key first).
//
// Every running Claude Code session and the desktop app rewrite ~/.claude.json from memory, so this
// REFUSES to write while any claude.exe is running. Close the desktop app and every session, then run it
// from a plain PowerShell window:
//   node C:\Users\satoh\.claude\scripts\prune-claude-json.mjs            (writes)
//   node C:\Users\satoh\.claude\scripts\prune-claude-json.mjs --dry-run  (reports only, safe any time)
// Before writing it copies the file to F:\Claude Config Backups\<YYYY-MM-DD_HHMM> claude-json prune\ with a MANIFEST.md.
// Written 2026-09-17 (config tidy, item 5).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const FILE = path.join(process.env.USERPROFILE || "C:/Users/satoh", ".claude.json");
const DRY = process.argv.includes("--dry-run");

const before = fs.readFileSync(FILE, "utf8");
const j = JSON.parse(before);
const P = j.projects || {};
const keys = Object.keys(P);
const norm = (k) => k.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const empty = (x) => x === false || x === 0 || x === "" || x == null || (Array.isArray(x) && x.length === 0) || (typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0);

const log = [];
const gone = keys.filter((k) => !fs.existsSync(k));
for (const k of gone) { delete P[k]; log.push(`removed (folder no longer exists): ${k}`); }

const groups = {};
for (const k of Object.keys(P)) (groups[norm(k)] ??= []).push(k);
for (const ks of Object.values(groups)) {
  if (ks.length < 2) continue;
  const keep = ks.find((k) => !k.includes("\\")) || ks[0];
  for (const twin of ks.filter((k) => k !== keep)) {
    for (const [field, value] of Object.entries(P[twin])) {
      if (empty(value) || !empty(P[keep][field])) continue;
      P[keep][field] = value;
      log.push(`merged ${field} from ${twin} into ${keep}`);
    }
    delete P[twin];
    log.push(`removed duplicate key: ${twin} (kept ${keep})`);
  }
}

console.log(log.join("\n") || "nothing to prune");
console.log(`project entries: ${keys.length} -> ${Object.keys(P).length}`);
if (DRY || log.length === 0) process.exit(0);

let running;
try { running = execFileSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/NH"], { encoding: "utf8" }); } catch {
  console.error("REFUSED: could not list running processes, so it cannot prove Claude is closed. Nothing was written.");
  process.exit(3);
}
if (/claude\.exe/i.test(running)) {
  console.error("REFUSED: claude.exe is running (desktop app or a Claude Code session). Close them all, then run this again. Nothing was written.");
  process.exit(3);
}

const now = new Date();
const cairo = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
const stamp = `${cairo.year}-${cairo.month}-${cairo.day}_${cairo.hour}${cairo.minute}`;
const dir = `F:/Claude Config Backups/${stamp} claude-json prune/C-drive/Users/satoh`;
fs.mkdirSync(dir, { recursive: true });
const copy = path.join(dir, ".claude.json");
fs.writeFileSync(copy, before, { flag: "wx" });
const sha = crypto.createHash("sha256").update(before).digest("hex").slice(0, 16);
fs.writeFileSync(path.join(path.dirname(path.dirname(path.dirname(dir))), "MANIFEST.md"),
  `# ~/.claude.json prune - ${stamp} Cairo\n\n| Path under C:\\Users\\satoh | Bytes | SHA-256 (first 16) |\n| --- | --- | --- |\n| .claude.json | ${Buffer.byteLength(before)} | ${sha} |\n\nTo undo: copy C-drive\\Users\\satoh\\.claude.json back over C:\\Users\\satoh\\.claude.json with every Claude window closed.\n\n## Changes\n\n${log.map((l) => `- ${l}`).join("\n")}\n`);

const text = JSON.stringify(j, null, 2);
JSON.parse(text);
const tmp = `${FILE}.prune-tmp`;
fs.writeFileSync(tmp, text, "utf8");
fs.renameSync(tmp, FILE);
JSON.parse(fs.readFileSync(FILE, "utf8"));
console.log(`written; parses OK. Backup: ${copy}`);
