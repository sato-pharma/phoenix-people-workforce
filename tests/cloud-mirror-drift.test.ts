import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cloudMirrorDrift, cloudMirrorDriftReport, cloudMirrorSessionLines } from "../scripts/cloud-mirror-drift.mjs";
import { readMirrorFromRef } from "../scripts/cloud-mirror-source.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE CLOUD MIRROR IS MEASURED, NOT ASSUMED CURRENT.
 *
 * A cloud session is an isolated clone that never sees `~/.claude`, so
 * `.claude/cloud-context/memory-mirror/` IS the Phoenix memory it wakes up with — and it is only as
 * fresh as its last MERGED refresh. Until 2026-10-02 nothing measured that.
 *
 * 🔴 WHAT THE GAP COST, MEASURED THE DAY IT WAS FOUND: five of 1,061 mirrored files no longer
 * matched the live memory and three memories were missing from the mirror entirely. The one that
 * mattered was `saginko-repriced-retail-from-october-direct-from-today` — the mirror still said the
 * `analytics.sos_fact` flat-price gap was "OPEN GAP … NOT yet fixed", while the live memory had been
 * overtaken 86 minutes later by the fix and its applied migration. A cloud session sent at that area
 * would have been dispatched to redo finished work, and could never have found out: it cannot see
 * the live memory. It was found by accident while auditing a worktree, which is the whole argument
 * for a check.
 *
 * What this pins:
 *
 *  1. THE THREE KINDS OF DRIFT, apart. Stale, missing from the mirror, and present in the mirror
 *     with no live memory are different problems with different fixes, and a single count hides
 *     which one you have.
 *  2. LINE ENDINGS ARE NOT DRIFT. `sync-cloud-context.mjs` copies buffers, so a fresh mirror is
 *     byte-identical on disk — but git normalises CRLF to LF on the way in, so the COMMITTED blob a
 *     cloud session clones differs from a Windows working tree. Comparing raw bytes reports every
 *     file as drifted. Measured the same day: `git status` listed 36 changed files after a sync
 *     while the commit held 9.
 *  3. THE REPORT NAMES FILES. A count nobody can act on is not a finding.
 *  4. THE FAIL DIRECTION. repo-doctor must say "cannot measure" when a side is missing, never
 *     "none drifted" — a cloud session running it has no memory directory at all.
 *
 * Comments are stripped before the source read: this file's prose spells the strings it pins, and a
 * test that matched its own explanation would pin nothing (AGENTS.md §2.1).
 */

const DOCTOR = "scripts/repo-doctor.mjs";
const GUARD = ".claude/hooks/memory-index-guard.mjs";
const SOURCE = "scripts/cloud-mirror-source.mjs";
const flat = (path: string) => stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");

const m = (entries: Array<[string, string]>) => new Map(entries);

