// Rewrites the PRODUCTION Postgres password into every local env file, after the owner has rotated
// it in the Supabase dashboard.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT A LIST OF EDITS
//
// The production database password is held in THREE keys per checkout — `.env.local`'s
// `SUPABASE_DB_URL`, `.env.local.production-20260921`'s `SUPABASE_DB_URL`, and
// `.env.production.rls.local`'s `PHOENIX_PRODUCTION_DATABASE_URL` — and this machine carries the
// primary plus a worktree per live session, so one rotation is ~27 entries. Missing one leaves a
// session that reads a dead credential and fails with "Tenant or user not found", which reads like
// the wrong pooler REGION rather than a stale password (see scripts/apply-sql-file.mjs's own
// explainConnectionError, written for exactly that confusion).
//
// 🔴 THE PASSWORD IS NEVER AN ARGUMENT AND NEVER AN ENV VAR. It is read from a hidden prompt, so it
// does not reach a shell history, a Claude Code transcript, or `settings.local.json` — a permission
// allow-rule stores the LITERAL command, so an inline `VAR=secret cmd` bakes a live credential into
// that file in plaintext. A session that wants to use this must hand the terminal to the owner.
//
// WHAT IT WILL NOT TOUCH
//
// Only URLs that carry the production project ref are rewritten. `PHOENIX_STAGING_DATABASE_URL` and
// `.env.local.staging-20260921` are left exactly as they are: rotating production does not change
// staging's password, and rewriting it would break the one leg of the drift check that still works.
// `.env.example` is left alone too — it holds a placeholder, not a credential.
//
// Usage (interactively, from the repo root):
//   node scripts/rotate-production-db-password.mjs              # primary + every worktree
//   node scripts/rotate-production-db-password.mjs --dry-run    # report the targets, write nothing
//   node scripts/rotate-production-db-password.mjs --primary-only
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
const STAGING_REF = "cifwmndunmlxjhyjugxa";

// The pooler REGION cannot be derived from the ref, and production is NOT on the default this repo's
// other caller assumes: scripts/apply-sql-file.mjs defaults to aws-0, which is staging's, so every
// production use of it needs PHOENIX_POOLER_HOST set by hand. Recorded here rather than fixed there,
// because that script is not this change's business.
const PRODUCTION_POOLER_HOST = "aws-1-eu-central-1.pooler.supabase.com";

const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (a !== "--dry-run" && a !== "--primary-only") {
    console.error(`unknown flag ${a} — expected --dry-run or --primary-only`);
    process.exit(2);
  }
}
const dryRun = args.has("--dry-run");
const primaryOnly = args.has("--primary-only");

/** Every checkout on this machine that carries env files: the primary, then each worktree. */
function checkouts(root) {
  const found = [{ label: "primary", dir: root }];
  if (primaryOnly) return found;
  const appWorktrees = path.join(root, ".claude", "worktrees");
  if (existsSync(appWorktrees)) {
    for (const d of readdirSync(appWorktrees)) found.push({ label: d, dir: path.join(appWorktrees, d) });
  }
  for (const d of readdirSync(root)) {
    if (d.startsWith("_wt-")) found.push({ label: d, dir: path.join(root, d) });
  }
  return found.filter((c) => existsSync(c.dir));
}

/**
 * Replace the password in a Postgres URL, leaving every other component byte-identical.
 *
 * Returns null when the line is not a production Postgres URL — that is the filter, so a staging
 * URL, a placeholder and a non-URL value all fall through untouched rather than being guessed at.
 */
function rewriteUrl(rawValue, password) {
  const quote = /^["']/.test(rawValue) ? rawValue[0] : "";
  const url = quote ? rawValue.slice(1, -1) : rawValue;
  if (!url.includes(PRODUCTION_REF)) return null;
  if (url.includes(STAGING_REF)) return null;
  const m = /^(postgres(?:ql)?:\/\/)([^:/@]+):([^@]*)@(.+)$/.exec(url);
  if (!m) return null;
  const [, scheme, user, , hostAndRest] = m;
  // encodeURIComponent so a password containing @ : / ? # cannot change the URL's shape.
  return `${quote}${scheme}${user}:${encodeURIComponent(password)}@${hostAndRest}${quote}`;
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        new Error(
          "stdin is not a TTY. This script only reads the password from a hidden prompt — it never " +
            "accepts it as an argument, an env var or piped input. Run it yourself in a terminal.",
        ),
      );
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buffer = "";
    const done = (err, value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") return done(null, buffer);
      if (ch === "\u0003") return done(new Error("cancelled"));
      if (ch === "\u007f" || ch === "\b") {
        buffer = buffer.slice(0, -1);
        return;
      }
      buffer += ch;
    };
    stdin.on("data", onData);
  });
}

