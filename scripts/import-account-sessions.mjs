#!/usr/bin/env node
// Import the UNFINISHED sessions of your OTHER Claude accounts into the account the
// desktop app is signed into now, from the command line.
//
// PowerShell — and it must be this spelling: PowerShell does NOT expand `~` in an argument
// to a native program, so `node ~/.claude/scripts/...` reaches node as a literal tilde and
// dies with MODULE_NOT_FOUND.
//
//   node "$env:USERPROFILE\.claude\scripts\import-account-sessions.mjs"           # dry run
//   node "$env:USERPROFILE\.claude\scripts\import-account-sessions.mjs" --apply   # do it
//   node "$env:USERPROFILE\.claude\scripts\import-account-sessions.mjs" --undo --apply   # take the last import back out
//
// The scheduled task "Claude Account Session Import - Hourly" runs it with --apply --quiet,
// which prints nothing on a run that brings nothing in and appends every import to
// ~/.claude/scripts/account-session-import.log.
//
// Why this exists: the desktop app's session list is scoped to ONE account. Every account
// has its own folder under %APPDATA%\Claude\claude-code-sessions\<account>\<org>\, and a
// session is one local_<id>.json record in it. The conversation itself is NOT account-scoped
// — it is ~/.claude/projects/<folder-slug>/<cliSessionId>.jsonl, shared by every account on
// the machine. So an unfinished session from the other account is sitting on this disk,
// resumable, and simply not listed. Copying its record into the signed-in account's folder
// lists it, and it opens on the same conversation.
//
// UNFINISHED means: the session is not archived, carries no delete tombstone, and its
// conversation file still exists. A record whose .jsonl has aged out of retention would
// open empty, so it is left behind unless you pass --include-dead.
//
// Reads and copies only. It never writes into another account's folder, never edits a
// record's contents, never deletes a conversation. Every run writes a manifest under
// ~/.claude/relay/session-imports/ so --undo can remove exactly what it added.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const PROJECTS = path.join(HOME, ".claude", "projects");

// The desktop app is an MSIX package, so its AppData\Roaming is VIRTUALIZED: a process
// inside the package container (a Claude Code session, which the app starts) sees the store
// at %APPDATA%\Claude, while a process outside it (a scheduled task, a plain terminal) sees
// the same folder only at the package's LocalCache — and each view hides the other, with no
// error. Reading one hard-coded path therefore works in a session and reports "no session
// folder yet" from the hourly task. Both candidates are tried, every time.
function storeCandidates() {
  const out = [path.join(APPDATA, "Claude", "claude-code-sessions")];
  const packages = path.join(LOCALAPPDATA, "Packages");
  try {
    for (const p of fs.readdirSync(packages)) {
      if (!/^Claude[._]/i.test(p) && p !== "Claude") continue;
      out.push(path.join(packages, p, "LocalCache", "Roaming", "Claude", "claude-code-sessions"));
    }
  } catch { /* no packaged install */ }
  // Builds from ~22 Oct 2026 keep the store at %LOCALAPPDATA%\Claude-Data\claude_<pkg>\ —
  // neither path above exists any more, and the hourly task failed every run until this.
  const dataRoot = path.join(LOCALAPPDATA, "Claude-Data");
  try {
    for (const p of fs.readdirSync(dataRoot)) {
      if (!/^claude/i.test(p)) continue;
      out.push(path.join(dataRoot, p, "claude-code-sessions"));
    }
  } catch { /* older build */ }
  return [...new Set(out)];
}
const CLI_CONFIG = path.join(HOME, ".claude.json");
const ACCOUNTS_FILE = path.join(HOME, ".claude", "relay", "accounts.json");
const MANIFEST_DIR = path.join(HOME, ".claude", "relay", "session-imports");
const LIVE_LOCKS = path.join(HOME, ".claude", "sessions");
const LOG = path.join(HOME, ".claude", "scripts", "account-session-import.log");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const APPLY = has("--apply");
const UNDO = has("--undo");
const INCLUDE_DEAD = has("--include-dead");
const INCLUDE_ARCHIVED = has("--include-archived");
const AS_JSON = has("--json");
const QUIET = has("--quiet");
const ONLY = val("--account");
const SINCE = val("--since");
const LIMIT = val("--limit") ? Number(val("--limit")) : null;

