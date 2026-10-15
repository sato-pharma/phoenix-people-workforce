#!/usr/bin/env node
// THE MEMORY FOLD — file every new memory note under its module, in ONE PR.
//
//   node scripts/module-memory/fold.mjs            dry run: prints what it would file, writes nothing
//   node scripts/module-memory/fold.mjs --apply    settle the inbox, then open the fold PR
//
// 🔴 IT RUNS THREE TIMES A DAY — 09:00, 15:00 and 21:00 Cairo (owner, 2026-10-03: "this report
// needs to run twice or 3 times a day"), not weekly. A run with nothing new to file opens NO PR and
// costs nothing, and only ONE fold PR is ever open at a time: a run that finds an open one stops.
// So the cadence shortens the wait before a note reaches its module; it does not multiply merges.
//
// HOW MEMORY FLOWS (docs/module-memory.md):
//   1. A session writes a memory note on the laptop (~/.claude/projects/<slug>/memory/<name>.md) and
//      a pointer under `## Inbox` in MEMORY.md — every session sees it from the next one on.
//   2. This fold files each note that no module claims yet: it reads the note's originSessionId and
//      the modules THAT session touched (recorded by .claude/hooks/module-memory-injector.mjs), and
//      falls back to matching the note's own words against scripts/module-memory/modules.mjs.
//   3. It refreshes the repo mirror of the notes, rebuilds the module files, and opens ONE PR.
//   4. SETTLE: on the next run, every inbox pointer whose note is already filed on origin/main is
//      removed from MEMORY.md — so the inbox empties only AFTER the owner merged, never before.
//
// It works in a temporary worktree on a fresh branch from origin/main, so it never touches a
// checkout another session is using. It never merges (the owner does) and never deletes a note.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "module-memory/fold",
  entry: import.meta.url,
  known: ["--apply"],
  hints: [
    "a bare run is a dry run — --apply files the inbox and opens the PR",
  ],
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MEMORY_DIR = process.env.PHX_MEMORY_DIR
  || path.join(os.homedir(), ".claude", "projects", "F--Phoenix-Workforce-phoenix-workforce", "memory");
const STATE_DIR = path.join(process.env.USERPROFILE || os.homedir(), ".claude", "relay", "state");
const INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const INBOX_HEADING = /^##\s+Inbox\b/;
const FALLBACK = "sessions";
const APPLY = process.argv.includes("--apply");
// Regenerated with its own timestamp by every `sync-cloud-context.mjs` run, so it is never evidence
// that anything drifted — see the staged-file test below.
export const MIRROR_STAMP_FILE = ".claude/cloud-context/README.md";

const git = (args, cwd = REPO) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).trim();

// 🔴 A NETWORK BLIP MUST NOT COST A WHOLE FOLD. The 15:00 run on 2026-10-08 failed at 15:04 Cairo
// when GitHub reset the connection mid `git push` — one transient error, no retry, and the notes
// waited six hours for the next run. Only a transient NETWORK failure is retried (three attempts,
// 5 s / 15 s / 45 s apart); anything else — a rejected push, a bad flag — throws at once, as before.
export const TRANSIENT = /Connection was reset|Could not resolve host|Operation timed out|HTTP 5\d\d|unable to access/i;
export const RETRY_DELAYS_MS = [5000, 15000, 45000];

// 🔴 A FETCH THAT LOSES A LOCK IS RETRIED TOO — but only the fetch. Measured 2026-10-08 21:00 Cairo:
// the fold's launcher and the CRM field day's both fetch `origin/main` into the same `.git` at 21:00,
// and the loser died on `cannot lock ref 'refs/remotes/origin/main': is at … but expected …`. This
// fetch races the same way against the field day and against every session in the primary. A lock
// error on a PUSH means the remote moved and a retry cannot fix it, so `git push` keeps TRANSIENT only.
export const LOCK_LOST = /cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'/i;
export const FETCH_RETRYABLE = new RegExp(`${TRANSIENT.source}|${LOCK_LOST.source}`, "i");

const failureText = (e) => [e?.message, e?.stderr, e?.stdout].filter(Boolean).map(String).join("\n");

