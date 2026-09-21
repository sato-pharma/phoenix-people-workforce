import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CRM_VISIT_TYPE_FILTER_CODES,
  CRM_VISIT_TYPE_OPTIONS,
  classifyVisit,
  resolveVisitTypeLabel,
} from "../src/lib/crm/visit-types.ts";
import { describeCrmDay } from "../src/lib/attendance/crm-day-maps.ts";

// iReports360 documents nine visit-type codes. It also sends seven it never documented, and for
// every one of those the `visitTypeDescription` it sends is the literal string "Unknown".
// Measured against the production mirror on 2026-08-21 — 2,965 of 122,814 visits:
//   -30 (868 rows) · -5 (1,633) · -20 (171) · -7 (148) · -19 (91) · -21 (28) · -6 (26)
// Phoenix has known what each one means since 2026-07-14 (PR #1061, owner-confirmed by reading
// the reps' own `comment` text), but that knowledge lived inside Employee 360 — so the CRM
// master, the employee portal, the NSM board and SFE analytics all still printed "Unknown".
// An eighth, -16, first appeared 2026-09-12 — 54 visits by 8 reps to 2026-09-17, every comment
// "Training" — and the owner ruled it Training on 2026-09-17.
const UNDOCUMENTED_CODES = [-5, -6, -7, -16, -19, -20, -21, -30] as const;

const FIXED_LABELS = [
  { code: -5, rows: 1633, label: "Vacations & Leaves" },
  { code: -6, rows: 26, label: "Vacations & Leaves" },
  { code: -19, rows: 91, label: "Meeting" },
  { code: -20, rows: 171, label: "Admin Work" },
  { code: -21, rows: 28, label: "Business Review (BRM)" },
];