for (const a of argv) {
  if (a.startsWith("--") &&
    !["--apply", "--undo", "--include-dead", "--include-archived", "--json", "--quiet",
      "--account", "--since", "--limit", "--help", "-h"].includes(a)) {
    console.error(`unknown flag ${a} — refusing rather than guessing.`);
    process.exit(2);
  }
}
if (has("--help") || has("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const readJSON = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const cairo = (ms) => (ms ? new Date(ms).toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) : "-");

// ---------------------------------------------------------------- who am I now
const cfg = readJSON(CLI_CONFIG, {});
const CURRENT = cfg?.oauthAccount?.accountUuid || null;
const CURRENT_ORG = cfg?.oauthAccount?.organizationUuid || null;
if (!CURRENT || !CURRENT_ORG) {
  console.error("Cannot tell which account is signed in (~/.claude.json has no oauthAccount). Nothing done.");
  process.exit(2);
}
const registry = readJSON(ACCOUNTS_FILE, { accounts: {} })?.accounts || {};
const nameOf = (id) => {
  const a = registry[id];
  if (!a) return `an account last used from this machine (${id.slice(0, 8)})`;
  const email = a.email && a.email !== "(unknown)" ? a.email : null;
  return a.name ? (email ? `${a.name} — ${email}` : a.name) : (email || id.slice(0, 8));
};

const tried = storeCandidates();
const STORE = tried.find((c) => fs.existsSync(path.join(c, CURRENT, CURRENT_ORG)))
  || tried.find((c) => fs.existsSync(c));
if (!STORE) {
  console.error("Cannot find the desktop app's session store. Tried:\n  " + tried.join("\n  ") + "\nNothing done.");
  process.exit(2);
}
const TARGET = path.join(STORE, CURRENT, CURRENT_ORG);
if (!fs.existsSync(TARGET)) {
  console.error(`The signed-in account has no session folder yet:\n  ${TARGET}\nNothing done.`);
  process.exit(2);
}

// ---------------------------------------------------------------- undo
fs.mkdirSync(MANIFEST_DIR, { recursive: true });
if (UNDO) {
  const manifests = fs.readdirSync(MANIFEST_DIR).filter((n) => n.endsWith(".json")).sort();
  if (!manifests.length) { console.log("No import has been run from this machine — nothing to undo."); process.exit(0); }
  const latest = path.join(MANIFEST_DIR, manifests[manifests.length - 1]);
  const m = readJSON(latest);
  if (!m?.imported?.length) { console.log(`Last import (${manifests.at(-1)}) added nothing — nothing to undo.`); process.exit(0); }
  let removed = 0, kept = 0;
  for (const row of m.imported) {
    // A manifest written inside the app's package container spells the store the other way
    // round (see storeCandidates) — fall back to this run's resolved folder.
    const dest = fs.existsSync(row.dest) ? row.dest : path.join(TARGET, path.basename(row.dest));
    if (!fs.existsSync(dest)) { kept++; continue; }
    // Only remove a file this import created and that has not been rewritten since.
    const st = fs.statSync(dest);
    if (row.destSizeAfter && st.size !== row.destSizeAfter) {
      console.log(`kept (changed since the import): ${path.basename(dest)}`);
      kept++; continue;
    }
    if (APPLY) fs.unlinkSync(dest);
    removed++;
  }
  console.log(`${APPLY ? "Removed" : "Would remove"} ${removed} imported record(s) from ${nameOf(CURRENT)}${kept ? `, kept ${kept}` : ""}.`);
  console.log(`manifest: ${latest}`);
  if (!APPLY) console.log("\nThis was a dry run. Add --apply to actually take them out.");
  process.exit(0);
}

// ---------------------------------------------------------------- conversations on disk
const transcripts = new Map(); // cliSessionId -> { file, size, mtime }
for (const slug of fs.readdirSync(PROJECTS)) {
  const dir = path.join(PROJECTS, slug);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, e.name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    transcripts.set(e.name.slice(0, -6), { file: full, size: st.size, mtime: st.mtimeMs });
  }
}

// --------------------------------------------- conversations a session is live in RIGHT NOW
// A session running under the other account at this moment is left where it is: it is not
// abandoned work, and it comes over on a later run once it goes quiet.
const liveNow = new Set();
try {
  for (const n of fs.readdirSync(LIVE_LOCKS)) {
    if (!n.endsWith(".json")) continue;
    const lock = readJSON(path.join(LIVE_LOCKS, n));
    if (!lock?.sessionId) continue;
    const seen = lock.updatedAt || lock.statusUpdatedAt || lock.startedAt || 0;
    if (Date.now() - seen < 15 * 60 * 1000) liveNow.add(lock.sessionId);
  }
} catch { /* no locks dir — nothing is running */ }

// ---------------------------------------------------------------- read one account folder
function readOrg(account, org) {
  const dir = path.join(STORE, account, org);
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const tombstones = new Set(
    names.filter((n) => n.startsWith("deleted_")).map((n) => n.slice("deleted_".length).replace(/^local_/, "")),
  );
  const archivedIdx = new Set();
  const idx = path.join(dir, "archived-sessions.idx");
  if (fs.existsSync(idx)) {
    for (const m of fs.readFileSync(idx, "utf8")
      .matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) archivedIdx.add(m[0]);
  }
  const out = [];
  for (const n of names) {
    if (!n.startsWith("local_") || !n.endsWith(".json")) continue;
    const file = path.join(dir, n);
    const j = readJSON(file);
    if (!j) continue;
    const sid = String(j.sessionId || n.slice(0, -5)).replace(/^local_/, "");
    const t = j.cliSessionId ? transcripts.get(j.cliSessionId) : null;
    out.push({
      account, org, file, name: n, sid,
      cli: j.cliSessionId || null,
      cwd: j.cwd || j.originCwd || "",
      title: j.title || "(untitled)",
      archived: !!j.isArchived || archivedIdx.has(sid),
      tombstoned: tombstones.has(sid),
      lastActivity: j.lastActivityAt || j.lastFocusedAt || j.createdAt || 0,
      transcriptBytes: t ? t.size : null,
    });
  }
  return out;
}

const accounts = fs.readdirSync(STORE).filter((n) => {
  try { return fs.statSync(path.join(STORE, n)).isDirectory(); } catch { return false; }
});

const here = [];
for (const org of fs.readdirSync(path.join(STORE, CURRENT))) {
  try { if (fs.statSync(path.join(STORE, CURRENT, org)).isDirectory()) here.push(...readOrg(CURRENT, org)); } catch { /* skip */ }
}
const haveSid = new Set(here.map((r) => r.sid));
const haveCli = new Set(here.filter((r) => r.cli).map((r) => r.cli));

const sinceMs = SINCE ? Date.parse(SINCE + "T00:00:00+02:00") : null;
if (SINCE && Number.isNaN(sinceMs)) { console.error(`--since ${SINCE} is not a date I can read (use YYYY-MM-DD).`); process.exit(2); }

const matchesOnly = (id) => {
  if (!ONLY) return true;
  const a = registry[id] || {};
  const hay = [id, a.email || "", a.name || ""].join(" ").toLowerCase();
  return hay.includes(ONLY.toLowerCase());
};

const summary = [];
const candidates = [];
for (const account of accounts) {
  if (account === CURRENT) continue;
  if (!matchesOnly(account)) continue;
  const rows = [];
  for (const org of fs.readdirSync(path.join(STORE, account))) {
    try { if (fs.statSync(path.join(STORE, account, org)).isDirectory()) rows.push(...readOrg(account, org)); } catch { /* skip */ }
  }
  if (!rows.length) continue;
  const open = rows.filter((r) => (INCLUDE_ARCHIVED || !r.archived) && !r.tombstoned);
  const live = open.filter((r) => r.transcriptBytes !== null);
  const dead = open.filter((r) => r.transcriptBytes === null);
  summary.push({ account, total: rows.length, archived: rows.filter((r) => r.archived).length, open: open.length, live: live.length, dead: dead.length });
  for (const r of (INCLUDE_DEAD ? open : live)) {
    if (haveSid.has(r.sid) || (r.cli && haveCli.has(r.cli))) { r.skip = "already in this account"; }
    else if (r.cli && liveNow.has(r.cli)) { r.skip = "running right now on that account"; }
    else if (sinceMs && r.lastActivity < sinceMs) { r.skip = `older than ${SINCE}`; }
    candidates.push(r);
  }
}

let takeable = candidates.filter((r) => !r.skip).sort((a, b) => b.lastActivity - a.lastActivity);
if (LIMIT) takeable = takeable.slice(0, LIMIT);

// ---------------------------------------------------------------- report
if (AS_JSON) {
  console.log(JSON.stringify({ current: { account: CURRENT, org: CURRENT_ORG, name: nameOf(CURRENT) }, summary, takeable }, null, 1));
} else if (!QUIET) {
  console.log(`Signed in as : ${nameOf(CURRENT)}`);
  console.log(`Its sessions : ${TARGET}`);
  console.log(`Listed there : ${here.filter((r) => !r.archived && !r.tombstoned).length} unfinished, ${here.length} in all`);
  console.log("");
  console.log("OTHER ACCOUNTS ON THIS MACHINE");
  console.log("account                                   total  archived  unfinished  resumable  conversation gone");
  for (const s of summary.sort((a, b) => b.live - a.live)) {
    console.log(
      nameOf(s.account).padEnd(41),
      String(s.total).padStart(5),
      String(s.archived).padStart(9),
      String(s.open).padStart(11),
      String(s.live).padStart(10),
      String(s.dead).padStart(18),
    );
  }
  const skipped = candidates.filter((r) => r.skip);
  console.log("");
  console.log(`${APPLY ? "IMPORTING" : "WOULD IMPORT"}: ${takeable.length} session(s)${skipped.length ? `   (skipping ${skipped.length}: ${[...new Set(skipped.map((s) => s.skip))].join("; ")})` : ""}`);
  if (takeable.length) {
    console.log("");
    console.log("last active (Cairo)   from           folder                                           title");
    for (const r of takeable) {
      console.log(
        cairo(r.lastActivity).padEnd(21),
        (registry[r.account]?.name || r.account.slice(0, 8)).padEnd(14),
        (r.cwd || "-").replace(/\\/g, "/").split("/").slice(-2).join("/").slice(0, 47).padEnd(48),
        r.title.slice(0, 64),
      );
    }
  }
}

// ---------------------------------------------------------------- copy
if (!APPLY) {
  if (!AS_JSON && !QUIET) {
    console.log("");
    console.log("This was a dry run — nothing was copied. Add --apply to bring them in.");
  }
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const imported = [];
for (const r of takeable) {
  const dest = path.join(TARGET, r.name);
  if (fs.existsSync(dest)) continue; // never overwrite a record that is already there
  fs.copyFileSync(r.file, dest);
  imported.push({
    sid: r.sid, cli: r.cli, title: r.title, cwd: r.cwd,
    from: r.file, dest, fromAccount: r.account,
    destSizeAfter: fs.statSync(dest).size,
    lastActivity: r.lastActivity,
  });
}
let manifest = null;
if (imported.length) {
  manifest = path.join(MANIFEST_DIR, `${stamp}.json`);
  fs.writeFileSync(manifest, JSON.stringify({
    at: Date.now(), atCairo: cairo(Date.now()),
    into: { account: CURRENT, org: CURRENT_ORG, name: nameOf(CURRENT), dir: TARGET },
    imported,
  }, null, 1));
  try {
    const lines = [`[${cairo(Date.now())}] imported ${imported.length} into ${nameOf(CURRENT)}  (manifest ${path.basename(manifest)})`]
      .concat(imported.map((r) => `    ${nameOf(r.fromAccount).split(" — ")[0]}: ${r.title}  [${r.cli}]`));
    fs.appendFileSync(LOG, lines.join("\n") + "\n");
  } catch { /* a log that cannot be written must not fail the import */ }
}

if (AS_JSON) {
  console.log(JSON.stringify({ imported: imported.length, manifest }, null, 1));
} else if (QUIET) {
  // Quiet runs stay silent unless something actually came in.
  if (imported.length) console.log(`imported ${imported.length} session(s) into ${nameOf(CURRENT)} — manifest ${manifest}`);
} else {
  console.log("");
  console.log(`Copied ${imported.length} session record(s) into ${nameOf(CURRENT)}.`);
  if (manifest) {
    console.log(`manifest: ${manifest}`);
    console.log(`Undo with:  node "${process.argv[1]}" --undo --apply`);
  }
}
