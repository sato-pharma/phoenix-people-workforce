// A RELOCATED MEMORY IS REACHABLE, AND THE DOCTOR MUST NOT TELL ANYONE TO PUT IT BACK.
//
// WHY THIS EXISTS. `repo-doctor.mjs` asked one question of every memory file — does an index point
// at it? — and printed, for each answer of no: "give each orphan a line in MEMORY.md if it is a
// live rule". That advice became actively wrong the moment AGENTS.md section 2.2 made RELOCATION
// the prescribed remedy for an over-budget index. `MEMORY.md` is capped at 22,000 bytes against a
// 24,400-byte loader cliff; when compression runs out, a hook moves into AGENTS.md section
// 2.1 / 2.3 / 4, which `CLAUDE.md` loads in full with no cliff. Every such move then produced fresh
// "orphans" whose printed remedy was to undo the move and push the index straight back over budget.
// Measured 2026-08-29, hours after six hooks moved out: 7 orphans reported, 6 relocated on purpose.
//
// THE DISCRIMINATING CASE IS THAT SAME MORNING. `indexOnlyOrphans` below reproduces the pre-fix
// rule verbatim, and every case that matters pins BOTH answers — asserting the old rule called the
// relocated files orphans is what proves these tests discriminate rather than passing for free.
//
// THE DANGEROUS DIRECTION IS ONE-WAY, as in `memory-index-budget.test.ts`. A false orphan costs a
// reader a minute; a false "reachable" hides a memory that nothing can recall, which is the exact
// invisibility the 2026-08-19 sweep found 194 files sitting in. So an unreadable AGENTS.md must
// degrade to the old answer, never to silence.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyMemoryReachability,
  memoryReachabilityLines,
  namedInAgents,
} from "../scripts/memory-index-reachability.mjs";

const TICK = String.fromCharCode(96);
const tick = (slug: string) => TICK + slug + TICK;

// The pre-fix check, reproduced verbatim: repo-doctor filtered on the index pointer alone.
// Kept so every assertion can show what the old rule said about the same input.
function indexOnlyOrphans(files: string[], indexText: string): string[] {
  return files.filter((f) => !indexText.includes("](" + f + ")")).sort();
}

// The six hooks PR #2611 moved out of the index on 2026-08-29 — the input that exposed the bug.
const RELOCATED_2026_08_29 = [
  "at-slash-lib-shadows-src-lib-via-tsconfig-paths.md",
  "mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix.md",
  "nsm-outstation-expense-is-never-held.md",
  "tailwind-merge-strips-custom-named-font-sizes.md",
  "the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer.md",
  "turbify-cannot-issue-app-passwords-centrally-owner-stays.md",
];