export function runCrmVisitTypeLabelTests() {
  // THE HEADLINE: not one of the seven may reach a human as "Unknown" again.
  for (const code of UNDOCUMENTED_CODES) {
    const label = resolveVisitTypeLabel(code, "Unknown", null);
    assert.notEqual(
      label.trim().toLowerCase(),
      "unknown",
      `visit type ${code} must never display as "Unknown" — Phoenix knows what it is`,
    );
    assert.ok(label.trim().length > 0, `visit type ${code} must resolve to a non-empty label`);
  }

  // The five codes whose meaning does not depend on the rep's comment.
  for (const { code, rows, label } of FIXED_LABELS) {
    assert.equal(
      resolveVisitTypeLabel(code, "Unknown", null),
      label,
      `visit type ${code} (${rows} live rows) must resolve to "${label}"`,
    );
  }

  // -16 is Training (owner ruling 2026-09-17): same label AND same bucket as the documented -9, so
  // Employee 360 counts it as a training visit, never as admin work.
  assert.equal(resolveVisitTypeLabel(-16, "Unknown", "Training"), "Training", "-16 must display as Training");
  assert.equal(resolveVisitTypeLabel(-16, "Unknown", null), "Training", "-16 is Training whatever the comment says");
  assert.deepEqual(
    classifyVisit(-16, "Training", "Unknown"),
    classifyVisit(-9, "Training", "Training"),
    "-16 must classify exactly like the documented Training code (-9): label Training, bucket training",
  );

  // -7 and -30 are separable only by the rep's own free text, so the comment routes them.
  assert.equal(resolveVisitTypeLabel(-7, "Unknown", "Sales day"), "Health Day", "-7 'sales day' is a health day");
  assert.equal(resolveVisitTypeLabel(-7, "Unknown", "اجازه"), "Vacations & Leaves", "-7 Arabic leave is leave");
  assert.equal(resolveVisitTypeLabel(-7, "Unknown", "Weekly meeting"), "Meeting", "-7 meeting text is a meeting");
  assert.equal(resolveVisitTypeLabel(-7, "Unknown", null), "Admin Work", "-7 with no signal falls back to admin");
  assert.equal(resolveVisitTypeLabel(-30, "Unknown", "ص السلامه"), "Pharmacy Visit", "-30 pharmacy shorthand");
  assert.equal(resolveVisitTypeLabel(-30, "Unknown", "د طارق منصور"), "Regular", "-30 doctor call is a regular visit");

  // This is a gap-filler, NOT a rename. Wherever the vendor says something real, it still wins —
  // a Regular Visit must not start reading "Regular" on the CRM master.
  assert.equal(resolveVisitTypeLabel(0, "Regular Visit", null), "Regular Visit", "the vendor enum is untouched");
  assert.equal(resolveVisitTypeLabel(-4, "Annual Vacation", null), "Annual Vacation", "-4 keeps its vendor label");
  assert.equal(resolveVisitTypeLabel(-15, "Health Day", null), "Health Day", "-15 keeps its vendor label");
  assert.equal(resolveVisitTypeLabel(-8, "Campaign (Prospection)", "x"), "Campaign (Prospection)", "parens survive");

  // TRIPWIRE — read this before "simplifying" the resolver into an ingest-time normalization.
  // -5/-6 resolve to a label that contains "vacation". The CRM master's vacations dataset now selects
  // on visit_type = -4 (master.ts), so the label no longer decides membership there — but any reader
  // that still matches the description text (an ad-hoc query, an older export) would count these as
  // leave. The labels stay display-only and are never written back to ireports360_visits: stored,
  // 1,659 public-holiday and casual-leave rows would read as vacations wherever the text is matched.
  // This assertion states that consequence here rather than in payroll.
  assert.match(
    resolveVisitTypeLabel(-5, "Unknown", null),
    /vacation/i,
    "-5's label matches the vacations ilike — which is why a resolved label must stay out of the DB",
  );

  // The dropdown no longer offers "Unknown". It was never a kind of visit; it was seven kinds
  // wearing one name, and selecting it could only ever return all of them at once.
  assert.ok(
    !CRM_VISIT_TYPE_OPTIONS.includes("Unknown"),
    'the Visit Type dropdown must not offer "Unknown" any more',
  );
  for (const label of CRM_VISIT_TYPE_FILTER_CODES.keys()) {
    assert.ok(CRM_VISIT_TYPE_OPTIONS.includes(label), `"${label}" filters by code but is missing from the dropdown`);
  }

  // Every undocumented code must be reachable from the dropdown, exactly once.
  const allFilterCodes = [...CRM_VISIT_TYPE_FILTER_CODES.values()].flat();
  assert.equal(new Set(allFilterCodes).size, allFilterCodes.length, "no code may sit under two filter entries");
  const covered = allFilterCodes
    .filter((code) => (UNDOCUMENTED_CODES as readonly number[]).includes(code))
    .sort((a, b) => a - b);
  assert.deepEqual(
    covered,
    [...UNDOCUMENTED_CODES].sort((a, b) => a - b),
    "the code-based filter entries must cover all eight undocumented codes, with no duplicates",
  );
  assert.equal(
    new Set(CRM_VISIT_TYPE_OPTIONS).size,
    CRM_VISIT_TYPE_OPTIONS.length,
    "the Visit Type dropdown must not offer the same entry twice",
  );

  // Filtering the CRM master on "Training" must return the -16 visits too. They display as Training
  // but are stored as "Unknown", so the vendor text match returned only the -9 half (298 of the 352
  // training visits on production, 2026-09-17), and the screen undercounted what it showed.
  assert.deepEqual(
    [...(CRM_VISIT_TYPE_FILTER_CODES.get("Training") ?? [])].sort((a, b) => a - b),
    [-16, -9],
    'the "Training" filter must select both training codes (-9 and -16) by code, not by the stored text',
  );

  // OWNER RULING 2026-09-21 — "Meeting" and "Meetings" are ONE entry, and the surviving name is the
  // singular. The dropdown carried both: "Meeting" matched the stored description and returned the
  // vendor's own -11 rows (1,359 on production), while "Meetings" selected code -19 (96 rows). Two
  // entries one letter apart returning different rows read as a typo, and a manager picking either
  // one silently lost the other set. He chose to merge them rather than rename one.
  assert.deepEqual(
    [...(CRM_VISIT_TYPE_FILTER_CODES.get("Meeting") ?? [])].sort((a, b) => a - b),
    [-19, -11],
    'the "Meeting" filter must select the vendor code (-11) AND its undocumented twin (-19) by code',
  );
  assert.ok(
    !CRM_VISIT_TYPE_OPTIONS.includes("Meetings"),
    '"Meetings" was merged into "Meeting" (owner, 2026-09-21) and must not come back to the dropdown',
  );
  assert.equal(
    resolveVisitTypeLabel(-11, "Meeting", null),
    resolveVisitTypeLabel(-19, "Unknown", null),
    "-11 and -19 are one activity, so they must display under one name as well as filter as one entry",
  );

  // THE CLASS OF BUG, not just this instance: no two dropdown entries may differ only by case or by
  // a trailing "s". Such a pair cannot be told apart on screen, and because the filter has two
  // branches — by code, and by the stored description — the pair returns two different sets of rows.
  // "Group Meeting" (-2, 77 rows) is a genuinely different activity and is untouched by this.
  const collapseOption = (option: string) => option.toLowerCase().replace(/s$/, "");
  const optionsByCollapsedName = new Map<string, string[]>();
  for (const option of CRM_VISIT_TYPE_OPTIONS) {
    const key = collapseOption(option);
    optionsByCollapsedName.set(key, [...(optionsByCollapsedName.get(key) ?? []), option]);
  }
  for (const [, collided] of optionsByCollapsedName) {
    assert.equal(
      collided.length,
      1,
      `the Visit Type dropdown offers ${JSON.stringify(collided)} — entries differing only by case or ` +
        "a trailing plural are indistinguishable on screen and return different rows",
    );
  }

  // The attendance day detail shows the same label the CRM screens do: a -16 day reads "Training",
  // never the vendor's "Unknown". A real vendor description is still shown as sent.
  const dayRow = (visitType: number, description: string | null, comment: string | null) => ({
    visit_date: "2026-09-14",
    visit_type: visitType,
    visit_type_description: description,
    comment,
    customer_name: null,
    agent_hr_id: "B-1",
    double_hr_id: null,
  });
  assert.equal(
    describeCrmDay([dayRow(-16, "Unknown", "Training")]),
    "Training: Training",
    'a -16 day in the attendance CRM activity must read "Training", not "Unknown"',
  );
  assert.equal(
    describeCrmDay([dayRow(-19, "Unknown", "Weekly meeting")]),
    "Meeting: Weekly meeting",
    "an undocumented code takes its shared display label in the day detail",
  );
  assert.equal(
    describeCrmDay([dayRow(-15, "Health Day", "Clinic day")]),
    "Health Day: Clinic day",
    "a real vendor description is shown as sent",
  );
  assert.equal(describeCrmDay([dayRow(0, null, null)]), "Visit", "a regular visit with no description still reads Visit");

  runCommentSensitiveCodeTests();
  runVisitTypeSurfaceTests();
}

