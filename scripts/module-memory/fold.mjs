#!/usr/bin/env node
// THE WEEKLY FOLD — file every new memory note under its module, in ONE PR.
//
//   node scripts/module-memory/fold.mjs            dry run: prints what it would file, writes nothing
//   node scripts/module-memory/fold.mjs --apply    settle the inbox, then open the fold PR
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MEMORY_DIR = process.env.PHX_MEMORY_DIR
  || path.join(os.homedir(), ".claude", "projects", "F--Phoenix-Workforce-phoenix-workforce", "memory");
const STATE_DIR = path.join(process.env.USERPROFILE || os.homedir(), ".claude", "relay", "state");
const INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const INBOX_HEADING = /^##\s+Inbox\b/;
const FALLBACK = "sessions";
const APPLY = process.argv.includes("--apply");

const git = (args, cwd = REPO) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
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

/** Decide one note's module. Returns { module, how }. */
export function classify(slug, text, lib) {
  const sid = /originSessionId:\s*([0-9a-f-]{36})/i.exec(text)?.[1];
  const scores = scoreNote(`${slug.replace(/-/g, " ")}\n${text}`, lib);
  const touched = sid ? touchedBy(sid).filter((id) => id in scores) : [];
  if (touched.length === 1) return { module: touched[0], how: "the only module its session touched" };
  const pool = touched.length ? touched : Object.keys(scores);
  const best = pool.sort((a, b) => scores[b] - scores[a])[0];
  if (scores[best] > 0) return { module: best, how: touched.length ? "best match among the modules its session touched" : "its own words" };
  return { module: FALLBACK, how: "no module matched — filed under the fallback, move it if wrong" };
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
    out.push("", "## Inbox — new notes land here", "Put each new memory note's pointer here, one line. The weekly fold (`node scripts/module-memory/fold.mjs --apply`) files it under its module in ONE PR; once that merges, the next fold removes the line.");
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
  git(["fetch", "-q", "origin", "main"]);
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

  const open = execFileSync("gh", ["pr", "list", "--state", "open", "--search", "memory fold in:title", "--json", "number,title"], { cwd: REPO, encoding: "utf8" });
  const openFold = JSON.parse(open).find((p) => /memory fold/i.test(p.title));
  if (openFold) {
    say(`an open fold PR already exists (#${openFold.number}) — merge it first; nothing new is filed until then`);
    return;
  }

  const lib = await import(pathToFileURL(path.join(REPO, "scripts", "module-memory", "modules.mjs")).href);
  const notes = laptopNotes();
  const fresh = [...notes.keys()].filter((s) => !filedOnMain.has(s)).sort();
  const gone = [...filedOnMain].filter((s) => !notes.has(s));
  if (!fresh.length && !gone.length) {
    say("nothing to file — every note on this laptop is already filed on main");
    return;
  }
  const filed = fresh.map((s) => ({ slug: s, ...classify(s, notes.get(s), lib) }));
  for (const f of filed) say(`${f.slug} -> ${f.module} (${f.how})`);
  for (const s of gone) say(`${s} -> removed (the note no longer exists on this laptop)`);
  if (!APPLY) {
    say("dry run — re-run with --apply to open the PR");
    return;
  }

  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  const branch = `codex/memory-fold-${day}`;
  const wt = path.join(path.dirname(REPO), `_wt-memory-fold-${day}`);
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
    const body = [
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
    git(["commit", "-q", "-m", `chore(memory): weekly memory fold — ${filed.length} note(s) filed\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], wt);
    git(["push", "-q", "-u", "origin", branch], wt);
    const url = execFileSync("gh", ["pr", "create", "--title", `chore(memory): weekly memory fold — ${day}`, "--body", body, "--head", branch, "--base", "main"], { cwd: wt, encoding: "utf8" }).trim();
    say(`opened ${url}`);
  } finally {
    // The branch is pushed; the temporary folder holds nothing that is not on origin.
    try { git(["worktree", "remove", "--force", wt]); } catch { say(`could not remove ${wt} — remove it with git worktree remove`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`fold: FAILED — ${e.message}`); process.exit(1); });
}
