import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The GPS route map ellipsised a check-in's ADDRESS — the one line on that card that says where the
 * rep actually stood. Found 2026-09-21 by the CRM audit, and it is an unswept breach of a rule that
 * was settled long before: AGENTS.md §4, "never truncate text with an ellipsis", and its companion
 * "where it collides with the no-horizontal-scroll rule, WRAPPING wins".
 *
 * `field-workforce-route-map.tsx` renders the day's check-in trail under the visits drill-down, on
 * both the admin Field Workforce Compliance screen and the NSM Team Calendar. The address sat in a
 * `<p className="truncate">` inside a `min-w-0 flex-1` column, so a real Egyptian street address —
 * which is long, and whose distinguishing part is the END, not the start — was cut mid-word with no
 * `title` to recover it. Two check-ins on the same street read identically.
 *
 * The fix is `break-words`, not merely dropping `truncate`: an address arrives from the vendor as
 * one long run with few break opportunities, and the parent is already `min-w-0 flex-1`, so nothing
 * about the row's width changes — only whether the overflow wraps or is thrown away.
 *
 * Pinned by SHAPE, with comments stripped first, so this explanation cannot satisfy its own
 * assertions (AGENTS.md §2.1 — a pinning test that matched its own prose would pin the anti-pattern).
 */

const ROUTE_MAP = "src/components/field-workforce-compliance/field-workforce-route-map.tsx";

export function runCrmRouteMapAddressTests() {
  const source = stripComments(readFileSync(ROUTE_MAP, "utf8"));

  // The address line itself, identified by what it renders rather than by its classes — so the
  // assertion survives a restyle and still fails if `truncate` comes back to this element.
  const addressLine = source
    .split("\n")
    .find((line) => line.includes("{point.address}"));
  assert.ok(addressLine, `${ROUTE_MAP} no longer renders point.address — has the route trail been rewritten?`);
  assert.ok(
    !addressLine.includes("truncate"),
    "the check-in address must not be ellipsised: it is the only line saying where the rep stood",
  );
  assert.ok(
    addressLine.includes("break-words"),
    "dropping `truncate` alone is not enough — a vendor address is one long run and still overflows",
  );

  // And nowhere else in the trail either. The card has exactly two text lines (contact name and
  // address) and a time; an ellipsis on any of them is the same defect wearing a different label.
  assert.ok(
    !source.includes("truncate"),
    "no line of the route trail may ellipsise — wrapping is the answer the fits-the-screen rule names",
  );
  assert.ok(
    !/text-ellipsis|overflow-ellipsis/.test(source),
    "nor the long-hand ellipsis utilities, which the `truncate` check alone would not catch",
  );

  // The wrapping only costs nothing because the column can shrink. If this guard is ever removed the
  // address becomes a horizontal-scroll bug instead of an ellipsis bug — the other half of the rule.
  assert.ok(
    source.includes("min-w-0 flex-1"),
    "the address column must stay `min-w-0 flex-1`, or wrapping turns into overflow at 375px",
  );
}
