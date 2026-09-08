import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SESSION_HELD_MIN,
  encodeProjectDirName,
  sessionActivityMinutes,
  sessionHoldReason,
} from "../scripts/repo-doctor-session-hold.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// repo-doctor must not offer a worktree for removal while a session is standing in it.
//
// On 2026-09-08 it offered two, both `.claude/worktrees/*`, both with a live session. Every gate
// it had read the FOLDER — uncommitted files, unpushed commits, source mtimes, the newest PR's
// state — and a session that is open but between turns writes none of them. The report prints
// ready-to-paste `git worktree remove` lines; something ran them. Both sessions were left in a
// DEREGISTERED worktree, where `pwd` still names the folder while every bare git command resolves
// against the primary checkout — which sits on `main`, production's branch.
//
// What is pinned here is the part that fails SILENTLY: the path encoding. If it drifts, every
// lookup misses, every folder reads as unheld, and the report goes back to exactly the behaviour
// that caused the incident — with no error anywhere.
// ─────────────────────────────────────────────────────────────────────────────

/** A throwaway `~/.claude/projects/<encoded>/<id>.jsonl` tree, so this test depends on no session. */
function fixture(worktreeDir: string, transcriptAgeMin: number | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "repo-doctor-hold-"));
  if (transcriptAgeMin === null) return home; // no project directory at all
  const projectDir = path.join(home, ".claude", "projects", encodeProjectDirName(worktreeDir));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "0ed4dd47-04dc-4e1f-8c47-9cc979fddd42.jsonl");
  fs.writeFileSync(file, '{"type":"user"}\n');
  const when = new Date(Date.now() - transcriptAgeMin * 60_000);
  fs.utimesSync(file, when, when);
  return home;
}