/**
 * THE TWO COMMENT-SENSITIVE CODES, AND WHY THEIR FILTER ENTRY IS NOT THEIR LABEL.
 *
 * Raised by review on 2026-09-21: a -7 row whose comment says "Weekly meeting" DISPLAYS as
 * "Meeting", but the "Meeting" filter selects only -11 and -19, so the report shows a label and then
 * hides the row when you pick it. That is accurate, and it is measured — all 1,130 -7/-30 rows on
 * production display a label other than the entry they file under (re-measured 2026-09-21):
 *
 *     629  -30  shown "Pharmacy Visit"      filed "Unlabeled Field Visit"
 *     333  -30  shown "Regular"             filed "Unlabeled Field Visit"
 *     101   -7  shown "Admin Work"          filed "Sales / Leave Day"
 *      32   -7  shown "Health Day"          filed "Sales / Leave Day"
 *      21   -7  shown "Vacations & Leaves"  filed "Sales / Leave Day"
 *      14   -7  shown "Meeting"             filed "Sales / Leave Day"
 *
 * OWNER RULING 2026-09-21, asked in plain words and answered: LEAVE IT EXACTLY AS IT IS. He was
 * shown the three options — leave it, rename "Sales / Leave Day" to say what is inside it, or fold
 * all 168 -7 rows into "Admin Work" — and chose to leave it. It is 168 visits in 134,928, one in
 * every 800, and the two alternatives each cost more than they buy. Do not re-raise this.
 *
 * It is also the DESIGN, stated in the doc comment above CRM_VISIT_TYPE_FILTER_CODES:
 * these two entries are code-grouped rather than label-exact, so selecting one returns every row
 * of that code and the per-row label stays honest. The alternative — mapping "Meeting" to
 * [-11, -19, -7] — would return the 104 rows shown as "Admin Work" under "Meeting", which is a worse
 * lie; and post-filtering on the resolved label is not open to us, because the Visits Report
 * paginates server-side with `count: "exact"` and dropping rows after the page is fetched would
 * make both the page and the total wrong.
 *
 * So this test does NOT assert the mismatch away. It pins the BOUNDARY: exactly two codes may be
 * comment-sensitive, and each must be filed under an entry no comment can ever produce. A third
 * such code added without a decision fails here, rather than quietly widening a screen that lies.
 */
