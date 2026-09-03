import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A direct-order reversal must carry its original's family.
//
// `reverseDirectOrder` builds its new row by naming the original's fields one by one. That shape is
// safe for what it lists and silent about what it does not: `direct_order_requests.family_code` is
// nullable, so omitting it raised no error anywhere — the reversal was simply written with NO
// family. The same insert already carries a comment about `deal_type` defaulting to 'bonus' and
// mislabelling a reversed DISCOUNT order in every list, report and export. This is that trap again,
// one field along.
//
// Why the family matters: it is the direct-order basket allow-list. Lacto Advanced (Pedia) and
// Lacto Basic (Head Office) deliberately share `LA` so a basket combines them, and
// `phx_direct_order_item_family_guard` (20260812184500_direct_orders_request_items.sql) owns the
// invariant that every line of a request shares its request's family.
//
// It never self-healed. A reversal is a header-only insert — no `direct_order_request_items` row —
// so the guard's back-fill leg, the one that adopts a first line's family when the request has
// none, never fires for one. And the null is not inert: the guard reads "no family yet" as licence
// to ADOPT, so a reversal missing it could take whatever family a later line brought rather than
// refusing a mismatched one.
//
// Source-inspection rather than execution, for the same reason as
// direct-orders-reverse-authorization.test.ts: the path is Supabase-bound end to end, so the honest
// guard is to pin the lines that close it. The slice is bounded by the function's own name and the
// next `export`, never a byte window — a source-pinning test that slices fixed offsets false-fails
// the moment anything above it shifts.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/direct-orders/service.ts", import.meta.url)),
  "utf8",
);

const TYPES_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/direct-orders/types.ts", import.meta.url)),
  "utf8",
);

function sliceExportedFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist`);
  const nextExport = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, nextExport > 0 ? nextExport : undefined);
}

export function runDirectOrderReversalFamilyCodeTests() {
  const reversal = sliceExportedFunction(SERVICE_SOURCE, "export async function reverseDirectOrder");

  // ── THE HEADLINE: the reversal must mirror the original's family ────────────────────────
  assert.match(
    reversal,
    /family_code: original\.familyCode/,
    "A REVERSAL LOSES ITS BASKET'S FAMILY: reverseDirectOrder's insert must carry `family_code` from "
      + "the original. The column is nullable, so omitting it writes a reversal with no family at all "
      + "and raises nothing. It cannot be recovered later either — a reversal has no "
      + "direct_order_request_items row, so the trigger that back-fills a request's family from its "
      + "first line never fires for one.",
  );

  // The mirror must degrade to null, not to "". mapRequestRow reads the null a historic request
  // carries as an empty string, and the two are NOT the same value to the guard: null means "this
  // request has no family yet, adopt the first line's", while "" is a real family that matches
  // nothing, so `'' <> 'LA'` raises check_violation and no line could ever be added to that row.
  // Writing "" would therefore be strictly worse than the omission this test exists to fix.
  assert.match(
    reversal,
    /family_code: original\.familyCode \|\| null,/,
    "the reversal must write null, never \"\", when the original's family is unresolved — an empty "
      + "string is a family that matches nothing, and the item guard would refuse every line against it",
  );

  // ── The two legs that make the headline reachable ───────────────────────────────────────
  // mapRequestRow is what puts the column on the object the insert reads. Without this line
  // `original.familyCode` does not exist, and the field it feeds is the one above.
  const mapper = SERVICE_SOURCE.slice(
    SERVICE_SOURCE.indexOf("function mapRequestRow"),
    SERVICE_SOURCE.indexOf("function mapStepRow"),
  );
  assert.ok(mapper.length > 0, "mapRequestRow must exist above mapStepRow");
  assert.match(
    mapper,
    /familyCode: String\(row\.family_code \?\? ""\),/,
    "mapRequestRow must map family_code — it is the only reader that puts the column on a "
      + "DirectOrderRequest, and the reversal mirror above is its only consumer today, so a cleanup "
      + "that removes it as unused takes the fix with it",
  );

  // The type declaration is what makes that cleanup fail loudly instead of quietly: drop either the
  // mapper line or this field on its own and `typecheck` goes red rather than the reversal silently
  // writing undefined, which supabase-js omits from the payload — the original bug exactly.
  const requestType = TYPES_SOURCE.slice(
    TYPES_SOURCE.indexOf("export type DirectOrderRequest = {"),
    TYPES_SOURCE.indexOf("export const DIRECT_ORDER_WORKFLOW_MODULE_KEY"),
  );
  assert.ok(requestType.length > 0, "the DirectOrderRequest type must exist");
  assert.match(
    requestType,
    /^\s*familyCode: string;$/m,
    "DirectOrderRequest must declare familyCode, so removing the mapper line fails typecheck instead "
      + "of handing the reversal insert an undefined that supabase-js silently drops",
  );

  // ── The invariant the reversal now joins ────────────────────────────────────────────────
  // Both write paths that create a family-bearing request set the column. Pinned so the reversal is
  // not the odd one out again: if a future change stops the create paths setting it, the mirror
  // above starts copying nothing and this test says which end moved.
  const submit = sliceExportedFunction(SERVICE_SOURCE, "export async function submitDirectOrder");
  assert.match(
    submit,
    /family_code: familyCode,/,
    "submitDirectOrder must set the request's family_code from the resolved basket",
  );
  assert.match(
    SERVICE_SOURCE,
    /family_code: line\.familyCode,/,
    "each direct_order_request_items line must carry its own family_code — the guard compares it "
      + "against the request's",
  );
}
