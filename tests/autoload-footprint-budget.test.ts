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
  // A CRLF copy of CLAUDE.md was live in a sibling worktree while this was written — 6,924 bytes
  // against a 6,818-byte blob, with `git status` reporting it clean, because `.gitattributes`
  // normalises on read before comparing. Without this the gate counts ~1 byte per line it is not
  // judging. See `autoloadedFileBytes` for the full measurement.
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
  // The floor was 50,000 until the owner had AGENTS.md shrunk to ~28 KB on 2026-10-24 (weekly usage).
  assert.ok(liveBytes > 25_000,"the live files must actually have been read, not silently resolved to nothing");

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
  // 2026-10-02: the relocation advice itself is retired — module memory (docs/module-memory.md)
  // replaced "move it into AGENTS.md", which is what kept the startup files at their ceilings. The
  // guard now routes a module fact to its module and must never send it back to AGENTS.md.
  assert.match(
    hookSource,
    /one module to its memory/,
    "the guard must route a module fact to that module's memory (.claude/rules/<module>.md)",
  );
  assert.doesNotMatch(
    hookSource,
    /it into AGENTS\.md, which auto-loads in full/,
    "the retired advice — relocate a hook into AGENTS.md — must not come back",
  );

  // 10. THE REPORTED SLACK AND THE ENFORCED MARGIN ARE DIFFERENT NUMBERS, AND ONLY ONE FAILS CI.
  //
  // This section exists because of a real incident on 2026-09-09. A session read the banner's
  // "bytes of slack", added a ~900-byte hook to AGENTS.md that fitted inside it, and shipped `main`
  // red. Both figures were correct; they answer different questions. The total's slack lends the
  // repository whatever headroom the index is not using today. The gate does not lend it.
  const marked = (...entries: Array<[string, number | null, boolean]>) =>
    entries.map(([label, bytes, inRepo]) => ({ label, bytes, inRepo }));

  // The exact bytes that were live when `main` went red. The total says there is room; the enforced
  // share says there is not. If these two ever agree on that day's numbers, the banner has gone back
  // to answering the question nobody is graded on.
  const incident = assessAutoloadFootprint(
    marked(["CLAUDE.md", 6_700, true], ["AGENTS.md", 119_126, true], ["MEMORY.md", 20_762, false]),
  );
  assert.equal(incident.status, "ok", "the TOTAL was inside budget that day — which is what misled the session");
  assert.equal(incident.repoStatus, "over", "while the ENFORCED share was already over, and that is what CI failed on");
  assert.equal(incident.repoBytes, 125_826, "the enforced figure counts the repo files ONLY, never the index");
  assert.equal(incident.repoShare, AUTOLOAD_FOOTPRINT_BUDGET - MEMORY_INDEX_READ_CEILING);
  assert.equal(incident.repoMustFree, 226, "and it must name how many bytes to free, not merely that it is over");
  assert.ok(
    incident.headroomToBudget > 0 && incident.repoHeadroom < 0,
    "the two figures must be able to disagree in SIGN — that disagreement is the whole point",
  );
  assert.match(text(incident), /OVER THE REPO SHARE/, "and the printed text must say so in the words of the gate");

  // THE SHARE IS THE CEILING, NOT THE INDEX'S ACTUAL SIZE. A smaller index must not buy the
  // repository a single byte, or the gate becomes a function of a file CI cannot see.
  const tinyIndex = assessAutoloadFootprint(
    marked(["CLAUDE.md", 6_700, true], ["AGENTS.md", 119_126, true], ["MEMORY.md", 1_000, false]),
  );
  assert.equal(
    tinyIndex.repoHeadroom,
    incident.repoHeadroom,
    "shrinking MEMORY.md by 19KB must not move the enforced margin by one byte",
  );

  // The healthy case still names the enforced number, and still names it as the one to budget
  // against. A line printing both figures without saying which is the gate is the status quo.
  const healthy = assessAutoloadFootprint(
    marked(["CLAUDE.md", 6_700, true], ["AGENTS.md", 117_299, true], ["MEMORY.md", 20_762, false]),
  );
  assert.equal(healthy.repoStatus, "ok");
  assert.equal(healthy.repoHeadroom, 1_601, "the post-trim margin, measured on origin/main 2026-09-09");
  assert.ok(
    healthy.repoHeadroom < healthy.headroomToBudget,
    "the enforced margin is the smaller of the two whenever the index is under its ceiling",
  );
  assert.match(
    text(healthy),
    /ENFORCED SHARE \(CI grades it on your PR head\)/,
    "the printed line must label which figure the gate uses — and WHERE it is graded",
  );
  assert.match(text(healthy), /Budget against THIS/, "and must tell the reader which of the two to trust");
  // 🔴 AND IT MUST SAY WHICH TREE IT MEASURED. The number comes from the session's own checkout; CI
  // grades the PR head. In the shared primary that tree is routinely a commit or two behind
  // `origin/main` — sessions here merge about 46 times a day — so the margin is stale in either
  // direction, while a tight one reads as a verdict on the merged repository, which it is not.
  // Measured 2026-10-02: the banner said `125586 of 125600 — 14 bytes left` while `origin/main`
  // stood at 124819, i.e. 781 bytes of room, because the checkout was ONE commit behind the merge
  // that had just freed 767 of them by moving an account out of AGENTS.md. A session acting on 14
  // bytes trims room it already has, undoing the work of the session that freed it.
  assert.match(
    text(healthy),
    /Measured from THIS checkout/,
    "the enforced margin must say it came from this tree, not from what CI will grade",
  );
  assert.match(
    text(healthy),
    /git fetch` before acting on a tight one/,
    "and must name the one action that settles a tight margin",
  );

  // REFUSING TO GUESS. An unmarked part must make the enforced margin UNKNOWN rather than a
  // plausible smaller number: leaving a repo file out of the sum would report MORE room than the
  // gate allows, which is the one direction that fails silently.
  const unmarked = assessAutoloadFootprint(parts(["CLAUDE.md", 6_700], ["AGENTS.md", 119_126]));
  assert.equal(unmarked.repoStatus, "unknown", "a part with no `inRepo` flag makes the enforced share unknowable");
  assert.equal(unmarked.status, "ok", "without disturbing the total, which does not depend on the flag");
  assert.match(text(unmarked), /REPO SHARE UNKNOWN/, "and it must say so out loud rather than print a number");
  assert.doesNotMatch(
    text(unmarked),
    /bytes left/,
    "an unknown share must never borrow the healthy sentence — that is how it would read as fine",
  );

  // 11. BOTH REPORTERS MUST ACTUALLY MARK THEIR PARTS. Same lesson as #9: the module can grade
  // correctly forever while every caller feeds it unmarked parts, and then every session and every
  // doctor run prints UNKNOWN — technically honest, and useless.
  assert.match(
    hookSource,
    /inRepo:\s*true/,
    "the SessionStart guard must mark CLAUDE.md/AGENTS.md as the repository's half",
  );
  assert.match(
    hookSource,
    /label:\s*"MEMORY\.md",[^}]*inRepo:\s*false/,
    "and must mark the index as outside the repo, since no required check can see it",
  );
  assert.match(doctorSource, /inRepo:\s*true/, "repo-doctor must mark its parts too, or its report says UNKNOWN");
}
