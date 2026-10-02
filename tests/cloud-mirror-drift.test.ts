import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cloudMirrorDrift, cloudMirrorDriftReport } from "../scripts/cloud-mirror-drift.mjs";
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
}
