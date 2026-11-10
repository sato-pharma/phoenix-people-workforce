import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOrgCode } from "../src/lib/imports/org-rule-engine.ts";
import {
  ORG_TITLE_ACRONYMS,
  ORG_TITLE_MINOR_WORDS,
  ORG_TITLE_PHRASES,
  toOrgTitleCase,
} from "../src/lib/imports/org-title-case.ts";

// Recurrence guard: the importer must stop inventing miscased org names.
//
// When an employee upload names a department/line/area/team/position that does not exist yet, the
// importer has no human label to use, so it builds one from the CODE. The old implementation
// upper-cased the first letter of each word and lower-cased the rest, which produced — measured in
// production 2026-08-28 — the position titles `Hr Manager`, `Qppv`, `Ceo`, `Sfe Manager` and
// `R And D Manager`. All five were corrected by hand that day. Nothing stopped the next one.
//
// Two halves, and BOTH are needed:
//   * the behavioural half pins the casing rule and, more importantly, the ROUND TRIP;
//   * the source half pins that both consumers still route through the one shared helper. This
//     function existed as two byte-identical private copies until this change, so "fixed" meant
//     "fixed in one of the two places" and the other went on being wrong silently.
//
// THE ROUND TRIP IS THE PART THAT MATTERS. A prettier title that no longer slugs back to its own
// code is far worse than an ugly one: `collectOrganizationEntities` matches existing rows BY CODE,
// so a display name whose code has drifted stops matching and the next upload inserts a DUPLICATE
// seat, silently, with employees split across the two. Every case below is asserted both ways.

const acronymCases: ReadonlyArray<{
  readonly code: string;
  readonly expected: string;
  readonly note: string;
}> = [
  // The five titles that were actually wrong in production on 2026-08-28.
  { code: "hr_manager", expected: "HR Manager", note: "position 6, was 'Hr Manager'" },
  { code: "qppv", expected: "QPPV", note: "position 17, was 'Qppv'" },
  { code: "ceo", expected: "CEO", note: "position 1, was 'Ceo'" },
  { code: "sfe_manager", expected: "SFE Manager", note: "position 20, was 'Sfe Manager'" },
  {
    code: "r_and_d_manager",
    expected: "R&D Manager",
    note: "position 18, was 'R And D Manager' — needs the phrase rule, not a word rule",
  },
  // Other acronyms already present in production org data, so the next row created from one of
  // these is born correct rather than hand-fixed later.
  { code: "hr_operations_coordinator", expected: "HR Operations Coordinator", note: "position 12" },
  { code: "cns", expected: "CNS", note: "line" },
  { code: "alex_bhr", expected: "Alex BHR", note: "team, 16 rows" },
  { code: "toll_manufacturing_manager_tmm", expected: "Toll Manufacturing Manager TMM", note: "position 18 since 2026-11-10" },
  // Ordinary names must be untouched by all of the above.
  {
    code: "medical_representative",
    expected: "Medical Representative",
    note: "position 2, 111 employees — the common case must not move",
  },
  { code: "supply_chain", expected: "Supply Chain", note: "department" },
  { code: "anti_infective", expected: "Anti Infective", note: "line" },
  // The minor-word rule. Production stores this title with a lower-case "and" on BOTH the
  // employees row (B-185) and the positions row (`finance_and_admin_manager`); a caser that
  // renders "And" rewrites real, correct data on the next upload.
  {
    code: "finance_and_admin_manager",
    expected: "Finance and Admin Manager",
    note: "position + B-185's job_title — the one live title the minor-word rule protects",
  },
];

const sourceOf = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

