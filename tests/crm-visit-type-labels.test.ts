import assert from "node:assert/strict";

import {
  CRM_VISIT_TYPE_FILTER_CODES,
  CRM_VISIT_TYPE_OPTIONS,
  classifyVisit,
  resolveVisitTypeLabel,
} from "../src/lib/crm/visit-types.ts";

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
  { code: -19, rows: 91, label: "Meetings" },
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
  assert.equal(resolveVisitTypeLabel(-7, "Unknown", "Weekly meeting"), "Meetings", "-7 meeting text is a meeting");
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
  const covered = [...CRM_VISIT_TYPE_FILTER_CODES.values()].flat().sort((a, b) => a - b);
  assert.deepEqual(
    covered,
    [...UNDOCUMENTED_CODES].sort((a, b) => a - b),
    "the code-based filter entries must cover all eight undocumented codes, with no duplicates",
  );
}
