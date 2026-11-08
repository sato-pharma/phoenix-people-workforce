import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveResignationActions } from "../src/lib/action-center/resignation-actions.ts";
import { humanizeCode } from "../src/lib/format/code-label.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Other Approvals showed "No workflow actions available." on every resignation from 2026-10-29:
// #6658 changed the printed status to "Under review", and the buttons were still chosen by
// comparing that PRINTED label (spaces swapped for underscores) with "under_review". The buttons are
// now chosen from the stored status code, which the item carries as `detail.status`.
// ─────────────────────────────────────────────────────────────────────────────

export function runResignationInboxActionsTests() {
  const keys = (status: string) => resolveResignationActions(status).map((action) => action.key);

  // A submitted resignation can be taken into review or rejected; one under review can be decided.
  assert.deepEqual(keys("submitted"), ["mark_review", "reject"]);
  assert.deepEqual(keys("under_review"), ["approve", "reject"]);

  // The shape that broke: the label as people read it. It must still offer the buttons.
  assert.deepEqual(keys(humanizeCode("under_review")), ["approve", "reject"]);
  assert.deepEqual(keys(humanizeCode("submitted")), ["mark_review", "reject"]);

  // A finished or unknown resignation offers nothing.
  for (const status of ["approved", "rejected", "cancelled", "completed", "", "nonsense"]) {
    assert.deepEqual(keys(status), [], `no buttons for "${status}"`);
  }
  assert.deepEqual(resolveResignationActions(null), []);

  // Both places that build the inbox item carry the stored status, and the screen reads it —
  // never the printed label.
  const service = readFileSync(new URL("../src/lib/action-center/service.ts", import.meta.url), "utf8");
  const hubRoute = readFileSync(new URL("../app/api/approvals-hub/hub-data/route.ts", import.meta.url), "utf8");
  const hub = readFileSync(new URL("../src/components/action-center/action-center-hub.tsx", import.meta.url), "utf8");
  assert.match(service, /module: "resignation",\s*status: record\.status,/);
  assert.match(hubRoute, /module: "resignation", status: record\.status,/);
  assert.match(hub, /resolveResignationActions\(selected\.detail\.status\)/);
  assert.doesNotMatch(hub, /resolveResignationActions\(selected\.statusLabel/);
}
