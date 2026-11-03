import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import {
  resolveDirectOrderReportScope,
  resolveVisibleRequesterHrIds,
} from "@/lib/direct-orders/service";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { EMPLOYEE_AREA_SELECT, resolveEmployeeAreaName } from "@/lib/employees/employee-org-labels";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Per-rep counters (spec E1) — the deterrence half of the Direct Orders design.
//
// Everything else built for this module makes a phantom pharmacy hard to CREATE. This makes the
// pattern visible: who keeps parking orders on pharmacies the master database has never heard of,
// who lets them rot until the 14-day clock kills them, and — the sharpest signal — who is shown the
// customer they meant and files "it is new" anyway.
//
// WHY `matchedExisting` IS THE NUMBER THAT MATTERS
// A held order alone means very little; the search was genuinely poor and a rep can be defeated by
// it through no fault of their own. But a validation that a Super Admin resolves as
// `matched_existing` says something stronger: the rep stood in front of a pharmacy, swore it was
// not in the system, and it was there all along. One is a mistake. A pattern of them is a habit.
//
// Read-only and derived: this table computes, it never writes. Nobody's number can be edited.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderRepCounters = {
  hrId: string;
  name: string;
  role: string;
  areaName: string;
  /** Orders sitting HELD right now, and what they are worth. */
  held: number;
  heldValue: number;
  /** Orders the 14-day clock killed — the cost of not resolving a held order. */
  expired: number;
  expiredValue: number;
  /**
   * Orders refused because the PHARMACY behind them was rejected.
   *
   * The strongest signal in this table, and it was invisible until 2026-08-05: the query fetched
   * only `held` and `expired`, so the moment twelve pharmacies were rejected and their
   * fourteen orders refused, every counter went to zero and the page reported that there was
   * nothing to count. The cleanest possible outcome — the matter reviewed and closed — erased the
   * record of it.
   *
   * Counts ONLY orders whose pharmacy carries `verification_status = 'rejected'`. An ordinary
   * rejected order is an approver declining a deal on a confirmed pharmacy and says nothing about
   * the requester; conflating the two would attribute something to people that did not happen.
   */
  ordersRejected: number;
  ordersRejectedValue: number;
  /** Distinct rejected pharmacies behind their orders — four small ones reads differently from one large. */
  rejectedPharmacies: number;
  /** Validation evidence submitted: the rep did use the door. */
  validationsSubmitted: number;
  /** Claimed new, and the Super Admin found it already existed. THE deterrence signal. */
  matchedExisting: number;
  /** Validation refused outright. */
  validationsRejected: number;
  /** Phoenix showed close matches at submit time and the rep proceeded anyway. */
  suggestionsRefused: number;
  /** ISO timestamp of their most recent held order, or null. */
  lastHeldAt: string | null;
};

export type DirectOrderRepCountersResult = {
  rows: DirectOrderRepCounters[];
  /** True when the viewer sees the whole company; false when scoped to their own subtree. */
  companyWide: boolean;
  /**
   * Set when there is genuinely nothing to count, so the UI can say so IN WORDS. An empty table
   * that looks like a zero is the failure this module has hit repeatedly — today's own evidence was
   * "zero validation requests", which read as reps ignoring the process when in fact they had never
   * been shown a button.
   */
  emptyReason: string | null;
};

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per-rep counters, scoped exactly like the report: a Super Admin or CEO sees everyone, a manager
 * sees their own reporting subtree, and a rep sees only themselves.
 */