const repoRoot = process.cwd();
if (!existsSync(path.join(repoRoot, "package.json"))) {
  console.error("run this from a checkout root (no package.json here)");
  process.exit(2);
}
// The primary is what the worktrees hang off, so resolve it rather than assuming cwd is it.
const primaryRoot = /[\\/]\.claude[\\/]worktrees[\\/]/.test(repoRoot) || /[\\/]_wt-/.test(repoRoot)
  ? repoRoot.replace(/[\\/](?:\.claude[\\/]worktrees|_wt-[^\\/]*).*$/, "")
  : repoRoot;

const targets = [];
for (const { label, dir } of checkouts(primaryRoot)) {
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.startsWith(".env"));
  } catch {
    continue;
  }
  for (const file of names) {
    if (file.endsWith(".example")) continue;
    const full = path.join(dir, file);
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    const keys = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      if (rewriteUrl(line.slice(eq + 1).trim(), "probe") === null) continue;
      keys.push(line.slice(0, eq).trim());
    }
    if (keys.length) targets.push({ label, file, full, keys });
  }
}

if (!targets.length) {
  console.error(
    `no production Postgres URL found in any env file under ${primaryRoot} — nothing to rotate, which ` +
      "is itself worth a look before assuming success",
  );
  process.exit(3);
}

console.log(`production ref ${PRODUCTION_REF} — ${targets.length} file(s) to rewrite:`);
for (const t of targets) console.log(`  ${t.label.padEnd(44)} ${t.file}  (${t.keys.join(", ")})`);
console.log(`staging URLs and *.example files are left untouched.`);

if (dryRun) {
  console.log("--dry-run: nothing written.");
  process.exit(0);
}

const password = await promptHidden("new PRODUCTION database password (not echoed): ");
if (!password) {
  console.error("empty password — nothing written");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(os.homedir(), ".claude", "backups", `env-production-db-password-${stamp}`);

let written = 0;
for (const t of targets) {
  const text = readFileSync(t.full, "utf8");
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let changed = 0;
  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return raw;
    const eq = line.indexOf("=");
    if (eq < 0) return raw;
    const next = rewriteUrl(line.slice(eq + 1).trim(), password);
    if (next === null) return raw;
    changed += 1;
    return `${line.slice(0, eq)}=${next}`;
  });
  if (!changed) continue;
  // Backups live OUTSIDE the repository on purpose: a *.env.bak beside the file is one careless
  // `git add -A` away from committing a live credential.
  const backupDir = path.join(backupRoot, t.label);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(path.join(backupDir, t.file), text, "utf8");
  writeFileSync(t.full, bom + out.join(eol), "utf8");
  written += changed;
  console.log(`  rewrote ${changed} entr${changed === 1 ? "y" : "ies"} in ${t.label}/${t.file}`);
}

console.log(`\n${written} entr${written === 1 ? "y" : "ies"} rewritten. Backups: ${backupRoot}`);

// Prove the new credential actually works, against production, before anyone trusts the rewrite.
// A silent success here is the whole point: a stale password's error is indistinguishable from a
// wrong pooler region, so it is cheaper to find out now than in the next session.
let verdict = 0;
try {
  const { default: postgres } = await import("postgres");
  const file = targets.find((t) => t.keys.includes("PHOENIX_PRODUCTION_DATABASE_URL"));
  if (!file) {
    console.log("no PHOENIX_PRODUCTION_DATABASE_URL to verify with — rewrite done, UNVERIFIED");
    process.exit(0);
  }
  const line = readFileSync(file.full, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("PHOENIX_PRODUCTION_DATABASE_URL="));
  const raw = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  const url = m
    ? `${m[1]}://${m[2]}.${m[4]}:${m[3]}@${process.env.PHOENIX_POOLER_HOST?.trim() || PRODUCTION_POOLER_HOST}:5432/${m[6]}`
    : raw;
  const sql = postgres(url, { max: 1, prepare: false });
  const [{ db, usr }] = await sql`select current_database() as db, current_user as usr`;
  await sql.end();
  console.log(`verified: connected to production as ${usr}, database ${db}`);
} catch (error) {
  console.error(`\nVERIFY FAILED — ${String(error?.message ?? error)}`);
  console.error(
    "The files were rewritten and backed up. If the password was mistyped, re-run this script; the " +
      "backups above hold the previous contents.",
  );
  verdict = 1;
}
process.exit(verdict);