export async function runOrgTitleCaseAcronymTests() {
  // ── Headline: an acronym code produces an acronym title ──
  //
  // This is the whole rule. If someone reverts the acronym handling, this is the assertion that
  // must go red — verified by doing exactly that before shipping (see the PR body).
  //
  // Collected rather than thrown one at a time: runTest() rethrows on the first failure, so a bare
  // loop over 11 cases reports only case 1 and hides the rest — the trap that made #2479 print one
  // route and conceal three identical ones plus every test after it.
  const casingFailures: string[] = [];
  const roundTripFailures: string[] = [];

  for (const { code, expected, note } of acronymCases) {
    const actual = toOrgTitleCase(code.replace(/_/g, " "));

    if (actual !== expected) {
      casingFailures.push(`${code}: expected "${expected}", got "${actual}" (${note})`);
    }

    // The safety property: the generated display name must still slug back to the code it came
    // from. `createOrgCode` lower-cases before slugging and rewrites `&` to " and ", so casing is
    // free and "R&D Manager" returns to `r_and_d_manager`. Asserted, not reasoned about.
    const roundTripped = createOrgCode(actual);

    if (roundTripped !== code) {
      roundTripFailures.push(`"${actual}" slugs to "${roundTripped}", expected "${code}"`);
    }
  }

  assert.equal(
    casingFailures.join(" | "),
    "",
    `org title casing regressed for ${casingFailures.length} of ${acronymCases.length} cases`,
  );
  assert.equal(
    roundTripFailures.join(" | "),
    "",
    `a generated display name no longer slugs back to its own code — the next import would create a duplicate seat: ${roundTripFailures.length} case(s)`,
  );

  // ── Every acronym in the set is upper-cased and code-stable ──
  //
  // A runtime assertion over the whole set, so adding an entry cannot quietly do nothing (or, worse,
  // break the round trip) without a test noticing. The lesson from the NaN-sort-key incident: back a
  // hand-maintained collection by iterating it, never by trusting that it was filled in correctly.
  const setFailures: string[] = [];

  for (const acronym of ORG_TITLE_ACRONYMS) {
    const rendered = toOrgTitleCase(acronym);

    if (rendered !== acronym.toUpperCase()) {
      setFailures.push(`${acronym} rendered as "${rendered}"`);
    }

    if (createOrgCode(rendered) !== createOrgCode(acronym)) {
      setFailures.push(
        `${acronym} changes code when cased: "${createOrgCode(acronym)}" -> "${createOrgCode(rendered)}"`,
      );
    }
  }

  assert.equal(setFailures.join(" | "), "", "an ORG_TITLE_ACRONYMS entry is unsafe");

  // An acronym in brackets is still an acronym (2026-11-10). "Toll Manufacturing Manager (TMM)" is a
  // live title, and the bare-word match turned it into "(tmm)" on every import of it.
  assert.equal(toOrgTitleCase("Toll Manufacturing Manager (TMM)"), "Toll Manufacturing Manager (TMM)");
  assert.equal(toOrgTitleCase("toll manufacturing manager (tmm)"), "Toll Manufacturing Manager (TMM)");
  assert.equal(toOrgTitleCase("Delta (2)"), "Delta (2)", "a bracketed number is still left alone");
  assert.ok(ORG_TITLE_ACRONYMS.size > 0, "the acronym set was emptied");
  assert.ok(ORG_TITLE_PHRASES.length > 0, "the phrase rules were emptied");

  // ── Idempotent ──
  //
  // f(f(x)) must equal f(x). Nothing re-normalizes a display name today — all four call sites feed
  // this `code.replace(/_/g, " ")` — but a caser that degrades its own output ("R&D" -> "R&d") is a
  // trap set for whoever adds the fifth call site.
  const idempotenceFailures: string[] = [];

  for (const { code } of acronymCases) {
    const once = toOrgTitleCase(code.replace(/_/g, " "));
    const twice = toOrgTitleCase(once);

    if (once !== twice) {
      idempotenceFailures.push(`"${once}" -> "${twice}"`);
    }
  }

  assert.equal(idempotenceFailures.join(" | "), "", "toOrgTitleCase is not idempotent");

  // ── Words with no letters survive untouched ──
  //
  // Team names carry bracketed suffixes — Delta (1), Delta (2), Delta (3) — and area names carry
  // digits. The original implementation passed these through and so must this one.
  assert.equal(toOrgTitleCase("delta (1)"), "Delta (1)");
  assert.equal(toOrgTitleCase("upper egypt 2"), "Upper Egypt 2");

  // ── The phrase rule cannot fire inside a longer word ──
  //
  // `/\br\s+and\s+d\b/` is anchored on word boundaries. Without them it would eat the middle of
  // perfectly ordinary names, and the damage would be invisible until somebody read a report.
  // "docto[r and d]entist" contains the phrase as a raw substring and must NOT be rewritten.
  assert.equal(toOrgTitleCase("doctor and dentist liaison"), "Doctor and Dentist Liaison");
  assert.equal(toOrgTitleCase("finance and admin manager"), "Finance and Admin Manager");

  // ── Minor words are lower-cased in the middle, never at either end ──
  //
  // Ordinary English title case, and the reason B-185's live title survives a re-upload. First and
  // last word always capitalise, so a name that IS a minor word cannot be flattened to nothing.
  assert.equal(toOrgTitleCase("head of quality"), "Head of Quality");
  assert.equal(toOrgTitleCase("director for the delta"), "Director for the Delta");
  assert.equal(toOrgTitleCase("and"), "And", "a single minor word is the first word — capitalise");
  assert.equal(
    toOrgTitleCase("supply and"),
    "Supply And",
    "a trailing minor word is the LAST word — capitalise, per ordinary title case",
  );

  // `a` is deliberately NOT a minor word: the live sales line codes are the bare letters A, C and P,
  // so "team a support" must keep its "A". Same weigh-the-false-positive reasoning that keeps `it`
  // out of the acronym set.
  assert.equal(toOrgTitleCase("team a support"), "Team A Support");
  assert.ok(!ORG_TITLE_MINOR_WORDS.has("a"), "`a` must stay out of the minor-word set");

  // Every minor word must be code-stable, exactly as the acronym set is: lower-casing a word must
  // not change the slug, or a generated display name stops matching its own row.
  const minorWordFailures: string[] = [];

  for (const minorWord of ORG_TITLE_MINOR_WORDS) {
    const rendered = toOrgTitleCase(`alpha ${minorWord} omega`);

    if (rendered !== `Alpha ${minorWord} Omega`) {
      minorWordFailures.push(`${minorWord} rendered "${rendered}"`);
    }

    if (createOrgCode(rendered) !== createOrgCode(`alpha ${minorWord} omega`)) {
      minorWordFailures.push(`${minorWord} changes its code when cased`);
    }
  }

  assert.equal(minorWordFailures.join(" | "), "", "an ORG_TITLE_MINOR_WORDS entry is unsafe");
  assert.ok(ORG_TITLE_MINOR_WORDS.size > 0, "the minor-word set was emptied");

  // The acronym set must win over the minor-word set if the two ever overlap.
  for (const acronym of ORG_TITLE_ACRONYMS) {
    assert.ok(
      !ORG_TITLE_MINOR_WORDS.has(acronym),
      `"${acronym}" is in BOTH sets — the two rules would fight`,
    );
  }

  // ── Source pin: exactly ONE implementation, and both consumers use it ──
  //
  // The defect this replaces was duplication: `org-rule-engine.ts` and `employee-normalizers.ts`
  // each held a byte-identical private `toTitleCase`, so fixing the one you happened to open left
  // the other wrong with no signal at all. If a local copy comes back, this goes red.
  const consumers = [
    "../src/lib/imports/org-rule-engine.ts",
    "../src/lib/imports/employee-normalizers.ts",
  ] as const;

  for (const relativePath of consumers) {
    const source = sourceOf(relativePath);

    assert.ok(
      !source.includes("function toTitleCase("),
      `${relativePath} defines a local toTitleCase again — that duplication is exactly what let one copy stay broken`,
    );
    assert.ok(
      source.includes('from "@/lib/imports/org-title-case"'),
      `${relativePath} no longer imports the shared org title caser`,
    );
    assert.ok(
      source.includes("toOrgTitleCase("),
      `${relativePath} no longer calls toOrgTitleCase — a display name is being built some other way`,
    );
  }
}
