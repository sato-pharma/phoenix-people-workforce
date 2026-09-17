import type { AccessContext } from "@/lib/auth/permissions";
import { MARKETING_OVERSIGHT_LINE_ROLES } from "@/lib/sales/access-scope";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { periodLabel } from "@/lib/sales/monthly-closing-period-merge";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — the publication gate on DETAILS and on the scoped export.
//
// A month reaches a portal viewer only once the owner publishes it. The portal SCREEN always kept
// that rule (loadPortalMonthlyClosing offers and loads published periods only), but the two APIs
// behind the same tab did not:
//
//   · GET /api/sales/monthly-closing/details took the period from every VALIDATED month and, asked
//     for no period, opened the newest one — usually the month still being uploaded. The
//     standalone Details page asks exactly that on first load, so the leak needed no crafted URL.
//   · POST /api/sales/monthly-closing/export, scoped branch, loaded the rows with no publication
//     check and downloaded them with HTTP 200. loadPortalMonthlyClosing answers an unpublished month
//     with the newest published one, so the workbook named for the unpublished month wrapped its
//     sales in the published month's products, targets and Office grid; a line with nothing
//     published got Data + Total sheets instead.
//
// Found 2026-09-16 while adding Medical Rep to the portal Monthly Closing tab.
//
// WHO IS GATED: everyone EXCEPT the readers the export route's full-workbook branch admits. Super
// Admin / system scope, SFE Manager, CEO and Finance Manager read every validated month (Finance
// Manager "including periods that were never published", owner 2026-08-10), and the Marketing
// Manager's full-workbook branch is bounded by her own line scope instead. Written as the
// complement on purpose: a role granted sales:read later is gated until someone decides otherwise,
// rather than open until someone notices.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True for the readers whose Monthly Closing details cover every validated month, published or not.
 *
 * MIRRORS the full-workbook disjunction in app/api/sales/monthly-closing/export/route.ts term for
 * term (`marketingOversight !== null` there is MARKETING_OVERSIGHT_LINE_ROLES here, because
 * resolvePortalClosingScope never returns null). tests/closing-details-publication-gate.test.ts
 * fails when the two drift, so the Details tab and the Export button always agree on who may open
 * an unpublished month.
 */
export function readsUnpublishedClosings(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "Super Admin"
    || access.scope === "system"
    || access.role === "SFE Manager"
    || access.role === "CEO"
    || access.role === "Finance Manager"
    || MARKETING_OVERSIGHT_LINE_ROLES.has(access.role);
}

/** The refusal a gated viewer reads. Names, never codes: "August 2026", not "2026-08". */
export function unpublishedClosingMessage(line: string, period: string): string {
  const month = periodLabel(period);
  const subject = month && month !== period.trim()
    ? `The ${line} Monthly Closing for ${month}`
    : `That month's ${line} Monthly Closing`;
  return `${subject} has not been published yet, so its details cannot be opened or exported.`;
}

export type ClosingDetailsPeriodDecision =
  | { allowed: true; period: string | null }
  | { allowed: false; error: string };

/**
 * Which month a GATED viewer's request opens, given the published months of the line its rows would
 * come from.
 *
 *   · a named month that is published     → that month
 *   · a named month that is NOT published → refused, in plain words. Never swapped for a month that
 *     is: an answer holding different data than the request named is how a reader ends up quoting
 *     the wrong month — the rule pickPortalClosingLine already keeps for lines.
 *   · no month named                      → the newest published month, or none at all
 *   · no line to open                     → none. The details service then answers "outside your
 *     access" or empty, which is the truer message than "not published".
 */
export function decideClosingDetailsPeriod(input: {
  line: string | null | undefined;
  requestedPeriod: string | null | undefined;
  publishedPeriods: readonly string[];
}): ClosingDetailsPeriodDecision {
  const line = String(input.line ?? "").trim();
  if (!line) return { allowed: true, period: null };
  const requested = String(input.requestedPeriod ?? "").trim();
  if (!requested) return { allowed: true, period: input.publishedPeriods[0] ?? null };
  if (input.publishedPeriods.includes(requested)) return { allowed: true, period: requested };
  return { allowed: false, error: unpublishedClosingMessage(line, requested) };
}

export type ClosingDetailsPeriodGate =
  /** A reader of every validated month: the route's own period resolution stands. */
  | { kind: "open" }
  /** Published months only: open `period`, and offer `publishedPeriods` as the month choices. */
  | { kind: "published"; line: string | null; period: string | null; publishedPeriods: string[] }
  /** The named month is not published for this viewer's line. */
  | { kind: "refused"; error: string };

/**
 * The gate itself. Runs BEFORE a single closing row is read.
 *
 * It checks the line the rows would ACTUALLY come from, not the line the request named.
 * loadMonthlyClosingDetails swaps a line outside the viewer's scope for the first line inside it,
 * so gating the named line would let a request name a line whose month IS published and receive
 * another line's month that is not. The line is resolved by that same service, asked for no period:
 * it resolves the viewer's scope and lines and returns before reading any row, so the gate and the
 * rows cannot disagree about which line is meant. Pass it exactly the `line`, `availableLines` and
 * `includeConfidential` the real read will get.
 */
export async function gateClosingDetailsPeriod(input: {
  access: AccessContext;
  line: string | null | undefined;
  requestedPeriod: string | null | undefined;
  availableLines: string[];
  includeConfidential?: boolean;
}): Promise<ClosingDetailsPeriodGate> {
  if (readsUnpublishedClosings(input.access)) return { kind: "open" };

  const { line } = await loadMonthlyClosingDetails({
    access: input.access,
    line: input.line ?? null,
    period: null,
    availableLines: input.availableLines,
    availablePeriods: [],
    includeConfidential: input.includeConfidential === true,
  });
  const publishedPeriods = line ? await listPublishedPeriodsForLine(line) : [];
  const decision = decideClosingDetailsPeriod({ line, requestedPeriod: input.requestedPeriod, publishedPeriods });
  if (!decision.allowed) return { kind: "refused", error: decision.error };
  return { kind: "published", line, period: decision.period, publishedPeriods };
}
