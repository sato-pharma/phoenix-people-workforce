// THE INDEX BUDGET WAS POLICING 21KB AND IGNORING THE 112KB SITTING BESIDE IT.
//
// WHY THIS EXISTS. `MEMORY.md` is capped at 22,000 bytes, a SessionStart hook enforces it, and
// `tests/memory-index-budget.test.ts` pins the arithmetic. `AGENTS.md` had no budget at all — and
// AGENTS.md §2.2 prescribes it as the RELIEF VALVE for an over-budget index, on the stated grounds
// that it "auto-loads in full and has no cliff". Both files land in the same context window, so a
// relocation frees nothing. It moves the bytes past the only counter that was watching them.
//
// WHAT THAT COST, MEASURED. `AGENTS.md` went 32,243 bytes on 2026-08-19 to 146,898 on 2026-08-29 —
// 4.6x in ten days. §2.1 alone reached 57,982, and every byte was re-sent on every request, because
// `CLAUDE.md` pulls the file in via `@AGENTS.md` in full. #2620 moved §2.1's detail into
// `docs/agents-session-traps.md` and brought the total 176,363 -> 139,898. This is what keeps it
// there; without a counter the same growth resumes and nothing reports it until sessions feel slow.
//
// THE ONE PROPERTY WORTH MOST HERE IS THE LIVE GATE AT THE BOTTOM. Everything above it is
// arithmetic, and arithmetic tests pass against a budget nobody is subject to. `CLAUDE.md` and
// `AGENTS.md` are IN this repository, so CI can genuinely refuse a change that grows them past
// their share — which is the mechanical enforcement AGENTS.md §2.2 openly says the index itself can
// never have, because `MEMORY.md` lives under `~/.claude` where no required check can see it.
//
// THE DISTINCTION THIS FILE GUARDS HARDEST is `not_applicable` vs `unknown`. Nothing to measure
// must be SILENT (a fresh clone, CI, someone else's machine); something present that could not be
// measured must be LOUD. Collapsing the two either cries wolf on every clean checkout until the
// reader learns to skip the line, or reports a partial sum as healthy — and a footprint that
// under-reports is the only direction this can fail in that nobody notices.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  AUTOLOAD_FOOTPRINT_BUDGET,
  MEMORY_INDEX_READ_CEILING,
  assessAutoloadFootprint,
  autoloadFootprintLines,
  autoloadedFileBytes,
} from "../scripts/memory-index-budget.mjs";

type Part = { label: string; bytes: number | null };

const parts = (...entries: Array<[string, number | null]>): Part[] =>
  entries.map(([label, bytes]) => ({ label, bytes }));

const text = (verdict: ReturnType<typeof assessAutoloadFootprint>): string =>
  autoloadFootprintLines(verdict).join("\n");

