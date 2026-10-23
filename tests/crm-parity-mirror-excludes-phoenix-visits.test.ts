import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compareVisitIdSets, decideParityAction } from "../src/lib/crm/parity.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE PARITY SWEEP COMPARES THE VENDOR AGAINST THE MIRROR TABLE, NEVER AGAINST THE UNIFIED VIEW.
 *
 * `crm_visits_unified` carries Phoenix-born visits beside the mirrored iReports360 ones — visits
 * logged in Phoenix CRM that the vendor has never held and never will. The sweep used to read the
 * window through `queryVisits`, which scans that view, so every Phoenix visit counted as a row the
 * vendor had "lost".
 *
 * Measured on production (`ozucdzovmcqvepbozvqf`, 23 Oct 2026). Window 2026-09-28 → 2026-10-23:
 * 7,336 mirrored rows + 4,780 Phoenix rows = the 12,116 the sweep read, against 7,345 rows from
 * the vendor. First Phoenix visit 2026-10-03; the same window was refused on 14 Oct at 2,013 extra
 * and on 23 Oct at 4,779, growing by roughly 300 a day. Two consequences, both of them live:
 * the newest window could never be verified again, and the 8 genuinely late-saved visits the
 * vendor did return on 23 Oct were not written into the mirror, because a refusal repairs nothing.
 *
 * The guard itself was never the problem — PARITY_MAX_DELETE_ROWS is what kept 4,779 Phoenix
 * visits from being counted as deletable. The comparison set was.
 */
export function runCrmParityMirrorExcludesPhoenixVisitsTests() {
  // ── (A) The incident's own numbers, through the decision core ────────────────────────────
  //
  // Ids are synthetic but their SHAPE is the production one: the vendor's set, the mirrored subset
  // of it, the 8 late saves only the vendor has, and a Phoenix block drawn from the reserved
  // positive range (1,000,000,000+) that no vendor answer can ever contain.
  const vendorIds = Array.from({ length: 7345 }, (_, index) => 500_000 + index);
  const mirroredIds = vendorIds.slice(0, 7337); // the 8 late saves are absent from the mirror
  const phoenixIds = Array.from({ length: 4780 }, (_, index) => 1_000_000_000 + index);

  const throughTheUnifiedView = compareVisitIdSets(vendorIds, [...mirroredIds, ...phoenixIds]);
  assert.equal(throughTheUnifiedView.mirrorRows, 12_117, "the view's row count is mirror + Phoenix");
  assert.equal(
    decideParityAction(throughTheUnifiedView).action,
    "refuse",
    "reading the unified view puts every Phoenix visit over the delete ceiling — this is the bug",
  );

  const throughTheMirrorTable = compareVisitIdSets(vendorIds, mirroredIds);
  assert.equal(throughTheMirrorTable.extraInMirror, 0, "the mirror holds nothing the vendor lost");
  assert.equal(throughTheMirrorTable.missingInMirror, 8, "the 8 late saves are the real finding");
  assert.equal(
    decideParityAction(throughTheMirrorTable).action,
    "repair",
    "against the mirror table the window is repairable — additions only, which destroy nothing",
  );

  // A window needing only ADDITIONS must never be refused, whatever its size: that is the late-save
  // case the sweep exists for, and adding rows cannot destroy history.
  const everyRowLate = compareVisitIdSets(vendorIds, []);
  assert.equal(
    decideParityAction(everyRowLate).action,
    "repair",
    "an empty mirror against a full vendor answer is a backfill, not a mass deletion",
  );

  // ── (B) The read itself — pinned at the source, because its target is the whole fix ──────
  //
  // There is no cheaper way to pin this: the relation is chosen inside a Supabase call the pure
  // core never sees, and the production symptom took a window of history out of verification for
  // nine days before anyone read the number.
  const code = stripComments(readFileSync("src/lib/crm/parity.ts", "utf8"));
  assert.ok(
    !/\bqueryVisits\s*[<(]/.test(code),
    "the sweep must not call queryVisits — it scans crm_visits_unified, Phoenix visits included",
  );
  assert.ok(
    !/\bcrm_visits_unified\b|CRM_VISITS_UNIFIED_VIEW/.test(code),
    "the sweep must never name the unified view; the mirror is ireports360_visits",
  );
  assert.ok(
    /\.from\(CRM_VISITS_TABLE\)[\s\S]{0,200}?\.select\("crm_visit_id"\)/.test(code),
    "the window's ids must be read off CRM_VISITS_TABLE (ireports360_visits) directly",
  );
  // Keyset, not .range(): an unordered page repeats ids and skips others, and a skipped id here
  // reads as a row the vendor deleted. Same fault class the sync's reconcile scan already fixed.
  assert.ok(
    /\.order\("crm_visit_id", \{ ascending: true \}\)/.test(code) && !/\.range\(/.test(code),
    "the mirror scan must page by keyset on crm_visit_id, never by .range()",
  );
}