export function runRepoDoctorSessionHoldTests() {
  const worktree =
    process.platform === "win32"
      ? "F:\\Phoenix Workforce\\phoenix-workforce\\.claude\\worktrees\\zealous-dewdney-7afb5e"
      : "/f/Phoenix Workforce/phoenix-workforce/.claude/worktrees/zealous-dewdney-7afb5e";

  // ── The encoding is the whole mechanism, and it fails silently ────────────
  // Verified against this machine on 2026-09-08: the directory that actually exists for the
  // worktree below is the string on the right. Get this wrong by one character and every lookup
  // misses, every worktree reads as unheld, and the guard is gone with nothing reporting it.
  if (process.platform === "win32") {
    assert.equal(
      encodeProjectDirName(worktree),
      "F--Phoenix-Workforce-phoenix-workforce--claude-worktrees-zealous-dewdney-7afb5e",
      "the project-directory encoding must reproduce the name Claude Code actually writes — a "
        + "wrong encoding finds nothing and reports every folder as unheld",
    );
  }
  // The doubled dashes are not a special case to preserve by hand: they fall out of `:\` and `\.`
  // each being two replaced characters. Pinned so a "tidy up the double dashes" edit fails here.
  assert.equal(encodeProjectDirName("/a/.b/c d"), path.resolve("/a/.b/c d").replace(/[^A-Za-z0-9]/g, "-"));
  assert.ok(!/[^A-Za-z0-9-]/.test(encodeProjectDirName(worktree)), "only [A-Za-z0-9-] may survive");

  // ── A session that spoke a moment ago HOLDS the folder ────────────────────
  // Both worktrees taken that day read 0 minutes at the moment they were offered for removal.
  {
    const homedir = fixture(worktree, 0);
    assert.equal(sessionActivityMinutes(worktree, { homedir }), 0);
    const reason = sessionHoldReason(worktree, { homedir });
    assert.ok(reason, "a session that spoke seconds ago must hold the folder");
    assert.match(
      String(reason),
      /deregisters the worktree under a live session/,
      "the reason is printed to a human deciding whether to paste a removal command — it has to "
        + "say what removing it would DO, not merely that something is held",
    );
  }

  // Just inside the window still holds. The boundary is the interesting case: an off-by-one here
  // hands back the folder of a session that paused to think for two hours.
  {
    const homedir = fixture(worktree, SESSION_HELD_MIN - 1);
    assert.ok(sessionHoldReason(worktree, { homedir }), "activity inside the window must hold");
  }

  // ── A genuinely idle folder is NOT held, or the guard blocks every retirement ──
  // `happy-yalow-73e092` measured 1,306 minutes on the same machine, the same day. If staleness
  // did not release, repo-doctor would stop retiring anything and the report becomes noise.
  {
    const homedir = fixture(worktree, SESSION_HELD_MIN + 1);
    assert.equal(sessionHoldReason(worktree, { homedir }), null, "a stale transcript must not hold");
  }
  {
    const homedir = fixture(worktree, 1306);
    assert.equal(sessionHoldReason(worktree, { homedir }), null, "21 hours idle is not a live session");
  }

  // ── Never-run and unreadable both fall through, and that is deliberate ────
  // This rule only ever SUBTRACTS from what is offered for removal. A folder no session has used
  // returns null and the existing gates decide, exactly as before — so a wrong answer here costs a
  // worktree that stays one more day, never a folder deleted under somebody.
  {
    const homedir = fixture(worktree, null);
    assert.equal(sessionActivityMinutes(worktree, { homedir }), null, "no project directory is not an error");
    assert.equal(sessionHoldReason(worktree, { homedir }), null);
  }
  {
    // A project directory holding no transcript at all — present but empty.
    const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-doctor-hold-"));
    fs.mkdirSync(path.join(homedir, ".claude", "projects", encodeProjectDirName(worktree)), { recursive: true });
    assert.equal(sessionActivityMinutes(worktree, { homedir }), null, "an empty project directory reads as never-run");
  }

  // A file that is not a transcript must not be mistaken for one — otherwise any stray write into
  // the project directory pins a folder as permanently held and nothing is ever retirable again.
  {
    const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-doctor-hold-"));
    const projectDir = path.join(homedir, ".claude", "projects", encodeProjectDirName(worktree));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "notes.txt"), "not a transcript");
    assert.equal(sessionActivityMinutes(worktree, { homedir }), null, "only .jsonl transcripts count");
  }

  // The newest transcript wins: a folder with one old session and one live one is HELD.
  {
    const homedir = fixture(worktree, 5000);
    const projectDir = path.join(homedir, ".claude", "projects", encodeProjectDirName(worktree));
    const live = path.join(projectDir, "7e343f13-0000-0000-0000-000000000000.jsonl");
    fs.writeFileSync(live, '{"type":"user"}\n');
    assert.ok(
      sessionHoldReason(worktree, { homedir }),
      "one live session among several dead ones still holds the folder — the newest transcript "
        + "decides, never the first one read off the directory",
    );
  }

  // ── The gate must run BEFORE any removal command can be printed ───────────
  // The commands ARE the interface here: they are written to be pasted, and on 2026-09-08 they
  // were. A check that ran at the printing step instead would leave a path — now, or after a later
  // edit — on which a held folder's `git worktree remove` still reaches the screen.
  const source = readFileSync(
    fileURLToPath(new URL("../scripts/repo-doctor.mjs", import.meta.url)),
    "utf8",
  );
  const holdAt = source.indexOf("sessionHoldReason(r.dir)");
  const prAt = source.indexOf("classifyBranchPr(listBranchPrs(branch)");
  const pushAt = source.indexOf("merged.push(");
  assert.ok(holdAt !== -1 && prAt !== -1 && pushAt !== -1, "could not locate the retirement gate — this test measures nothing");
  assert.ok(
    holdAt < prAt && holdAt < pushAt,
    "the live-session hold must be checked before the PR lookup and before anything is added to "
      + "the retirable list — a folder somebody is sitting in is not retirable whatever its PR says",
  );
  assert.match(
    source,
    /NOT retirable — a session is HOLDING the folder/,
    "a held worktree must be NAMED, not silently dropped — an unexplained disappearance reads as "
      + "'that folder is gone' rather than 'somebody is in it'",
  );
  // The blind spot has to stay on screen. This guard covers `.claude/worktrees/*` only; an `_wt-*`
  // session reports the PRIMARY as its cwd, so its absence from the held list proves nothing.
  assert.match(
    source,
    /reports the PRIMARY as its cwd/,
    "the report must state that `_wt-*` folders are UNKNOWN rather than proven unattended — a "
      + "guard believed to cover both is more dangerous than no guard",
  );
}
