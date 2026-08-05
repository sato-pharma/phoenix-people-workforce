import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import {
  resolveDirectOrderReportScope,
  resolveVisibleRequesterHrIds,
} from "@/lib/direct-orders/service";
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

  const [{ data: requestRows }, { data: validationRows }, { data: employeeRows }] = await Promise.all([
    supabase
      .from("direct_order_requests")
      .select("requester_hr_id, requester_role, status, sales_value, held_at")
      .in("status", ["held", "expired"]),
    supabase
      .from("direct_order_pharmacy_validations")
      .select("requested_by_hr_id, status, suggestions_refused"),
    supabase.from("employees").select("hr_id, full_name, job_title, area_name"),
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
      name: String(employee?.full_name ?? `(unknown — ${hrId})`),
      role: String(employee?.job_title ?? role ?? ""),
      areaName: String(employee?.area_name ?? ""),
      held: 0,
      heldValue: 0,
      expired: 0,
      expiredValue: 0,
      validationsSubmitted: 0,
      matchedExisting: 0,
      validationsRejected: 0,
      suggestionsRefused: 0,
      lastHeldAt: null,
    };
    byRep.set(key, fresh);
    return fresh;
  };

  for (const row of (requestRows ?? []) as Row[]) {
    const hrId = String(row.requester_hr_id ?? "");
    if (!inScope(hrId)) continue;
    const rep = ensure(hrId, String(row.requester_role ?? ""));
    const value = num(row.sales_value);
    if (String(row.status) === "held") {
      rep.held += 1;
      rep.heldValue += value;
      const heldAt = row.held_at ? String(row.held_at) : null;
      if (heldAt && (!rep.lastHeldAt || heldAt > rep.lastHeldAt)) rep.lastHeldAt = heldAt;
    } else {
      rep.expired += 1;
      rep.expiredValue += value;
    }
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

  // Worst first: the people with the most money parked, then the most matched-existing. A counter
  // table sorted alphabetically buries the thing it exists to surface.
  const rows = Array.from(byRep.values()).sort(
    (a, b) =>
      b.heldValue - a.heldValue ||
      b.matchedExisting - a.matchedExisting ||
      b.held - a.held ||
      a.name.localeCompare(b.name),
  );

  let emptyReason: string | null = null;
  if (rows.length === 0) {
    emptyReason = companyWide
      ? "No direct order has been held or expired yet — nothing to count."
      : "Nobody in your team has a held or expired direct order.";
  }

  return { rows, companyWide, emptyReason };
}
