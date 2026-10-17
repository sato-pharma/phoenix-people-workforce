/**
 * Phoenix CRM — the week of a rep who still works in the OLD CRM, for the district manager's board
 * (owner, 2026-10-17). The rules are old-crm-plan-rules.ts; the vendor read is the CRM door
 * (`getAgentsWeekPlanEntries`); this joins the two to the rep's Phoenix customers.
 *
 * A planned contact is matched to a Phoenix customer of the REP'S OWN seat through the id the carry-over
 * kept on it — `own_contact_crm_id` or `reference_contact_crm_id` (1,473 of 1,614 planned calls matched
 * for a sample of old-CRM reps, 91%, measured 2026-10-17). Matched, he can be ticked; unmatched, he shows
 * and cannot be (his `customerId` is null).
 *
 * It reads for the real world only: the test world holds no vendor data, and a test login's reps are
 * Phoenix reps by construction.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { getAgentsWeekPlanEntries, type AgentWeekPlanEntry } from "@/lib/crm/plan-board";
import { logWarning } from "@/lib/observability/log";
import { repHalfKey } from "@/lib/phoenix-crm/manager-plan-rules";
import { oldCrmHalfOf, oldCrmPlanOf, OLD_CRM_CATCH_ALL_CONTACT } from "@/lib/phoenix-crm/old-crm-plan-rules";
import { chunk, textOrNull } from "@/lib/phoenix-crm/server/db";
import type { RepDayCustomer } from "@/lib/phoenix-crm/server/manager-plans";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type OldCrmRep = { seatId: string; hrId: string };

export type OldCrmRepWeek = {
  seatId: string;
  /** The vendor's plan id and approval status — what the district manager approves. */
  crmPlanId: number;
  status: number | null;
  /** "<seat>|<date>|<half>" → the customers of that half, as the board prints a Phoenix rep's own. */
  halves: Map<string, RepDayCustomer[]>;
};

const CONTACT_CHUNK = 100;

type OldPlan = { crmPlanId: number; status: number | null; entries: AgentWeekPlanEntry[] };

/** The Phoenix customer of `seatId` a contact id points at: active before pending, so a re-validated one wins. */
async function customersOfContacts(seatIds: ReadonlyArray<string>, contactIds: ReadonlyArray<number>): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  if (seatIds.length === 0 || contactIds.length === 0) return found;
  for (const part of chunk([...new Set(contactIds)], CONTACT_CHUNK)) {
    const list = part.join(",");
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_customers")
          .select("id, seat_id, name, grade, speciality, list_type, status, own_contact_crm_id, reference_contact_crm_id")
          .eq("is_test", false)
          .in("seat_id", [...seatIds])
          .in("status", ["active", "pending"])
          .or(`own_contact_crm_id.in.(${list}),reference_contact_crm_id.in.(${list})`),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      for (const contact of [row.own_contact_crm_id, row.reference_contact_crm_id]) {
        if (contact == null) continue;
        const key = `${String(row.seat_id)}|${Number(contact)}`;
        const held = found.get(key);
        if (!held || (held.status !== "active" && row.status === "active")) found.set(key, row);
      }
    }
  }
  return found;
}

/**
 * The old-CRM week of each of these reps, for the field week starting `weekStart`. A rep with no plan in
 * iReports360 that week is absent from the answer. A failed read answers an empty map and is logged: the
 * board still opens with his Phoenix reps, and the rep reads "No plan" as he did before this existed.
 */
export async function loadOldCrmRepWeeks(input: { reps: ReadonlyArray<OldCrmRep>; weekStart: string; isTest: boolean }): Promise<Map<string, OldCrmRepWeek>> {
  const weeks = new Map<string, OldCrmRepWeek>();
  if (input.isTest || input.reps.length === 0) return weeks;
  try {
    const seatOfHr = new Map(input.reps.map((rep) => [rep.hrId.trim().toLowerCase(), rep.seatId]));
    const entries = await getAgentsWeekPlanEntries(
      input.reps.map((rep) => rep.hrId),
      input.weekStart,
      addDaysIso(input.weekStart, 5),
    );
    if (!entries || entries.length === 0) return weeks;

    const bySeat = new Map<string, AgentWeekPlanEntry[]>();
    for (const entry of entries) {
      const seatId = seatOfHr.get(entry.agentHrId.trim().toLowerCase());
      if (!seatId || entry.contactCrmId === OLD_CRM_CATCH_ALL_CONTACT) continue;
      const list = bySeat.get(seatId) ?? [];
      list.push(entry);
      bySeat.set(seatId, list);
    }
    const plans = new Map<string, OldPlan>();
    for (const [seatId, list] of bySeat) {
      const plan = oldCrmPlanOf(list);
      if (plan) plans.set(seatId, plan);
    }
    if (plans.size === 0) return weeks;

    const customers = await customersOfContacts(
      [...plans.keys()],
      [...plans.values()].flatMap((plan) => plan.entries.map((entry) => entry.contactCrmId)),
    );

    for (const [seatId, plan] of plans) {
      const halves = new Map<string, RepDayCustomer[]>();
      const placed = new Set<string>();
      for (const entry of plan.entries) {
        const customer = customers.get(`${seatId}|${entry.contactCrmId}`) ?? null;
        const half = oldCrmHalfOf({
          matched: customer !== null,
          listType: customer ? textOrNull(customer.list_type) : null,
          speciality: customer ? textOrNull(customer.speciality) : entry.speciality,
        });
        if (!half) continue;
        const key = repHalfKey(seatId, entry.planDate, half);
        const once = `${key}|${customer ? String(customer.id) : `contact-${entry.contactCrmId}`}`;
        if (placed.has(once)) continue;
        placed.add(once);
        const list = halves.get(key) ?? [];
        list.push({
          customerId: customer ? String(customer.id) : null,
          name: (customer ? textOrNull(customer.name) : null) ?? entry.contactName?.trim() ?? "Customer",
          grade: (customer ? textOrNull(customer.grade) : null) ?? entry.contactGrade,
          speciality: (customer ? textOrNull(customer.speciality) : null) ?? entry.speciality,
          brickName: null,
          zone: null,
          listType: half,
        });
        halves.set(key, list);
      }
      weeks.set(seatId, { seatId, crmPlanId: plan.crmPlanId, status: plan.status, halves });
    }
  } catch (error) {
    logWarning("Phoenix CRM could not read the old CRM plans for the manager's board", {
      error,
      labels: { event: "phoenix_crm_old_crm_week_unreadable" },
    });
    return new Map();
  }
  return weeks;
}