export function runMemoryIndexReachabilityTests() {
  // ── 1. THE CASE THE OLD RULE GOT WRONG ────────────────────────────────────────────────────────
  // One linked hook, six relocated, one genuine orphan — the shape of the real directory that
  // morning. The old rule saw seven orphans; six of them were the prescribed remedy working.
  const files = [
    "still-linked-from-the-index.md",
    ...RELOCATED_2026_08_29,
    "a-mock-name-generator-reproduces-real-employee-names.md",
  ];
  const indexText = "- [a live hook](still-linked-from-the-index.md) - hook text\n";
  const agentsText = RELOCATED_2026_08_29.map((f) => "  " + tick(f.slice(0, -3)) + "\n").join("");

  assert.equal(
    indexOnlyOrphans(files, indexText).length,
    7,
    "PIN: the old index-only rule called all seven unlinked files orphans — if this ever reads 6 "
      + "the discriminator is gone and these tests stop proving anything",
  );

  const verdict = classifyMemoryReachability({ files, indexText, agentsText });
  assert.deepEqual(
    verdict.linked,
    ["still-linked-from-the-index.md"],
    "an ordinary indexed hook must still be counted as linked",
  );
  assert.deepEqual(
    verdict.relocated,
    [...RELOCATED_2026_08_29].sort(),
    "the six hooks relocated on 2026-08-29 must read as REACHABLE, not as orphans — this is the "
      + "exact input the pre-fix rule got wrong, and the whole reason this check exists",
  );
  assert.deepEqual(
    verdict.orphans,
    ["a-mock-name-generator-reproduces-real-employee-names.md"],
    "a file named in NEITHER the index nor AGENTS.md is still an orphan — the original check must "
      + "keep working, or the fix has simply blinded it",
  );

  // ── 2. the three buckets partition the input ──────────────────────────────────────────────────
  // If they ever overlap or drop a file, a count in the report becomes a lie about the directory.
  const total = verdict.linked.length + verdict.relocated.length + verdict.orphans.length;
  assert.equal(total, files.length, "the three buckets must account for every file exactly once");
  const seen = new Set([...verdict.linked, ...verdict.relocated, ...verdict.orphans]);
  assert.equal(seen.size, files.length, "no file may appear in two buckets");

  // ── 3. linked wins over relocated ─────────────────────────────────────────────────────────────
  // A hook can legitimately be both — the index line is trimmed only AFTER the AGENTS.md half is
  // merged, so during that window it is both linked and named. It must count once, as linked.
  const both = classifyMemoryReachability({
    files: ["dual.md"],
    indexText: "- [x](dual.md)",
    agentsText: tick("dual"),
  });
  assert.deepEqual(
    both.linked,
    ["dual.md"],
    "a file that is BOTH linked and named must count once, as LINKED — checking relocated first "
      + "would move it out of the bucket the index says it is in",
  );
  assert.deepEqual(both.relocated, [], "a file that is BOTH linked and named must not be counted twice");

  // ── 4. an unreadable AGENTS.md degrades to the OLD answer, never to silence ───────────────────
  // repo-doctor leaves agentsText at "" when the read throws, so "" is the live path, not a
  // synthetic edge. Over-reporting orphans is the safe failure; under-reporting hides a memory.
  for (const empty of ["", undefined as unknown as string]) {
    const blind = classifyMemoryReachability({ files, indexText, agentsText: empty });
    assert.deepEqual(
      blind.relocated,
      [],
      "with no AGENTS.md text nothing may be claimed reachable through it",
    );
    assert.equal(
      blind.orphans.length,
      7,
      "an unreadable AGENTS.md must fall back to the pre-fix answer — a false orphan is recoverable, "
        + "a false 'reachable' makes a memory invisible",
    );
  }

  // ── 5. the match is EXACT, not a substring ────────────────────────────────────────────────────
  // No memory slug is currently a substring of another, so a loose match would happen to work
  // today — which is the kind of accident that stops being true without warning. The closing
  // backtick is what makes it exact.
  assert.equal(
    namedInAgents("payroll.md", tick("payroll-batch-membership-is-historical")),
    false,
    "a LONGER slug must not satisfy a shorter one",
  );
  assert.equal(namedInAgents("payroll.md", tick("payroll")), true);
  assert.equal(
    namedInAgents("some-rule.md", "see some-rule for the full account"),
    false,
    "the backtick convention is the contract — a bare prose mention must not count, or any word "
      + "matching a filename would silently mark a memory reachable",
  );
  assert.equal(namedInAgents("MEMORY.md", ""), false, "an empty AGENTS.md can never name anything");
  assert.equal(
    namedInAgents("not-markdown.txt", tick("not-markdown.txt")),
    false,
    "only .md memory files are classified here",
  );

  // ── 6. THE ADVICE IS THE BUG — it must name AGENTS.md and must not undo a relocation ──────────
  // Reporting six extra orphans was only noise. What made it harmful is the sentence beside them,
  // so the wording is pinned to the classification rather than left to the caller.
  const withRelocated = memoryReachabilityLines({
    relocated: verdict.relocated,
    orphans: verdict.orphans,
    broken: [],
  }).join(" ");
  assert.match(withRelocated, /6 memory file\(s\) are reachable from AGENTS\.md/);
  assert.match(
    withRelocated,
    /Do NOT give these an index line/,
    "the report must say out loud that indexing a relocated hook undoes the relocation",
  );
  assert.match(withRelocated, /over budget/, "it must name the cost: MEMORY.md goes back over budget");
  assert.match(
    withRelocated,
    /relocate it into AGENTS\.md/,
    "a real orphan's remedy must offer relocation as a third destination, not just the two indexes",
  );
  assert.match(withRelocated, /1 orphan\(s\)/, "the genuine orphan must still be reported");

  // The healthy path must carry no alarm word, and must not advertise a remedy nobody needs.
  const clean = memoryReachabilityLines({ relocated: [], orphans: [], broken: [] }).join(" ");
  assert.match(clean, /Every memory file is reachable and every pointer resolves/);
  assert.doesNotMatch(clean, /Do NOT/, "a clean report must not carry the relocation warning");

  // Relocated files with no orphans is the normal state after a relocation: say the reassuring
  // half AND the clean verdict, so nobody reads the AGENTS.md line as a finding to act on.
  const relocatedOnly = memoryReachabilityLines({ relocated: ["a.md"], orphans: [], broken: [] }).join(" ");
  assert.match(relocatedOnly, /reachable from AGENTS\.md/);
  assert.match(relocatedOnly, /Every memory file is reachable/);

  // A broken pointer alone must still break the clean verdict — it is the mirror defect and was
  // never in scope of this fix.
  const brokenOnly = memoryReachabilityLines({ relocated: [], orphans: [], broken: ["gone.md"] }).join(" ");
  assert.match(brokenOnly, /1 broken pointer\(s\)/);
  assert.doesNotMatch(brokenOnly, /Every memory file is reachable/);

  // ── 7. the convention this whole matcher rests on is real, in the live file ───────────────────
  // Everything above is fixtures. This is the one assertion against the actual AGENTS.md: if a
  // future rewrite stops naming memories as backticked slugs — switching to links, say — the
  // matcher goes blind and every relocated hook silently reads as an orphan again. Counted 137 on
  // 2026-08-29; the floor is set well below that so ordinary retirement never trips it.
  const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
  const slugs = new Set(
    [...agents.matchAll(new RegExp(TICK + "([a-z0-9]+(?:-[a-z0-9]+){2,})" + TICK, "g"))].map((m) => m[1]),
  );
  assert.ok(
    slugs.size >= 50,
    `AGENTS.md names only ${slugs.size} backticked slugs; the reachability matcher assumes that `
      + "convention, so a collapse here means relocated memories are being reported as orphans",
  );
  assert.ok(
    slugs.has("tailwind-merge-strips-custom-named-font-sizes"),
    "the 2026-08-29 relocation must still be named in AGENTS.md — if it was removed without an "
      + "index line going back, that memory is now invisible (AGENTS.md 2.2, both halves or neither)",
  );
}