export function runCloudMirrorDriftTests() {
  // ── 1. The three kinds, apart ────────────────────────────────────────────────────────────────
  const live = m([
    ["same.md", "unchanged\n"],
    ["moved-on.md", "the gap is FIXED and the migration applied\n"],
    ["brand-new.md", "written since the last refresh\n"],
  ]);
  const mirror = m([
    ["same.md", "unchanged\n"],
    ["moved-on.md", "OPEN GAP, NOT yet fixed\n"],
    ["retired.md", "a memory deleted upstream, still shipping to cloud\n"],
  ]);

  const drift = cloudMirrorDrift({ live, mirror });
  assert.equal(drift.compared, 3, "the denominator is the LIVE memory — that is the truth being mirrored");
  assert.deepEqual(drift.stale, ["moved-on.md"]);
  assert.deepEqual(drift.missing, ["brand-new.md"], "a memory written since the last refresh is missing, not stale");
  assert.deepEqual(drift.extra, ["retired.md"], "a mirrored file with no live original still reaches cloud");
  assert.equal(drift.drifted, 3);

  // A mirror that matches is the whole point, and must read as zero rather than as "nothing checked".
  const clean = cloudMirrorDrift({ live, mirror: new Map(live) });
  assert.equal(clean.drifted, 0);
  assert.equal(clean.compared, 3, "a clean verdict still has to say how many it looked at");

  // ── 2. Line endings are NOT drift ────────────────────────────────────────────────────────────
  // The one false positive that would have made this check useless on this machine: it fires on
  // every file the moment a Windows checkout touches the tree, and a check that always fires is a
  // check that gets switched off.
  const crlf = cloudMirrorDrift({
    live: m([["a.md", "line one\nline two\n"]]),
    mirror: m([["a.md", "line one\r\nline two\r\n"]]),
  });
  assert.equal(crlf.drifted, 0, "CRLF against LF is git normalisation, not a stale fact");
  // But a REAL difference hiding behind mixed endings must still be caught.
  const realInside = cloudMirrorDrift({
    live: m([["a.md", "line one\nFIXED\n"]]),
    mirror: m([["a.md", "line one\r\nNOT yet fixed\r\n"]]),
  });
  assert.deepEqual(realInside.stale, ["a.md"], "normalising endings must not also normalise away the content");

  // ── 3. Degenerate inputs read as nothing-to-say, never as a crash ────────────────────────────
  assert.equal(cloudMirrorDrift({ live: new Map(), mirror: new Map() }).drifted, 0);
  assert.equal(cloudMirrorDrift({ live: undefined as never, mirror: undefined as never }).drifted, 0);

  // ── 4. The report names files ────────────────────────────────────────────────────────────────
  const lines = cloudMirrorDriftReport(drift).join("\n");
  assert.match(lines, /3 file\(s\) DRIFTED out of 3/);
  assert.match(lines, /moved-on\.md/, "a count without names is not something anyone can act on");
  assert.match(lines, /brand-new\.md/);
  assert.match(lines, /retired\.md/);
  assert.match(lines, /node scripts\/sync-cloud-context\.mjs/, "and it must say what fixes it");

  const cleanLines = cloudMirrorDriftReport(clean).join("\n");
  assert.match(cleanLines, /mirror is current/);
  assert.doesNotMatch(cleanLines, /sync-cloud-context/, "a clean mirror must not advertise a fix it does not need");

  // A long list is truncated rather than burying the rest of the report, but still says how many.
  const many = cloudMirrorDrift({
    live: m(Array.from({ length: 14 }, (_, i) => [`f${i}.md`, "live"] as [string, string])),
    mirror: m(Array.from({ length: 14 }, (_, i) => [`f${i}.md`, "old"] as [string, string])),
  });
  const manyLines = cloudMirrorDriftReport(many).join("\n");
  assert.match(manyLines, /and 4 more stale/, "it truncates at ten and says how many it left out");

  // ── 5. repo-doctor's wiring and its fail direction ───────────────────────────────────────────
  const doctor = flat(DOCTOR);
  assert.ok(doctor.includes("cloud-mirror-drift.mjs"), `${DOCTOR}: the section must use the shared decision`);
  assert.ok(
    doctor.includes("CLOUD MIRROR (memory files a cloud session would read stale)"),
    `${DOCTOR}: the section needs a heading a reader can find`,
  );
  // 🔴 An absent source must read as "cannot measure", never as a clean mirror. A cloud session
  // running repo-doctor has no memory directory at all, and a silent zero there would be the
  // check reporting health it never looked for.
  // 🔴 ANCHORED ON THIS SECTION'S OWN WORDING, NOT ON `memoryDir === null … SKIPPED`. That shape
  // also appears in the MEMORY INDEX section a few hundred lines above, which has its own
  // `memoryDir === null` SKIP — so the generic pattern passed happily after this section's skip was
  // deleted outright. Caught by breaking it: the assertion stayed green while repo-doctor reported
  // a clean mirror on a checkout with no memory to compare against, which is the one answer this
  // whole section exists to avoid. A test that can be satisfied by a different block is not a test.
  assert.ok(
    doctor.includes("no session memory directory here, so there is nothing to compare against"),
    `${DOCTOR}: no memory directory must SKIP, not report zero drift`,
  );
  assert.ok(
    doctor.includes("COULD NOT READ the mirror at"),
    `${DOCTOR}: a missing mirror must say so rather than passing`,
  );
  // The mirror is the CURRENT checkout's — that is the copy a commit from here would ship, and the
  // one sync-cloud-context.mjs would rewrite. Reading the primary's instead would report a worktree
  // as clean while shipping its own stale copy.
  assert.ok(
    /rev-parse", "--show-toplevel/.test(doctor),
    `${DOCTOR}: the mirror must come from the checkout being run in, not from primaryRoot`,
  );

  // ── 6. SessionStart: silent when current, loud when drifted ──────────────────────────────────
  // repo-doctor speaks only when somebody runs it, and the moment that matters is the one where a
  // session decides to send work to cloud — the start. An audit cannot stop a dispatch that has
  // already happened, which is the same argument the memory-index budget makes in the same hook.
  assert.deepEqual(
    cloudMirrorSessionLines(clean),
    [],
    "🔴 SILENT when the mirror is current — a standing 'all good' line charges every request of the "
      + "session to say nothing, and drift is the only actionable state",
  );
  assert.deepEqual(cloudMirrorSessionLines(null as never), [], "no reading at all is silence too, never a false alarm");

  const session = cloudMirrorSessionLines(drift).join("\n");
  assert.match(session, /CLOUD MIRROR IS STALE/);
  assert.match(session, /3 of 3 mirrored memory files/);
  // The WHY has to travel with it: this is not the session's own memory, it is what a CLOUD session
  // reads instead of `~/.claude`, and that is the only reason a local session should care.
  assert.match(session, /A CLOUD session reads the mirror, never ~\/\.claude/);
  assert.match(session, /moved-on\.md/, "it names files, so a reader can judge urgency");
  assert.match(session, /node scripts\/sync-cloud-context\.mjs/);

  // Short on purpose — SessionStart context is charged to every request for the rest of the session,
  // so the full list belongs to repo-doctor and this names at most three.
  const manySession = cloudMirrorSessionLines(many);
  assert.match(manySession.join("\n"), /and 11 more/, "a long list is summarised, never pasted into every request");
  assert.ok(manySession.length <= 4, "the SessionStart form stays a handful of lines whatever the drift count");

  // ── 7. The SessionStart hook's wiring ────────────────────────────────────────────────────────
  const guard = flat(GUARD);
  assert.ok(guard.includes("cloud-mirror-drift.mjs"), `${GUARD}: the SessionStart guard must load the shared decision`);
  assert.ok(
    /cloudMirrorSessionLines\(drift\)/.test(guard),
    `${GUARD}: it must use the SessionStart form, not repo-doctor's long report`,
  );
  // A mirror that cannot be read at all is not drift and not "current" — the same under-claiming
  // direction every other section of that hook takes.
  assert.ok(
    /mirror !== null/.test(guard),
    `${GUARD}: an unreadable mirror must be passed over, not reported either way`,
  );
  // The owner is told as well as the session: the cost of not knowing lands on him, as a cloud run
  // that comes back having redone finished work.
  assert.ok(
    /mirrorDrifted > 0\)\s*\{\s*alarms\.push/.test(guard),
    `${GUARD}: drift must reach the human through systemMessage, not only the session's context`,
  );

  // ── 8. BOTH READERS MEASURE `origin/main`, NOT THE WORKING TREE ──────────────────────────────
  //
  // 🔴 THE FALSE ALARM THIS REPLACED, MEASURED 2026-10-02: four reports of "2 files DRIFTED" in one
  // afternoon, every one of them against files byte-identical to live memory on `origin/main`. The
  // cause is this repo's NORMAL state rather than an edge case — `main` moves every few minutes, so a
  // checkout is usually a commit or two behind, and reading its working tree compares live memory
  // against a mirror already superseded. A cloud session clones `main`; the tree on disk only says
  // what a commit from here would ship. A check that cries wolf at every session start is one people
  // learn to skip, which costs the real alarm too.
  for (const [file, text] of [[DOCTOR, doctor], [GUARD, guard]] as Array<[string, string]>) {
    assert.ok(
      text.includes("cloud-mirror-source.mjs"),
      `${file}: must read the mirror through the shared source module, not readdirSync`,
    );
    assert.ok(
      /readCloudMirror\(\{\s*root:/.test(text),
      `${file}: must ask readCloudMirror for the copy a cloud session would clone`,
    );
  }
  // The label is load-bearing, not decoration: a fallback to the working tree has to announce itself
  // rather than passing as the real answer, and repo-doctor is where a reader sees which was used.
  assert.ok(doctor.includes("mirror.label"), `${DOCTOR}: it must print WHICH copy was measured`);
  // And "cannot measure" must name both sources, or a reader assumes only the disk was tried.
  assert.ok(
    doctor.includes("or on origin/main. Do NOT read this as clean."),
    `${DOCTOR}: an unreadable mirror must say both sources were tried`,
  );

  const source = flat(SOURCE);
  // One ls-tree and one cat-file --batch for the whole directory. A `git show` per file would be a
  // process spawn per memory — over a thousand of them — which no SessionStart hook can afford.
  assert.ok(/"ls-tree"/.test(source), `${SOURCE}: list the mirror from the tree`);
  assert.ok(/"cat-file", "--batch"/.test(source), `${SOURCE}: read every blob in ONE batch`);
  assert.doesNotMatch(source, /"show"/, `${SOURCE}: never a git show per file`);
  // 🔴 It must NOT fetch. Network I/O at SessionStart slows every session and fails oddly offline;
  // the ref being only as fresh as the last fetch is the accepted, documented trade.
  assert.doesNotMatch(source, /"fetch"/, `${SOURCE}: a SessionStart reader must never hit the network`);
  // An absent ref must answer null so the caller can fall back and SAY so — never an empty Map,
  // which would read as "the mirror has no files", i.e. every memory missing from it.
  //
  // 🔴 PINNED BY BEHAVIOUR, NOT BY SOURCE TEXT. The first version of this assertion matched a
  // COMMENT (`return null; // no such ref`), and `flat()` strips comments before the source read —
  // so it failed instantly. It would have been worse had it passed: a test that matches its own
  // explanation pins nothing. Calling the function is both shorter and real.
  assert.equal(
    readMirrorFromRef({ root: process.cwd(), ref: "refs/heads/no-such-branch-for-this-test" }),
    null,
    `${SOURCE}: an unreadable ref must answer null, never an empty mirror`,
  );
  // And the real ref must come back with files, or the assertion above would pass for the wrong
  // reason — a reader that always answers null is not a reader.
  const real = readMirrorFromRef({ root: process.cwd(), ref: "origin/main" });
  if (real !== null) {
    assert.ok(real.size > 500, `${SOURCE}: origin/main's mirror should hold the whole memory set`);
    assert.ok(real.has("MEMORY.md"), `${SOURCE}: the index itself is part of what cloud reads`);
  }
}