function runCommentSensitiveCodeTests(): void {
  // Comments chosen to hit every branch of classifyAmbiguousComment / isPharmacyComment.
  const probes = [null, "Sales day", "اجازه", "Weekly meeting", "ص السلامه", "د طارق منصور", "x"];
  const commentSensitive = [...new Set([...CRM_VISIT_TYPE_FILTER_CODES.values()].flat())]
    .filter((code) => new Set(probes.map((c) => resolveVisitTypeLabel(code, "Unknown", c))).size > 1)
    .sort((a, b) => a - b);
  assert.deepEqual(
    commentSensitive,
    [-30, -7],
    "only -7 and -30 may change label with the comment — a third breaks the filter vocabulary silently",
  );

  const filterEntryFor = new Map<number, string>();
  for (const [label, codes] of CRM_VISIT_TYPE_FILTER_CODES) for (const code of codes) filterEntryFor.set(code, label);
  for (const code of commentSensitive) {
    const entry = filterEntryFor.get(code);
    const displayed = new Set(probes.map((comment) => resolveVisitTypeLabel(code, "Unknown", comment)));
    assert.ok(entry, `${code} must have a filter entry — otherwise its rows cannot be selected at all`);
    assert.ok(
      !displayed.has(entry!),
      `"${entry}" must be a GROUP name no row displays — sharing a name with one of its labels ` +
        "would hide that code's other labels behind it",
    );
    assert.ok(
      displayed.size > 1,
      `${code} is in the comment-sensitive set, so it must actually produce more than one label`,
    );
  }

  // The group names must also stay out of the per-row vocabulary entirely: if `resolveVisitTypeLabel`
  // ever started returning "Sales / Leave Day" for something, the grouping would become a real label
  // and the honest-label reasoning above would quietly stop being true.
  for (const groupName of ["Unlabeled Field Visit", "Sales / Leave Day"]) {
    for (const code of [-5, -6, -7, -9, -16, -19, -20, -21, -30, 0]) {
      for (const comment of probes) {
        assert.notEqual(
          resolveVisitTypeLabel(code, "Unknown", comment),
          groupName,
          `"${groupName}" is a filter GROUP, never a label a row may display`,
        );
      }
    }
  }
}

/**
 * THE TWO SURFACES THE RESOLVER NEVER REACHED, found by the CRM audit on 2026-09-21.
 *
 * The resolver and its dropdown vocabulary were settled long before this: "Unknown" was retired
 * from CRM_VISIT_TYPE_OPTIONS, the CRM master tab was taught to filter by CODE, and the attendance
 * day detail, the employee portal and the company activity report all call resolveVisitTypeLabel.
 * Two readers were simply never converted, so the settled rule was not in force where a manager
 * actually looks:
 *
 *   1. field-workforce-visits-view.tsx — the Field Workforce Compliance drill-down AND the NSM Team
 *      Calendar drill-down, one component behind both. It rendered `visit.visitTypeDescription`
 *      raw with a `?? \`type:N\`` fallback that could never fire, because the vendor's column is
 *      never null. On 2026-08-27, the Prophet's Birthday, all 156 of the day's rows read "Unknown".
 *   2. reads.ts — the Visits Report. Its filter was `.eq("visit_type_description", …)` with no code
 *      branch, and its dropdown was built by scanning every stored description in the window, so it
 *      offered the literal "Unknown" and could not offer the real names behind it. Picking a
 *      resolved name such as "Public Holiday" matched nothing at all.
 *
 * Pinned by SHAPE against the real files, with comments stripped first, so this explanation cannot
 * satisfy its own assertions (AGENTS.md §2.1).
 */
function runVisitTypeSurfaceTests(): void {
  const strip = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");

  const view = strip(readFileSync("src/components/field-workforce-compliance/field-workforce-visits-view.tsx", "utf8"));
  assert.ok(
    view.includes("resolveVisitTypeLabel"),
    "the FWC / Team Calendar visit drill-down must resolve the label, not print the vendor's column",
  );
  assert.ok(
    !/\{\s*visit\.visitTypeDescription/.test(view),
    'the drill-down must never render visit.visitTypeDescription directly — that is what printed "Unknown"',
  );

  const reads = strip(readFileSync("src/lib/crm/reads.ts", "utf8"));
  assert.ok(
    reads.includes("CRM_VISIT_TYPE_FILTER_CODES"),
    "the Visits Report filter must select the resolved names by CODE, the way the CRM master tab does",
  );
  // PINNED AS THE WHOLE TERNARY, on the `codes` variable — never a bare `.in("visit_type"`, which
  // reads.ts has had at the double-visit door since long before this change. Measured 2026-09-21:
  // with the loose pattern, a filter whose two branches were the SAME
  // `.eq("visit_type_description", …)` — the no-op the draft actually carried — passed green.
  assert.ok(
    /const codes = CRM_VISIT_TYPE_FILTER_CODES\.get\(filters\.visitType\);\s*result = codes\s*\?\s*result\.in\("visit_type", codes\)\s*:\s*result\.eq\("visit_type_description", filters\.visitType\);/.test(
      reads,
    ),
    'the resolved-name branch must run .in("visit_type", codes); only a label with no codes behind it may fall back to the stored description',
  );
  assert.ok(
    reads.includes("CRM_VISIT_TYPE_OPTIONS"),
    "the Visits Report dropdown must be the shared resolved vocabulary, not the stored descriptions",
  );
  assert.ok(
    !reads.includes("getDistinctVisitTypes"),
    "the window-wide scan that built the dropdown from stored text is gone — it could only offer \"Unknown\"",
  );
  assert.ok(
    reads.includes("visitTypeDescription: resolveVisitTypeLabel("),
    "mapVisitRow is the one choke point feeding both the report table and its export — resolve there",
  );
}
