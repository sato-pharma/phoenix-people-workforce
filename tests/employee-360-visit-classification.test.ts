import assert from "node:assert/strict";

import { classifyVisit, isProductiveVisit } from "../src/lib/employee-360/service.ts";

// Regression coverage for the "Unknown" activity-mix fix (PR #1061): iReports360
// sends the literal string "Unknown" as visit_type_description for 7 CRM type
// codes. The owner reviewed real production comment samples for each and gave
// explicit labeling/counting rules (2026-07-14) — this locks those rules in so
// they can never silently regress back to a bare "Unknown".

export async function runEmployee360VisitClassificationTests() {
  // ── Known productive types (unchanged behavior) ──
  assert.deepEqual(classifyVisit(0, null, "Regular"), { label: "Regular", bucket: "regular" });
  assert.deepEqual(classifyVisit(-8, null, "Campaign"), { label: "Campaign", bucket: "campaign" });
  assert.deepEqual(classifyVisit(-9, null, "Training"), { label: "Training", bucket: "training" });

  // ── -5 Holiday, -6 Casual Leave — both fold into one "Vacations & Leaves" label ──
  assert.deepEqual(classifyVisit(-5, "اجازة عيد الفطر المبارك", "Unknown"), { label: "Vacations & Leaves", bucket: "admin" });
  assert.deepEqual(classifyVisit(-6, "Casual Leave", "Unknown"), { label: "Vacations & Leaves", bucket: "admin" });
  assert.deepEqual(classifyVisit(-6, "Morning Excuse", "Unknown"), { label: "Vacations & Leaves", bucket: "admin" });

  // ── -19 Meeting, -20 Admin Work, -21 BRM — clean 1:1 labels ──
  assert.deepEqual(classifyVisit(-19, "Weekly meeting", "Unknown"), { label: "Meetings", bucket: "admin" });
  assert.deepEqual(classifyVisit(-20, "Admin work", "Unknown"), { label: "Admin Work", bucket: "admin" });
  assert.deepEqual(classifyVisit(-20, "Interviews", "Unknown"), { label: "Admin Work", bucket: "admin" });
  assert.deepEqual(classifyVisit(-21, "BRM Cairo", "Unknown"), { label: "Business Review (BRM)", bucket: "admin" });

  // ── -7 is split by the comment text itself (owner-confirmed: no single meaning) ──
  assert.deepEqual(classifyVisit(-7, "Sales day", "Unknown"), { label: "Health Day", bucket: "admin" });
  assert.deepEqual(classifyVisit(-7, "Health day", "Unknown"), { label: "Health Day", bucket: "admin" });
  assert.deepEqual(classifyVisit(-7, "اجازه", "Unknown"), { label: "Vacations & Leaves", bucket: "admin" });
  assert.deepEqual(classifyVisit(-7, "meeting with team", "Unknown"), { label: "Meetings", bucket: "admin" });
  assert.deepEqual(classifyVisit(-7, "something with no clear signal", "Unknown"), { label: "Admin Work", bucket: "admin" }, "no match falls back to Admin Work, never bare Unknown");
  assert.deepEqual(classifyVisit(-7, null, "Unknown"), { label: "Admin Work", bucket: "admin" }, "null comment also falls back to Admin Work");

  // ── -30 unlabeled field visits: real client visits, counted as productive.
  //    Pharmacy-flavored comments get their own distinct label; everything else
  //    folds into "Regular" (owner: "put it in its normal place"). ──
  assert.deepEqual(
    classifyVisit(-30, "ص السلامه", "Unknown"),
    { label: "Pharmacy Visit", bucket: "regular" },
    "ص as a standalone token before a name signals a pharmacy call",
  );
  assert.deepEqual(
    classifyVisit(-30, "زيارة فارما لمتابعة تنفيذ أوردر صيدليات نبيل الطرشوبي", "Unknown"),
    { label: "Pharmacy Visit", bucket: "regular" },
  );
  assert.deepEqual(
    classifyVisit(-30, "د طارق منصور", "Unknown"),
    { label: "Regular", bucket: "regular" },
    "a plain doctor-name comment with no pharmacy signal folds into Regular",
  );
  assert.deepEqual(classifyVisit(-30, null, "Unknown"), { label: "Regular", bucket: "regular" });

  // ── Pharmacy detection must not false-positive on unrelated Arabic words that
  //    merely start with the same letter (ص) — it requires an isolated token. ──
  assert.deepEqual(
    classifyVisit(-30, "صباح الخير دكتور", "Unknown"),
    { label: "Regular", bucket: "regular" },
    "ص embedded inside a longer word (صباح) must not trigger the pharmacy heuristic",
  );

  // ── Any other/unseen negative type still shows its real CRM description
  //    verbatim, or a traceable "Type N" fallback — never invents a label. ──
  assert.deepEqual(classifyVisit(-11, null, "Meeting"), { label: "Meeting", bucket: "admin" });
  assert.deepEqual(classifyVisit(-4, null, "Vacation"), { label: "Vacation", bucket: "admin" });
  assert.deepEqual(classifyVisit(-99, null, null), { label: "Type -99", bucket: "admin" });
  assert.deepEqual(classifyVisit(-99, null, "Unknown"), { label: "Type -99", bucket: "admin" }, "a genuinely-unmapped code still never surfaces the bare word Unknown");

  // ── isProductiveVisit: the shared yes/no check used by check-in coverage and
  //    the impact engine must agree exactly with classifyVisit's bucket. ──
  assert.equal(isProductiveVisit({ visit_type: 0, comment: null, visit_type_description: "Regular" }), true);
  assert.equal(isProductiveVisit({ visit_type: -8, comment: null, visit_type_description: "Campaign" }), true);
  assert.equal(isProductiveVisit({ visit_type: -30, comment: "ص السلامه", visit_type_description: "Unknown" }), true, "pharmacy visit counts as productive");
  assert.equal(isProductiveVisit({ visit_type: -30, comment: "د طارق منصور", visit_type_description: "Unknown" }), true, "non-pharmacy -30 also counts as productive (folded into Regular)");
  assert.equal(isProductiveVisit({ visit_type: -5, comment: "Holiday", visit_type_description: "Unknown" }), false, "a holiday is never productive");
  assert.equal(isProductiveVisit({ visit_type: -9, comment: null, visit_type_description: "Training" }), false, "training is not productive");
}