export function runAutoloadFootprintBudgetTests() {
  // 1. NOTHING TO MEASURE IS SILENCE, NOT AN ALARM. The hook stays quiet on a checkout with no
  // auto-loaded files, exactly as it already does when there is no memory directory.
  const empty = assessAutoloadFootprint([]);
  assert.equal(empty.status, "not_applicable", "no auto-loaded files at all is not a failed measurement");
  assert.deepEqual(autoloadFootprintLines(empty), [], "and it must print nothing rather than a zero");

  // A non-array must land in the same place. The hook builds this list itself, but a caller that
  // passes undefined should get silence, not a crash inside a SessionStart hook — a hook that
  // throws produces no context at all, which looks exactly like a healthy one.
  assert.equal(
    assessAutoloadFootprint(undefined as unknown as Part[]).status,
    "not_applicable",
    "a missing list must degrade to silence, never throw inside the hook",
  );

  // 2. THE ARITHMETIC, AND THAT IT NAMES WHERE THE BYTES ARE. A total with no breakdown tells a
  // session it is over without telling it what to move.
  const ok = assessAutoloadFootprint(parts(["CLAUDE.md", 6_818], ["AGENTS.md", 112_154], ["MEMORY.md", 20_926]));
  assert.equal(ok.status, "ok");
  assert.equal(ok.bytes, 139_898, "the total is the sum of the parts, measured post-#2620");
  assert.equal(ok.headroomToBudget, AUTOLOAD_FOOTPRINT_BUDGET - 139_898);
  assert.equal(ok.mustFree, 0, "mustFree is zero inside budget so a caller can print it unconditionally");
  for (const label of ["CLAUDE.md", "AGENTS.md", "MEMORY.md"]) {
    assert.match(text(ok), new RegExp(label.replace(".", "\\.")), `the breakdown must name ${label}`);
  }

  // 3. THE HEALTHY LINE MUST NOT BORROW THE INDEX'S PHRASING. `session-start-memory-index-guard`
  // asserts a worktree session never sees "budget left" — the decoy it exists to catch is an index
  // misread as healthy. Two different figures wearing one sentence is how that check would start
  // passing for the wrong reason, silently, while still going green.
  assert.doesNotMatch(
    text(ok),
    /budget left/,
    "the footprint's healthy line must not reuse the memory index's 'bytes of budget left' phrasing",
  );
  assert.doesNotMatch(text(ok), /OVER/, "a healthy footprint must not carry an alarm word");

  // 4. OVER BUDGET SAYS THE RIGHT REMEDY, AND IT IS NOT THE INDEX'S REMEDY. When the INDEX is over,
  // relocating a hook into AGENTS.md is correct. When the TOTAL is over it buys nothing, because
  // both files are already inside the number — and a session told to relocate would do the exact
  // thing that caused this. Pinning the sentence pins the distinction.
  const over = assessAutoloadFootprint(parts(["CLAUDE.md", 6_818], ["AGENTS.md", 160_000]));
  assert.equal(over.status, "over_budget");
  assert.equal(over.mustFree, 166_818 - AUTOLOAD_FOOTPRINT_BUDGET, "it must name the exact bytes to free");
  assert.match(text(over), /OVER FOOTPRINT BUDGET/);
  assert.match(text(over), new RegExp(`free ${over.mustFree} bytes`), "the figure must reach the reader");
  assert.match(text(over), /does NOT help/, "it must say relocating into AGENTS.md does not help here");
  assert.match(text(over), /docs\//, "and it must name the remedy that does: move detail out of the loaded set");
  assert.match(
    text(over),
    /EVERY/,
    "it must say why this costs more than a big file: these bytes are re-sent on every request",
  );

  // 5. THE ARITHMETIC IS ONE-WAY. A file we know is loaded but could not size makes the TOTAL
  // unknowable. A partial sum graded "ok" is how the real figure drifts while the report reads
  // clean — the same failure the index's own `unknown` status exists to prevent.
  for (const bad of [null, 0, -1, Number.NaN]) {
    const poisoned = assessAutoloadFootprint(parts(["CLAUDE.md", 6_818], ["AGENTS.md", bad as number]));
    assert.equal(poisoned.status, "unknown", `bytes=${String(bad)} must poison the verdict, not be treated as zero`);
    assert.deepEqual(poisoned.unmeasured, ["AGENTS.md"], "and it must name which file it could not measure");
    assert.match(text(poisoned), /UNKNOWN, not healthy/, "an unmeasured part must be reported out loud");
    assert.doesNotMatch(text(poisoned), /budget left|of slack/, "it must never borrow the healthy phrasing");
  }

  // A big enough unmeasured part could hide a real overage entirely, which is the case that makes
  // the rule above matter rather than merely tidy.
  assert.equal(
    assessAutoloadFootprint(parts(["AGENTS.md", 140_000], ["MEMORY.md", null])).status,
    "unknown",
    "an unmeasured part must not be silently treated as zero when the measured half is near the line",
  );

  // 6. THE BUDGET SITS ABOVE THE INDEX'S OWN CEILING. The index may legitimately occupy up to its
  // loader cliff, so a footprint budget at or below that number would make the two rules
  // contradict each other — the index would be inside its budget and over the total by obeying it.
  assert.ok(
    AUTOLOAD_FOOTPRINT_BUDGET > MEMORY_INDEX_READ_CEILING,
    "the footprint budget must leave room for a legitimately full memory index",
  );

  // 7. THE LIVE GATE — the half of this that CI can actually enforce.
  //
  // `MEMORY.md` lives under `~/.claude` and no required check can see it, so the repository's own
  // share is what remains after allowing the index its full cliff. That is the honest split: it
  // never fails because somebody's local index grew, and it does fail when a PR grows the two files
  // that ARE in the repo past their room. This is the check that would have gone red while §2.1 was
  // climbing to 57,982 bytes, which nothing did.
  // Measured with CRLF discounted, so the gate scores the COMMIT and not the checkout that ran it.
  // `.gitattributes` pins `* text=auto eol=lf`, so git cannot hand anyone a CRLF `.md` — but that
  // same normalisation means a local tool rewriting one with CRLF leaves git reporting it
  // UNMODIFIED, and the gate would quietly start counting ~1 byte per line it is not judging.
  const repoShare = AUTOLOAD_FOOTPRINT_BUDGET - MEMORY_INDEX_READ_CEILING;
  const live = parts(
    ["CLAUDE.md", autoloadedFileBytes(readFileSync("CLAUDE.md"))],
    ["AGENTS.md", autoloadedFileBytes(readFileSync("AGENTS.md"))],
  );
  const liveBytes = live.reduce((sum, part) => sum + (part.bytes ?? 0), 0);
  assert.ok(
    liveBytes <= repoShare,
    `CLAUDE.md + AGENTS.md are ${liveBytes} bytes, over the ${repoShare} available to the repository `
      + `once the memory index is allowed its full ${MEMORY_INDEX_READ_CEILING}-byte cliff. These files `
      + "are re-sent to the model on EVERY request. Move detail into docs/ and leave a one-line hook "
      + "behind — docs/agents-session-traps.md is the worked example (AGENTS.md §2.2).",
  );

  // And the gate must be measuring something. A test that passes because it read an empty file, or
  // resolved a path that does not exist, is the failure mode source-pinning tests keep repeating.
  assert.ok(liveBytes > 50_000, "the live files must actually have been read, not silently resolved to nothing");

  // 8. THE GATE SCORES THE COMMIT, NOT THE CHECKOUT THAT RAN IT. CRLF and LF forms of identical
  // content must produce the identical figure, or the same commit passes on one machine and fails
  // on another for a difference nobody wrote.
  const lf = "line one\nline two\nline three\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(
    autoloadedFileBytes(Buffer.from(crlf, "utf8")),
    autoloadedFileBytes(Buffer.from(lf, "utf8")),
    "CRLF and LF forms of the same content must measure the same",
  );
  assert.equal(autoloadedFileBytes(Buffer.from(lf, "utf8")), lf.length, "and the LF form is the true length");

  // A LONE CR is a real byte and must still count — discounting every CR rather than only the one
  // in a CRLF pair would under-report a file that genuinely contains carriage returns.
  assert.equal(
    autoloadedFileBytes(Buffer.from("a\rb", "utf8")),
    3,
    "a carriage return that is not part of a CRLF pair is a real byte",
  );
  // Multi-byte characters must be counted as bytes, not as characters. AGENTS.md is full of em
  // dashes and arrows; counting `.length` on a decoded string would under-report every one of them.
  assert.equal(autoloadedFileBytes(Buffer.from("—", "utf8")), 3, "an em dash is three bytes, not one character");

  // 9. THE DOCTOR MUST ACTUALLY BE WIRED TO THIS. Same lesson as the unpushed-commits pin next
  // door: without it the module passes its own tests forever while `repo-doctor.mjs` never prints
  // the verdict, and the section that would have shown the growth simply does not exist. The
  // SessionStart half is proven end-to-end by driving the real hook in
  // `session-start-memory-index-guard.test.ts`; the doctor is a report, so its wiring is pinned by
  // source.
  const doctorSource = readFileSync("scripts/repo-doctor.mjs", "utf8");
  assert.ok(
    doctorSource.includes("autoloadFootprintLines"),
    "repo-doctor.mjs must print the footprint verdict, not merely be able to compute one",
  );
  assert.ok(
    doctorSource.includes("assessAutoloadFootprint"),
    "repo-doctor.mjs must delegate the grading rather than keep a second copy of the arithmetic",
  );

  // The hook is the half that reaches a session before it appends, so its wiring is pinned too —
  // and specifically the correction, because the OLD sentence is what caused this. A guard still
  // telling sessions that AGENTS.md "has no cliff", full stop, is advice to move bytes out of the
  // one counter watching them and into a file loaded on identical terms.
  const hookSource = readFileSync(".claude/hooks/memory-index-guard.mjs", "utf8");
  assert.ok(
    hookSource.includes("autoloadFootprintLines"),
    "the SessionStart guard must report the footprint, not only the memory index",
  );
  assert.match(
    hookSource,
    /no cliff of its OWN/,
    "the guard's relocation advice must carry the correction: AGENTS.md is inside the footprint budget",
  );
}