export async function getDirectOrderRepCounters(access: AccessContext): Promise<DirectOrderRepCountersResult> {
  // `read` is the right coarse gate — these are aggregates of orders the viewer can already see,
  // and the scope filter below is what actually decides whose numbers appear.
  await assertPermission(access, "direct_orders", "read");

  const scope = resolveDirectOrderReportScope(access);
  const companyWide = scope === "all";
  const visible = companyWide ? null : await resolveVisibleRequesterHrIds(access);

  const supabase = getSupabaseAdmin();

  const [
    { data: requestRows },
    { data: validationRows },
    { data: employeeRows },
    { data: rejectedPharmacyRows },
  ] = await Promise.all([
    supabase
      .from("direct_order_requests")
      .select("requester_hr_id, requester_role, status, sales_value, held_at, pharmacy_id")
      .in("status", ["held", "expired", "rejected"]),
    supabase
      .from("direct_order_pharmacy_validations")
      .select("requested_by_hr_id, status, suggestions_refused"),
    // The area from the `area_id` LINK — see employee-org-labels.ts: 29 reps have a link and no
    // label, so this counter showed them with a blank area.
    supabase.from("employees").select(`hr_id, full_name, nickname, job_title, ${EMPLOYEE_AREA_SELECT}`),
    // Fetched as a set rather than joined, so a rejected order can be tested against it without a
    // second round trip per row — every one of those is a cross-region hop (Railway
    // `europe-west4` to Supabase `eu-central-1`), and this table already makes three.
    supabase.from("direct_order_pharmacies").select("id").eq("verification_status", "rejected"),
  ]);

  const employees = new Map<string, Row>();
  for (const row of (employeeRows ?? []) as Row[]) {
    // canonicalHrIdKey returns null for a blank id; an employee without one cannot be matched to a
    // request anyway, so skip rather than keying every such row under the same empty string.
    const key = canonicalHrIdKey(String(row.hr_id ?? ""));
    if (key) employees.set(key, row);
  }

  const inScope = (hrId: string): boolean => {
    const key = canonicalHrIdKey(hrId);
    if (!key) return false;
    return visible === null ? true : visible.has(key);
  };

  const byRep = new Map<string, DirectOrderRepCounters>();
  const ensure = (hrId: string, role: string): DirectOrderRepCounters => {
    // inScope() has already rejected anything unkeyable, so this cannot be null here — but fall
    // back to the raw id rather than assert, so a future caller cannot crash the whole table.
    const key = canonicalHrIdKey(hrId) ?? hrId;
    const existing = byRep.get(key);
    if (existing) return existing;
    const employee = employees.get(key);
    const fresh: DirectOrderRepCounters = {
      hrId: String(employee?.hr_id ?? hrId),
      // Owner's standing rule: human-readable names, never raw codes. Falling back to the HR id is
      // still better than a blank, but it is flagged as unknown rather than dressed up as a name.
      name: employee?.full_name
        ? resolveEmployeeDisplayName(String(employee.full_name), employee.nickname as string | null, String(employee.hr_id ?? hrId))
        : `(unknown — ${hrId})`,
      role: String(employee?.job_title ?? role ?? ""),
      areaName: resolveEmployeeAreaName(employee) ?? "",
      held: 0,
      heldValue: 0,
      expired: 0,
      expiredValue: 0,
      ordersRejected: 0,
      ordersRejectedValue: 0,
      rejectedPharmacies: 0,
      validationsSubmitted: 0,
      matchedExisting: 0,
      validationsRejected: 0,
      suggestionsRefused: 0,
      lastHeldAt: null,
    };
    byRep.set(key, fresh);
    return fresh;
  };

  const rejectedPharmacyIds = new Set(
    ((rejectedPharmacyRows ?? []) as Row[]).map((row) => String(row.id ?? "")).filter(Boolean),
  );
  /** Distinct rejected pharmacies per rep — a set, so two orders on one do not read as two. */
  const rejectedPharmaciesByRep = new Map<string, Set<string>>();

  for (const row of (requestRows ?? []) as Row[]) {
    const hrId = String(row.requester_hr_id ?? "");
    if (!inScope(hrId)) continue;
    const status = String(row.status);
    const pharmacyId = String(row.pharmacy_id ?? "");

    // Decided BEFORE ensure(), on purpose. An ordinary rejected order — an approver declining a
    // deal on a perfectly real pharmacy — must not create a row here at all, or every requester who
    // has ever had an order turned down would appear in a table about phantom pharmacies.
    if (status === "rejected" && !rejectedPharmacyIds.has(pharmacyId)) continue;

    const rep = ensure(hrId, String(row.requester_role ?? ""));
    const value = num(row.sales_value);
    if (status === "held") {
      rep.held += 1;
      rep.heldValue += value;
      const heldAt = row.held_at ? String(row.held_at) : null;
      if (heldAt && (!rep.lastHeldAt || heldAt > rep.lastHeldAt)) rep.lastHeldAt = heldAt;
    } else if (status === "expired") {
      rep.expired += 1;
      rep.expiredValue += value;
    } else {
      rep.ordersRejected += 1;
      rep.ordersRejectedValue += value;
      const key = canonicalHrIdKey(hrId) ?? hrId;
      const seen = rejectedPharmaciesByRep.get(key) ?? new Set<string>();
      seen.add(pharmacyId);
      rejectedPharmaciesByRep.set(key, seen);
    }
  }

  for (const [key, pharmacies] of rejectedPharmaciesByRep) {
    const rep = byRep.get(key);
    if (rep) rep.rejectedPharmacies = pharmacies.size;
  }

  for (const row of (validationRows ?? []) as Row[]) {
    const hrId = String(row.requested_by_hr_id ?? "");
    if (!inScope(hrId)) continue;
    const rep = ensure(hrId, "");
    rep.validationsSubmitted += 1;
    if (String(row.status) === "matched_existing") rep.matchedExisting += 1;
    if (String(row.status) === "rejected") rep.validationsRejected += 1;
    if (row.suggestions_refused === true) rep.suggestionsRefused += 1;
  }

  // Worst first, by money claimed on a pharmacy that was not right — parked now (`held`) plus proven
  // rejected (`ordersRejected`). Sorting on heldValue alone put every rep at zero the moment those
  // pharmacies were rejected, which sorted the table alphabetically at exactly the point it was
  // most worth reading.
  const atRisk = (r: DirectOrderRepCounters) => r.heldValue + r.ordersRejectedValue;
  const rows = Array.from(byRep.values()).sort(
    (a, b) =>
      atRisk(b) - atRisk(a) ||
      b.ordersRejected - a.ordersRejected ||
      b.matchedExisting - a.matchedExisting ||
      b.held - a.held ||
      a.name.localeCompare(b.name),
  );

  let emptyReason: string | null = null;
  if (rows.length === 0) {
    // Now genuinely means "nothing has ever gone wrong", not "the problem was cleaned up".
    emptyReason = companyWide
      ? "No direct order has been held, expired, or rejected on an unconfirmed pharmacy — nothing to count."
      : "Nobody in your team has a held or expired direct order, or one rejected on an unconfirmed pharmacy.";
  }

  return { rows, companyWide, emptyReason };
}
