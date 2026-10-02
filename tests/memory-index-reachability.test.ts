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
  classifyMemoryReachabilityAcrossRefs,
  loaderVisiblePrefix,
  memoryReachabilityLines,
  namedInAgents,
  readModuleMemoryText,
  splitOverMarkedByAutoLoadedIndex,
  strandedLines,
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

  // ── 7. the convention this whole matcher rests on is real, in the live files ────
  // Everything above is fixtures. This is the assertion against the actual AGENTS.md: if a future
  // rewrite stops naming memories as backticked slugs — switching to links, say — the matcher goes
  // blind and every relocated hook silently reads as an orphan again.
  //
  // THIS USED TO BE A COUNT, `slugs.size >= 50`, AND THE COUNT WAS THE WRONG INSTRUMENT. It went red
  // on 2026-09-01 when the slug references were deliberately moved into docs/agents-memory-map.md,
  // taking 8,916 bytes off a file `CLAUDE.md` re-sends on every request (75,406 — 66,490). Unique
  // slugs fell 156 — 26 and main went red, but nothing was actually orphaned: repo-doctor measured
  // 969 memory files, 952 index pointers, 18 reachable through AGENTS.md and ZERO orphans, because
  // every relocated slug named a file `MEMORY.md` already links. The floor reported a defect that
  // did not exist, and it failed for the exact change it should have been indifferent to.
  //
  // (Three different byte figures were quoted for that relocation while it was being fixed — 6,921,
  // 7,783 and 8,108 — and a stale slug count of 137 from 2026-08-29. The numbers above are the ones
  // the repository actually yields; re-measure rather than copying any of the others forward.)
  //
  // It was also measuring noise. Of the 26 matches left in AGENTS.md only 18 are memory slugs at
  // all; the other 8 are `x-phoenix-role`, `europe-west4-drams3a`, `eu-central-1`, `overflow-x-auto`
  // and friends — header names, regions and a CSS class that happen to be lowercase and hyphenated.
  // A threshold over that mixture cannot say anything precise about memory reachability.
  //
  // So the check is now the invariant itself, by NAME rather than by count, and it is strictly
  // stronger than the floor it replaces. The map marks every memory whose ONLY pointer is AGENTS.md
  // as "(inline — load-bearing)". Each of those MUST still be backticked in AGENTS.md: remove one
  // without giving it an index line and that memory becomes unrecallable, which is the exact
  // invisibility this whole file exists to prevent. A count could be satisfied by any 50 slugs; this
  // cannot be satisfied by anything except the right ones.
  //
  // Do NOT restore a floor by re-adding duplicate slugs to AGENTS.md: that duplication is the
  // footprint this repo just paid to remove, and the per-memory guarantee now lives in the
  // by-name check below and in repo-doctor's live reachability scan — never in a count.
  //
  // NOT checked in the other direction, deliberately: "every AGENTS.md slug appears in the map"
  // would fail on those same 8 non-memory strings, and widening the pattern to exclude them would
  // put a second, drifting copy of the convention in this file.
  const slugsIn = (text: string) =>
    new Set(
      [...text.matchAll(new RegExp(TICK + "([a-z0-9]+(?:-[a-z0-9]+){2,})" + TICK, "g"))].map((m) => m[1]),
    );

  const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
  const slugs = slugsIn(agents);
  assert.ok(
    slugs.size > 0,
    "AGENTS.md names no backticked slugs at all; the reachability matcher assumes that convention, "
      + "so a collapse here means relocated memories are being reported as orphans",
  );

  const memoryMap = readFileSync(join(process.cwd(), "docs/agents-memory-map.md"), "utf8");
  const loadBearing: string[] = [];
  for (const line of memoryMap.split(/\r?\n/)) {
    if (!/inline\s*[—-]\s*load-bearing/.test(line)) continue;
    for (const slug of slugsIn(line)) loadBearing.push(slug);
  }
  // The marker is what makes the assertion below mean anything. If a rewrite drops the convention,
  // `loadBearing` empties and the loop passes vacuously — green while saying nothing.
  assert.ok(
    loadBearing.length >= 10,
    `docs/agents-memory-map.md marks only ${loadBearing.length} rows "(inline — load-bearing)"; that `
      + "marker is the only record of which memories AGENTS.md is the ONLY pointer for, so losing it "
      + "makes the check below vacuous rather than false",
  );
  // Module memory (2026-10-02, docs/module-memory.md) moved most §2.3/§4 hooks into
  // `.claude/rules/<module>.md`, and each moved hook carried its slug with it. A slug named there is
  // as recallable as one named in AGENTS.md: the module file loads with the module.
  const moduleSlugs = slugsIn(readModuleMemoryText(process.cwd()));
  assert.deepEqual(
    loadBearing.filter((slug) => !slugs.has(slug) && !moduleSlugs.has(slug)),
    [],
    "every memory the map marks load-bearing must still be named in AGENTS.md or a module memory file "
      + "— each one listed here has had its last pointer removed and can no longer be recalled by "
      + "anything (AGENTS.md 2.2)",
  );
  assert.ok(
    slugs.has("tailwind-merge-strips-custom-named-font-sizes"),
    "the 2026-08-29 relocation must still be named in AGENTS.md — if it was removed without an "
      + "index line going back, that memory is now invisible (AGENTS.md 2.2, both halves or neither)",
  );

  // ── 8. A STRANDED MEMORY IS NAMED, NOT MERELY COUNTED ─────────────────────────────────────────
  // WHY THIS EXISTS. The CLI shipped on 2026-09-04 computed the stranded set and printed only its
  // SIZE. The gap surfaced the same day, on the trim this very tool was built to make safe: the
  // `gh pr merge` hook was cut from MEMORY.md once its AGENTS.md half had merged to main, and the
  // report said "1 reachable from neither". True, and useless — identifying which memory had just
  // gone unrecallable took three greps by hand. A count tells you a memory cannot be recalled;
  // only a name tells you which file to put back.
  //
  // `countOnly` reproduces the pre-fix rendering so every assertion below can show what the old
  // output said about the same input — the same discriminating trick section 1 uses on the old
  // index-only rule. Without it these would pass for free on any string containing a slug.
  const countOnly = (orphans: string[]) => orphans.length + " reachable from neither";

  const STRANDED = "gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded";
  const LONG_DESCRIPTION =
    "From a secondary worktree, gh pr merge prints a fatal about main already being used by a "
    + "worktree and exits non-zero AFTER the remote merge already succeeded — read the PR state, "
    + "never retry the merge, because retrying errors on an already-merged PR.";

  const named = strandedLines({
    orphans: [STRANDED + ".md"],
    describe: () => ({ type: "project", description: LONG_DESCRIPTION }),
  });
  const namedText = named.join("\n");

  assert.doesNotMatch(
    countOnly([STRANDED + ".md"]),
    new RegExp(STRANDED),
    "PIN: the pre-fix rendering was a bare count and could not name anything — if this ever matches, "
      + "the discriminator is gone and the assertions below stop proving the fix",
  );
  assert.match(
    namedText,
    new RegExp(STRANDED),
    "a stranded memory must be named. This is the whole fix: the report has to say WHICH file went "
      + "unrecallable, because that is the one thing the reader has to act on",
  );
  assert.match(namedText, /\(project\)/, "the type routes the fix — 2.2 sends different kinds to different destinations");

  // The description is what recall matches on, and the owner's standing rule bans truncating text
  // with an ellipsis. Wrapping is the permitted answer, so the whole sentence must survive it.
  assert.ok(
    namedText.replace(/\s+/g, " ").includes(LONG_DESCRIPTION),
    "the description must be printed WHOLE across wrapped lines — it is the field that decides "
      + "whether a memory is recalled at all, so a trimmed one cuts away the half that says where "
      + "the hook belongs",
  );
  assert.doesNotMatch(namedText, /…/, "no ellipsis: the owner's standing rule is that text is never truncated with one");

  // A memory with no description is worse off than the others — recall cannot match it even after
  // it is re-indexed — so the report must say that rather than printing a reassuring blank.
  const noDescription = strandedLines({ orphans: ["bare.md"], describe: () => ({}) }).join("\n");
  assert.match(noDescription, /bare/);
  assert.match(noDescription, /no description/, "an undescribed memory must be called out, not shown as a blank line");

  // NO SILENT CAP. A truncated list that does not say it was truncated reads as "that is all of
  // them" — the confidently-wrong outcome AGENTS.md rule 1 exists for. This matters most in the
  // exact case the cap exists for: an unreadable AGENTS.md strands every memory at once.
  const many = Array.from({ length: 27 }, (_, i) => "bulk-hook-" + String(i).padStart(2, "0") + ".md");
  const capped = strandedLines({ orphans: many, limit: 20 }).join("\n");
  assert.equal(
    capped.split("\n").filter((l) => /^ {4}bulk-hook-/.test(l)).length,
    20,
    "the cap must actually cap",
  );
  assert.match(capped, /7 more not listed/, "the count NOT printed must be stated out loud");
  assert.match(capped, /--all/, "and so must the flag that prints the rest");

  const uncapped = strandedLines({ orphans: many, limit: Infinity }).join("\n");
  assert.equal(
    uncapped.split("\n").filter((l) => /^ {4}bulk-hook-/.test(l)).length,
    27,
    "--all must print every one",
  );
  assert.doesNotMatch(uncapped, /more not listed/, "nothing was withheld, so nothing may claim it was");

  // The healthy path carries no alarm and offers no remedy nobody needs — the same discipline
  // section 6 pins on the advice lines.
  const noneStranded = strandedLines({ orphans: [] }).join("\n");
  assert.match(noneStranded, /none — every memory file is reachable/);
  assert.doesNotMatch(
    noneStranded,
    /Give each a line/,
    "a clean report must not print routing advice for a backlog that does not exist",
  );

  // ── 9. THE REPORTING-DIRECTION FIX — a stale primary must not report a merged hook as ORPHAN ──
  // WHY THIS EXISTS. Measured 2026-09-05: the primary checkout was 29 commits behind origin/main,
  // and `repo-doctor`'s MEMORY INDEX section resolved every slug against ONLY the working tree's
  // AGENTS.md. `main-is-not-the-primary-checkout` was already backticked on origin/main (added by
  // PR #3298) but read as ORPHAN here — and the section's own remedy ("give it a line in
  // MEMORY.md") would have written a SECOND hook for a rule already live on `main`, reproducing the
  // exact duplicate PR #3298 existed to clean up. `classifyMemoryReachabilityAcrossRefs` is the fix:
  // it unions the local read with origin/main's before calling a memory an orphan.
  const acrossFiles = ["merged-elsewhere.md", "never-merged-anywhere.md"];
  const acrossIndexText = "";

  // The exact shape of the incident: the slug is on origin/main, not on the stale local copy.
  const staleLocal = classifyMemoryReachabilityAcrossRefs({
    files: acrossFiles,
    indexText: acrossIndexText,
    agentsText: "",
    originAgentsText: tick("merged-elsewhere"),
  });
  assert.deepEqual(
    staleLocal.orphans,
    ["never-merged-anywhere.md"],
    "a slug present on origin/main but absent from the stale local AGENTS.md must NOT read as an "
      + "orphan — this is the exact 2026-09-05 case, and getting it wrong means telling the next "
      + "session to write a duplicate index line",
  );
  assert.deepEqual(
    staleLocal.relocated,
    ["merged-elsewhere.md"],
    "the rescued file must still count as relocated (reachable), not silently disappear from both "
      + "buckets",
  );
  assert.deepEqual(
    staleLocal.rescuedByOrigin,
    ["merged-elsewhere.md"],
    "the file must be named as rescued-by-origin specifically, so the report can say the checkout "
      + "is behind rather than presenting a plain, unexplained 'reachable'",
  );

  // A slug on NEITHER copy is still a genuine orphan — the fix must not blind the check entirely.
  assert.deepEqual(
    staleLocal.rescuedByOrigin.includes("never-merged-anywhere.md"),
    false,
    "a file reachable from neither ref must not be marked rescued",
  );

  // A slug already present locally (no staleness in play) must not be reported as rescued — it was
  // never an orphan to begin with, and marking it rescued would misattribute an ordinary relocation
  // to the origin/main union.
  const alreadyLocal = classifyMemoryReachabilityAcrossRefs({
    files: ["already-local.md"],
    indexText: "",
    agentsText: tick("already-local"),
    originAgentsText: "",
  });
  assert.deepEqual(alreadyLocal.relocated, ["already-local.md"]);
  assert.deepEqual(
    alreadyLocal.rescuedByOrigin,
    [],
    "a file already reachable via the LOCAL AGENTS.md must not be marked rescued-by-origin — it was "
      + "never an orphan in the first place",
  );

  // THE SAFE DIRECTION, restated for this fix: when origin/main cannot be read at all (offline, no
  // remote-tracking ref, git failure — repo-doctor passes "" in that case, same as an unreadable
  // local file), this must degrade to the ORIGINAL local-only answer, never to a false "reachable".
  const originUnreadable = classifyMemoryReachabilityAcrossRefs({
    files: acrossFiles,
    indexText: acrossIndexText,
    agentsText: "",
    originAgentsText: "",
  });
  assert.deepEqual(
    originUnreadable.orphans,
    [...acrossFiles].sort(),
    "with origin/main unreadable, every file must fall back to the pre-fix, local-only answer — "
      + "under-claiming reachability is the one safe failure this file tolerates",
  );
  assert.deepEqual(originUnreadable.rescuedByOrigin, []);

  // The trimming CLI (memory-index-reachability.mjs's own main()) must stay untouched by this fix:
  // `classifyMemoryReachability` (not `...AcrossRefs`) is still what it calls, and passing it only
  // the local agentsText must still call an origin/main-only slug an orphan — the correct answer
  // for "is it safe to delete this line from THIS checkout right now".
  const trimCheck = classifyMemoryReachability({
    files: ["merged-elsewhere.md"],
    indexText: "",
    agentsText: "",
  });
  assert.deepEqual(
    trimCheck.orphans,
    ["merged-elsewhere.md"],
    "the trim-direction check must remain local-only — origin/main having a slug today says "
      + "nothing about whether an in-progress local edit is about to remove the only copy that "
      + "will exist once it merges",
  );

  // ── 9. AN ARCHIVE-ONLY LINK IS NOT A LICENCE TO TRIM THE MARKER ───────────────────────────────
  //
  // The CLI's marker check printed every over-marked slug as "an index links it too, so the marker
  // over-claims — not a risk", because it asked the reachability question with `MEMORY.md` and
  // `MEMORY-ARCHIVE.md` CONCATENATED. For the stranding question that is correct and stays. For the
  // MARKER question it is not: §2.2 makes `MEMORY.md` the ONLY auto-loaded memory file, so a slug
  // whose sole index link is in the archive still needs its AGENTS.md line — that line is the last
  // pointer any session loads without being told to go looking.
  //
  // Measured 2026-09-21 on the real map: three marked slugs had ZERO matches in `MEMORY.md` and
  // appeared only in `MEMORY-ARCHIVE.md`, and the CLI called all three a harmless over-claim. Acting
  // on that would have deleted the last auto-loaded pointer to three live rules.
  const ARCHIVE_ONLY_SLUG = "owner-sheet-vocabulary-stores-is-office-upa-is-a-channel";
  const AUTO_LOADED_SLUG = "a-pharmacy-is-not-a-contact";
  const archiveText = "- [depth](" + ARCHIVE_ONLY_SLUG + ".md) — parked on purpose\n";
  const autoLoadedText = "- [live](" + AUTO_LOADED_SLUG + ".md) — a hook\n";

  const split = splitOverMarkedByAutoLoadedIndex({
    overMarked: [ARCHIVE_ONLY_SLUG, AUTO_LOADED_SLUG],
    autoLoadedIndexText: autoLoadedText,
  });
  assert.deepEqual(
    split.archiveOnly,
    [ARCHIVE_ONLY_SLUG],
    "a marked slug that MEMORY.md does NOT link must be reported as still load-bearing — the archive "
      + "does not auto-load, so cutting its AGENTS.md slug drops the rule out of every session's "
      + "context even though nothing is technically stranded",
  );
  assert.deepEqual(
    split.recallable,
    [AUTO_LOADED_SLUG],
    "a marked slug MEMORY.md does link is the genuine harmless over-claim — that verdict must survive",
  );

  // THE DISCRIMINATING HALF, as everywhere above: pin what the PRE-FIX rule said about the same
  // input. It asked only whether EITHER index linked the file, so it called the archive-only slug
  // harmless — the reassurance this section exists to remove. Without this assertion the two cases
  // above could pass for free.
  const preFixCalledItHarmless = (archiveText + autoLoadedText).includes("](" + ARCHIVE_ONLY_SLUG + ".md)");
  assert.equal(
    preFixCalledItHarmless,
    true,
    "the pre-fix rule (either index counts) DID call the archive-only slug a harmless over-claim — "
      + "if this ever reads false the fixture no longer reproduces the bug and the test above proves nothing",
  );

  // THE SAFE DEGRADE, one-way as in section 4. An unreadable `MEMORY.md` arrives as "" and must put
  // every slug on the keep-the-marker side, never silently clear a marker it could not measure.
  assert.deepEqual(
    splitOverMarkedByAutoLoadedIndex({
      overMarked: [ARCHIVE_ONLY_SLUG, AUTO_LOADED_SLUG],
      autoLoadedIndexText: "",
    }),
    { recallable: [], archiveOnly: [AUTO_LOADED_SLUG, ARCHIVE_ONLY_SLUG].sort() },
    "with MEMORY.md unreadable every marker must be kept — a marker kept for nothing costs a reader "
      + "a line, a marker dropped on a bad reassurance costs a live rule its only auto-loaded pointer",
  );

  // An empty marker list is the ordinary healthy case and must not throw or invent a slug.
  assert.deepEqual(splitOverMarkedByAutoLoadedIndex({ overMarked: [], autoLoadedIndexText: autoLoadedText }), {
    recallable: [],
    archiveOnly: [],
  });

  // A SUBSTRING MUST NOT COUNT AS A LINK. Memory slugs nest (`...-is-office-upa-is-a-channel` vs a
  // longer slug ending in it), and the link form is matched with its `](` and `)` for exactly that
  // reason. A bare `includes(slug)` would read a longer neighbour's line as this slug's own pointer
  // and clear a marker that is still load-bearing.
  assert.deepEqual(
    splitOverMarkedByAutoLoadedIndex({
      overMarked: ["a-pharmacy-is-not-a-contact"],
      autoLoadedIndexText: "- [other](not-a-pharmacy-is-not-a-contact-either.md) — a different memory\n",
    }).archiveOnly,
    ["a-pharmacy-is-not-a-contact"],
    "a longer slug's index line must not be read as this slug's pointer",
  );

  // ── 10. A LINK PAST THE LOADER CLIFF IS NOT A LINK ANY SESSION SEES ───────────────────────────
  //
  // Section 9 fixed "which index links it". This is the same mistake one level down: `MEMORY.md` is
  // auto-loaded only up to MEMORY_INDEX_READ_CEILING bytes and truncated there SILENTLY, so reading
  // the WHOLE file classifies a link in the invisible tail as recallable — and the CLI would then
  // call the marker a harmless over-claim and invite a session to cut the last pointer anybody
  // loads. It bites exactly when this tool is being used: an index over budget, mid-trim.
  const CEILING = 24_400;
  const PAST_CLIFF_SLUG = "past-the-cliff-memory";
  const pastCliffLine = "- [tail](" + PAST_CLIFF_SLUG + ".md) — parked past the cliff\n";
  const overCliffIndex = "x".repeat(CEILING) + "\n" + pastCliffLine;

  // The fixture must genuinely contain the link, or everything below passes for free.
  assert.equal(
    overCliffIndex.includes("](" + PAST_CLIFF_SLUG + ".md)"),
    true,
    "the fixture must really carry the link in its tail, or this section proves nothing",
  );

  assert.deepEqual(
    splitOverMarkedByAutoLoadedIndex({
      overMarked: [PAST_CLIFF_SLUG],
      autoLoadedIndexText: loaderVisiblePrefix(overCliffIndex).text,
    }),
    { recallable: [], archiveOnly: [PAST_CLIFF_SLUG] },
    "a link past the loader cliff is invisible to every session, so the marker guarding it is still "
      + "load-bearing — grading against the visible prefix is what keeps the last pointer alive",
  );

  // THE DISCRIMINATING HALF: reading the whole file is precisely what the bug did.
  assert.deepEqual(
    splitOverMarkedByAutoLoadedIndex({
      overMarked: [PAST_CLIFF_SLUG],
      autoLoadedIndexText: overCliffIndex,
    }).recallable,
    [PAST_CLIFF_SLUG],
    "reading the FULL index calls the invisible link a harmless over-claim — pinned so the assertion "
      + "above keeps discriminating rather than passing for free",
  );

  // THE CEILING IS BYTES, NOT CHARACTERS. The index is full of em-dashes and emoji, so a
  // `.length`-based prefix would over-read by hundreds of bytes and reintroduce the same bug for
  // every link in that window. An em-dash is three UTF-8 bytes and one character.
  const tenEmDashes = "—".repeat(10);
  assert.equal(tenEmDashes.length, 10, "ten characters");
  assert.equal(loaderVisiblePrefix(tenEmDashes, 30).truncated, false, "thirty bytes fits a 30-byte ceiling");
  assert.equal(
    loaderVisiblePrefix(tenEmDashes, 29).truncated,
    true,
    "a character-counting implementation would see 10 and call 29 roomy — the ceiling is bytes",
  );
  assert.equal(loaderVisiblePrefix(tenEmDashes, 29).bytes, 30, "`bytes` reports the FULL size, not the prefix");

  // An index under the cliff is returned untouched — the common case must not be mangled.
  const underCliff = "- [live](" + AUTO_LOADED_SLUG + ".md) — a hook\n";
  assert.deepEqual(loaderVisiblePrefix(underCliff), {
    text: underCliff,
    bytes: Buffer.byteLength(underCliff, "utf8"),
    truncated: false,
  });
}