/** Runs `fn`, retrying it only on a transient failure (`retryOn`, a network error by default); logs every failed attempt. */
export async function withRetry(label, fn, { tries = 3, delaysMs = RETRY_DELAYS_MS, retryOn = TRANSIENT, log = say, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const text = failureText(e);
      if (attempt >= tries || !retryOn.test(text)) throw e;
      const wait = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      const line = text.split("\n").find((l) => retryOn.test(l))?.trim();
      log(`${label}: attempt ${attempt} of ${tries} failed on a transient error (${line}) — retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

const say = (s) => console.log(`fold: ${s}`);

/** Notes on the laptop, by slug -> raw text. */
function laptopNotes() {
  const out = new Map();
  for (const f of fs.readdirSync(MEMORY_DIR)) {
    if (!f.endsWith(".md") || /^MEMORY/.test(f)) continue;
    out.set(f.slice(0, -3), fs.readFileSync(path.join(MEMORY_DIR, f), "utf8"));
  }
  return out;
}

function touchedBy(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `modules-${String(sessionId).slice(0, 36)}.json`), "utf8")).touched || [];
  } catch {
    return [];
  }
}

/** Score a note's own words against each module: keywords, paths it names, tables it names. */
export function scoreNote(text, lib) {
  const { MODULES, mentions, modulesForPath } = lib;
  const scores = Object.fromEntries(MODULES.map((m) => [m.id, 0]));
  const lower = text.toLowerCase();
  for (const m of MODULES) {
    for (const k of m.keywords) if (mentions(lower, k)) scores[m.id] += 2;
    for (const t of m.tables) if (t.length > 3 && lower.includes(t.toLowerCase())) scores[m.id] += 1;
  }
  for (const tok of text.split(/[\s"'`()\[\],;]+/)) {
    if (!tok.includes("/")) continue;
    for (const id of modulesForPath(tok.replace(/^\.\//, ""))) scores[id] += 3;
  }
  return scores;
}

/**
 * Decide one note's module. Returns { module, how }.
 *
 * 🔴 A TIE IS NOT A MATCH. Measured 2026-10-03 on `a-not-loaded-assertion-is-satisfied-by-a-refusal`:
 * five modules scored 2 each — crm, database, engineering, git-worktrees, sessions — and the note
 * went to `crm` purely because that was the one module its session had touched, reported as a
 * confident "best match". It is a note about module memory itself. So when the top score is shared,
 * prefer the fallback (`sessions`, the catch-all for how a session works) if it is among the tied,
 * and either way SAY it was a tie, so the fold's own PR shows which notes are guesses.
 */
export function classify(slug, text, lib) {
  const sid = /originSessionId:\s*([0-9a-f-]{36})/i.exec(text)?.[1];
  const scores = scoreNote(`${slug.replace(/-/g, " ")}\n${text}`, lib);
  const touched = sid ? touchedBy(sid).filter((id) => id in scores) : [];
  const pool = touched.length ? touched : Object.keys(scores);
  const ranked = [...pool].sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  if (!(scores[best] > 0)) return { module: FALLBACK, how: "no module matched — filed under the fallback, move it if wrong" };
  // Every module sharing the top score, across the WHOLE map — a tie inside the touched pool is
  // still a tie when a module the session never opened scores the same.
  const tied = Object.keys(scores).filter((id) => scores[id] === scores[best]);
  if (tied.length > 1) {
    const pick = tied.includes(FALLBACK) ? FALLBACK : best;
    return { module: pick, how: `tied at ${scores[best]} with ${tied.filter((t) => t !== pick).join(", ")} — a guess, move it if wrong` };
  }
  if (touched.length === 1) return { module: touched[0], how: "the only module its session touched" };
  return { module: best, how: touched.length ? "best match among the modules its session touched" : "its own words" };
}

/** The owner's "never trim, never forget" block keeps every line, whatever module its note is in. */
const PROTECTED_SECTION = /RULE #1|never trim/i;

/**
 * SETTLE the index: remove every pointer line whose notes are ALL filed on origin/main under a
 * module or history — they load with their module now. Lines for `global` notes stay (that is what
 * the index is for), the protected RULE #1 block stays whole, and prose and headings stay. A section
 * left with no pointer is removed, except the inbox. Only notes already on MAIN count, so the index
 * never drops a pointer before the module file that replaces it has merged (AGENTS.md 2.2: git half
 * first, then the laptop half). Returns how many lines it removed.
 */
export function settleIndex(text, filedOnMain) {
  const lines = text.split("\n");
  let guarded = false;
  let removed = 0;
  const kept = lines.filter((line) => {
    if (/^#{1,3}\s/.test(line)) guarded = PROTECTED_SECTION.test(line);
    if (guarded || !/^- /.test(line)) return true;
    const linked = [...line.matchAll(/\]\(([A-Za-z0-9._-]+)\.md\)/g)].map((m) => m[1]).filter((s) => !/^MEMORY/.test(s));
    if (linked.length && linked.every((s) => filedOnMain[s] && filedOnMain[s] !== "global")) { removed++; return false; }
    return true;
  });
  // Drop a `##` section left holding no pointer at all (never the inbox, never a protected one).
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i];
    if (/^##\s/.test(line) && !INBOX_HEADING.test(line) && !PROTECTED_SECTION.test(line)) {
      let j = i + 1;
      while (j < kept.length && !/^##\s/.test(kept[j]) && !/^- /.test(kept[j])) j++;
      if (j >= kept.length || /^##\s/.test(kept[j])) { i = j - 1; continue; }
    }
    out.push(line);
  }
  // The first settle also writes the two things the index now needs: what it is, and the inbox.
  if (!out.some((l) => /Module memory holds everything module-specific/.test(l))) {
    const h = out.findIndex((l) => /^#\s/.test(l));
    out.splice(h + 1, 0, "", "**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.");
  }
  if (!out.some((l) => INBOX_HEADING.test(l))) {
    out.push("", "## Inbox — new notes land here", "Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.");
  }
  return { text: out.join("\n"), removed };
}

function settleInbox(filedOnMain) {
  if (!fs.existsSync(INDEX)) return 0;
  const { text, removed } = settleIndex(fs.readFileSync(INDEX, "utf8"), filedOnMain);
  if (removed && APPLY) {
    const backups = path.join(os.homedir(), ".claude", "backups", "memory-index");
    fs.mkdirSync(backups, { recursive: true });
    fs.copyFileSync(INDEX, path.join(backups, `MEMORY.md.pre-fold-${Date.now()}`));
    fs.writeFileSync(INDEX, text);
  }
  return removed;
}

async function main() {
  await withRetry("git fetch", () => git(["fetch", "-q", "origin", "main"]), { retryOn: FETCH_RETRYABLE });
  let onMain;
  try {
    onMain = JSON.parse(git(["show", "origin/main:scripts/module-memory/assignments.json"]));
  } catch {
    say("module memory is not on main yet — nothing to fold until its PR merges");
    return;
  }
  const filedOnMain = new Set(Object.keys(onMain));
  const settled = settleInbox(onMain);
  say(`${settled} index pointer(s) whose note is filed in a module on main ${APPLY ? "removed from" : "would be removed from"} MEMORY.md`);

  // 🔴 A FOLD PR IS IDENTIFIED BY ITS BRANCH, NEVER BY ITS TITLE. The title test matched any open PR
  // with "memory fold" in its name — including a PR *about* the fold, which then silently stopped
  // every run until it merged. Measured 2026-10-03: #5215, the PR that introduced this cadence, was
  // itself read as the open fold. Only this script creates `codex/memory-fold-*`, so the branch is
  // the one signal a human cannot collide with.
  const open = execFileSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName"], { cwd: REPO, encoding: "utf8" });
  const openFold = JSON.parse(open).find((p) => /^codex\/memory-fold-\d/.test(p.headRefName));
  if (openFold) {
    say(`an open fold PR already exists (#${openFold.number}) — merge it first; nothing new is filed until then`);
    return;
  }

  const lib = await import(pathToFileURL(path.join(REPO, "scripts", "module-memory", "modules.mjs")).href);
  const notes = laptopNotes();
  const fresh = [...notes.keys()].filter((s) => !filedOnMain.has(s)).sort();
  const gone = [...filedOnMain].filter((s) => !notes.has(s));

  // 🔴 NOTHING NEW TO FILE IS NOT NOTHING TO DO — THE MIRROR STILL HAS TO BE MEASURED. This used to
  // return here, so drift from an EDITED note (same slug, new body) never reached the repo on the
  // 09:00/15:00/21:00 cadence and waited for the next genuinely new note. Measured 2026-10-15: a
  // note renamed and rewritten by hand left the mirror stale, SessionStart flagged it twice, and the
  // refresh was a hand-run job. A cloud session reads ONLY the mirror, so a stale one is the wrong
  // rule in front of the session that cannot check it against anything.
  const mirrorOnly = !fresh.length && !gone.length;
  if (mirrorOnly) say("nothing new to file — measuring whether the repo mirror still matches the laptop's notes");
  const filed = fresh.map((s) => ({ slug: s, ...classify(s, notes.get(s), lib) }));
  for (const f of filed) say(`${f.slug} -> ${f.module} (${f.how})`);
  for (const s of gone) say(`${s} -> removed (the note no longer exists on this laptop)`);
  if (!APPLY && !mirrorOnly) {
    say("dry run — re-run with --apply to open the PR");
    return;
  }

  // 🔴 THE BRANCH CARRIES THE CLOCK TIME, NOT ONLY THE DAY. It runs three times a day, and
  // `git worktree add -b` fails outright on a branch that already exists — the local branch
  // survives both the temporary worktree's removal and the PR's merge (GitHub deletes only the
  // remote one). A day-only name broke every second run of a day that filed a note twice.
  const now = new Date();
  const day = now.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  const clock = now.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const stamp = `${day}-${clock.replace(":", "")}`;
  const branch = `codex/memory-fold-${stamp}`;
  const wt = path.join(path.dirname(REPO), `_wt-memory-fold-${stamp}`);
  git(["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
  try {
    const assignments = { ...onMain };
    for (const f of filed) assignments[f.slug] = f.module;
    for (const s of gone) delete assignments[s];
    const sorted = Object.fromEntries(Object.keys(assignments).sort().map((k) => [k, assignments[k]]));
    fs.writeFileSync(path.join(wt, "scripts/module-memory/assignments.json"), JSON.stringify(sorted, null, 2) + "\n");
    execFileSync("node", ["scripts/sync-cloud-context.mjs"], { cwd: wt, stdio: "inherit" });
    execFileSync("node", ["scripts/module-memory/build.mjs"], { cwd: wt, stdio: "inherit" });
    execFileSync("node", ["scripts/module-memory/build.mjs", "--check"], { cwd: wt, stdio: "inherit" });
    git(["add", "-A", "scripts/module-memory", ".claude/rules", ".claude/cloud-context", "docs/module-memory", "AGENTS.md"], wt);

    // 🔴 THE MIRROR'S README IS REWRITTEN BY EVERY SYNC — it carries the generated-at stamp and the
    // counts, so it is staged on a run where nothing drifted at all. Counting it as a change would
    // open a PR three times a day for ever; it is only ever carried ALONGSIDE a real change.
    const staged = git(["diff", "--cached", "--name-only"], wt).split("\n").map((l) => l.trim()).filter(Boolean);
    const changed = staged.filter((f) => f !== MIRROR_STAMP_FILE);
    if (!changed.length) {
      say("the mirror already matches the laptop's notes — nothing to refresh, no PR opened");
      return;
    }
    if (!APPLY) {
      say(`dry run — ${changed.length} mirror file(s) have drifted from the laptop's notes; re-run with --apply to open the PR`);
      for (const f of changed) say(`  ${f}`);
      return;
    }
    const body = mirrorOnly
      ? [
          `Refreshes ${changed.length} file(s) of the repo mirror so they match the laptop's memory notes again.`,
          "",
          "No note was added or removed — these drifted because a note's own CONTENT was edited, which",
          "the fold used to skip entirely. A cloud session reads only this mirror.",
          "",
          ...changed.map((f) => `- \`${f}\``),
          "",
          "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
        ].join("\n")
      : [
          `Files ${filed.length} new memory note(s) under their modules${gone.length ? ` and drops ${gone.length} that no longer exist` : ""}.`,
          "",
          "| Note | Module | Why |",
          "| --- | --- | --- |",
          ...filed.map((f) => `| \`${f.slug}\` | \`${f.module}\` | ${f.how} |`),
          ...gone.map((s) => `| \`${s}\` | removed | the note no longer exists on the laptop |`),
          "",
          "After this merges, the next fold removes these pointers from the MEMORY.md inbox.",
          "",
          "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
        ].join("\n");
    const subject = mirrorOnly
      ? `chore(memory): cloud mirror refresh — ${changed.length} file(s)`
      : `chore(memory): memory fold — ${filed.length} note(s) filed`;
    git(["commit", "-q", "-m", `${subject}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], wt);
    await withRetry("git push", () => git(["push", "-q", "-u", "origin", branch], wt));
    let url;
    try {
      const title = `${mirrorOnly ? "chore(memory): cloud mirror refresh" : "chore(memory): memory fold"} — ${day} ${clock} Cairo`;
      url = await withRetry("gh pr create", () => execFileSync("gh", ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", "main"], { cwd: wt, encoding: "utf8" }).trim());
    } catch (e) {
      // A timed-out create can still have made the PR on GitHub's side, and the retry then fails
      // with "already exists" — so ask for it by branch before treating the branch as an orphan.
      let made = "";
      try { made = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], { cwd: wt, encoding: "utf8" }).trim(); } catch {}
      if (made) { say(`opened ${made}`); return; }
      // The push landed but no PR did: delete the remote branch, or the next run stacks a second
      // branch beside an orphan nobody will ever be shown.
      try { await withRetry("delete orphan branch", () => git(["push", "-q", "origin", "--delete", branch], wt)); say(`deleted the orphan remote branch ${branch}`); }
      catch { say(`could not delete the orphan remote branch ${branch} — delete it with git push origin --delete ${branch}`); }
      throw e;
    }
    say(`opened ${url}`);
  } finally {
    // The branch is pushed; the temporary folder holds nothing that is not on origin.
    try { git(["worktree", "remove", "--force", wt]); } catch { say(`could not remove ${wt} — remove it with git worktree remove`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`fold: FAILED — ${e.message}`); process.exit(1); });
}
