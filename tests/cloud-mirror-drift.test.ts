import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cloudMirrorDrift,
  cloudMirrorDriftReport,
  cloudMirrorSessionLines,
  crlfToLf,
} from "../scripts/cloud-mirror-drift.mjs";
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
 *  2. LINE ENDINGS ARE NOT DRIFT. The live memory still holds files with CRLF, while git normalises
 *     CRLF to LF on the way in, so the COMMITTED blob a cloud session clones never carries a CR.
 *     Comparing raw bytes reports every such file as drifted. Measured the same day: `git status`
 *     listed 36 changed files after a sync while the commit held 9.
 *  5. THE REFRESH WRITES LF. `sync-cloud-context.mjs` used to copy those CRLF files verbatim, so the
 *     working copy differed from the index and `git status` listed 27 files as modified with no
 *     content change — which made `new-session.mjs --remove` refuse to retire a worktree whose
 *     refresh had already merged (2026-10-04). `crlfToLf` is pinned by behaviour, and the script's
 *     two writes by source.
 *  3. THE REPORT NAMES FILES. A count nobody can act on is not a finding.
 *  4. THE FAIL DIRECTION. repo-doctor must say "cannot measure" when a side is missing, never
 *     "none drifted" — a cloud session running it has no memory directory at all.
 *
 * Comments are stripped before the source read: this file's prose spells the strings it pins, and a
 * test that matched its own explanation would pin nothing (AGENTS.md §2.1).
 */

const DOCTOR = "scripts/repo-doctor.mjs";
const GUARD = ".claude/hooks/memory-index-guard.mjs";
const REFRESH = "scripts/cloud-mirror-drift-refresh.mjs";
const MEMORY_DIR_LIB = "scripts/lib/memory-dir.mjs";
const SOURCE = "scripts/cloud-mirror-source.mjs";
const SYNC = "scripts/sync-cloud-context.mjs";
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
  //
  // 2026-10-09 (hook speed fixes): the READING moved to `scripts/cloud-mirror-drift-refresh.mjs`, an
  // async SessionStart entry that caches it, and the blocking guard prints the cached reading. So the
  // pins follow the code: the comparison and the unreadable-mirror rule are pinned in the refresher,
  // the wording and the alarm stay pinned in the guard, and the cache lives in one shared module.
  // The behaviour behind each is driven for real in tests/session-start-memory-index-guard.test.ts.
  const guard = flat(GUARD);
  const refresh = flat(REFRESH);
  const memoryDirLib = flat(MEMORY_DIR_LIB);
  assert.ok(guard.includes("cloud-mirror-drift.mjs"), `${GUARD}: the SessionStart guard must load the shared decision`);
  assert.ok(
    /cloudMirrorSessionLines\(drift\)/.test(guard),
    `${GUARD}: it must use the SessionStart form, not repo-doctor's long report`,
  );
  assert.ok(refresh.includes("cloud-mirror-drift.mjs"), `${REFRESH}: the reading must use the shared decision`);
  assert.ok(
    /cloudMirrorDrift\(\{\s*live: readMd\(memoryDir\), mirror: mirror\.files\s*\}\)/.test(refresh),
    `${REFRESH}: the reading must be cloudMirrorDrift over the live notes and the mirror's files, as the guard's was`,
  );
  // A mirror that cannot be read at all is not drift and not "current" — the same under-claiming
  // direction every other section of that hook takes.
  assert.ok(
    /mirror !== null/.test(refresh),
    `${REFRESH}: an unreadable mirror must be passed over, not reported either way`,
  );
  // The owner is told as well as the session: the cost of not knowing lands on him, as a cloud run
  // that comes back having redone finished work.
  assert.ok(
    /mirrorDrifted > 0\)\s*\{\s*alarms\.push/.test(guard),
    `${GUARD}: drift must reach the human through systemMessage, not only the session's context`,
  );
  // 🔴 The blocking guard must not take the reading back. Every session start waited on it — p50
  // 2.0 s, worst 11.1 s for the hook — and "it still works, just slower" fails no output assertion.
  assert.ok(
    !guard.includes("cloud-mirror-source.mjs") && !/readCloudMirror\(/.test(guard) && !/cloudMirrorDrift\(/.test(guard),
    `${GUARD}: the blocking guard must print the cached reading, never read the mirror or compare it itself`,
  );
  // Both sides go through the ONE shared module, so they can never disagree about which memory
  // directory a reading belongs to or where its cache file is.
  assert.ok(
    /readDriftCache\(memoryDir, \{ maxAgeMs: DRIFT_CACHE_SHOW_MS \}\)/.test(guard),
    `${GUARD}: it must read the cached reading through scripts/lib/memory-dir.mjs, under its 24-hour limit`,
  );
  assert.ok(
    /readDriftCache\(memoryDir, \{ maxAgeMs: DRIFT_CACHE_REFRESH_MS \}\)/.test(refresh) && /writeDriftCache\(memoryDir,/.test(refresh),
    `${REFRESH}: it must skip a fresh reading and write the new one through scripts/lib/memory-dir.mjs`,
  );
  assert.ok(
    /renameSync\(temp, file\)/.test(memoryDirLib),
    `${MEMORY_DIR_LIB}: the reading must be written atomically — a half-written cache reads as no reading and silences a real alarm`,
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
  // The SessionStart half of this is the refresher since 2026-10-09 (hook speed fixes) — it is what
  // reads the mirror now, from `projectDir`, the repo root the session runs in.
  for (const [file, text] of [[DOCTOR, doctor], [REFRESH, refresh]] as Array<[string, string]>) {
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

  // ── 5. The refresh WRITES LF ─────────────────────────────────────────────────────────────────
  // 27 of 1,111 live memory files carry CRLF. Copied verbatim they land in the working tree as CRLF
  // while the index holds LF, so `git status` lists them as modified and `new-session.mjs --remove`
  // refuses the worktree. The function is pinned by behaviour; the script's use of it by source.
  const hex = (b: Buffer) => b.toString("hex");
  assert.equal(hex(crlfToLf(Buffer.from("a\r\nb\r\n"))), hex(Buffer.from("a\nb\n")), "CRLF becomes LF");
  assert.equal(hex(crlfToLf(Buffer.from("a\nb\n"))), hex(Buffer.from("a\nb\n")), "LF is left alone");
  assert.equal(
    hex(crlfToLf(Buffer.from("a\rb\r\n"))),
    hex(Buffer.from("a\rb\n")),
    "a lone CR is not a line ending and stays",
  );
  assert.equal(
    hex(crlfToLf(Buffer.from("a\r\r\nb"))),
    hex(Buffer.from("a\r\nb")),
    "only the CR directly before the LF goes",
  );
  assert.equal(
    hex(crlfToLf(Buffer.from([0xff, 0x0d, 0x0a, 0xfe, 0x80]))),
    hex(Buffer.from([0xff, 0x0a, 0xfe, 0x80])),
    "bytes that are not valid UTF-8 pass through untouched — never decoded, never re-encoded",
  );
  assert.equal(crlfToLf(Buffer.alloc(0)).length, 0, "an empty file stays empty");
  const noCr = Buffer.from("no carriage return here\n");
  assert.equal(crlfToLf(noCr), noCr, "a buffer with no CR comes back as the very same buffer");

  const sync = flat(SYNC);
  assert.ok(
    /import \{ crlfToLf \} from ['"]\.\/cloud-mirror-drift\.mjs['"]/.test(sync),
    `${SYNC}: it must import crlfToLf from the pure module that owns line-ending knowledge`,
  );
  assert.ok(
    /crlfToLf\(fs\.readFileSync\(path\.join\(MEMORY_DIR, name\)\)\)/.test(sync),
    `${SYNC}: every memory file must be written through crlfToLf`,
  );
  assert.ok(
    /crlfToLf\(fs\.readFileSync\(GLOBAL_RULES\)\)/.test(sync),
    `${SYNC}: the global standing rules must be written through crlfToLf too`,
  );
  assert.equal(
    (sync.match(/readFileSync\(/g) ?? []).length,
    (sync.match(/crlfToLf\(fs\.readFileSync\(/g) ?? []).length,
    `${SYNC}: no file may be read for the mirror without going through crlfToLf`,
  );

  // ── 6. the GLOBAL STANDING RULES copy is measured too ────────────────────────────────────────
  //
  // It sits beside the memory mirror, so section 5 above says nothing about it, and until
  // 2026-10-09 the only assertion naming it was the crlfToLf one further down — which pins how the
  // refresh WRITES it and not whether the committed copy still matches the live file. It did not:
  // the copy on origin/main was 606 bytes behind and named an archive path corrected that morning.
  {
    const doctor = flat(DOCTOR);
    assert.ok(
      /global-standing-rules\.md/.test(doctor),
      `${DOCTOR}: it must measure the standing-rules copy a cloud session reads, not only the memory mirror`,
    );
    assert.ok(
      /crlfToLf/.test(doctor),
      `${DOCTOR}: the comparison must normalise line endings, or every CRLF file reports as drift`,
    );
    assert.ok(
      /mirror\.source === "ref"/.test(doctor),
      `${DOCTOR}: the standing rules must be read from the SAME source as the memory mirror, or the label lies`,
    );
    // THE FAIL DIRECTION, the same one section 5 pins for the memory mirror: a cloud runner has no
    // ~/.claude, and "in step" is the one answer it must never print there.
    assert.ok(
      /cannot measure — the live/.test(doctor),
      `${DOCTOR}: with no live file it must say it cannot measure, never report the mirror in step`,
    );
    assert.ok(
      /MISSING from the mirror/.test(doctor),
      `${DOCTOR}: a mirror with no standing-rules file at all must report that, not silence`,
    );
  }

}
