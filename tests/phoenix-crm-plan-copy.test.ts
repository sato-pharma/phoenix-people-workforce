import assert from "node:assert/strict";

import { buildCopyPlacements, type CopyEntry, type CopyWeek } from "../src/lib/phoenix-crm/plan-copy.ts";
import type { PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import type { PhoenixCrmDoctorListType } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — "Copy last month" (owner, 2026-09-25: offer to pre-fill the new month from the rep's
 * own iReports360 plan, editable and never auto-submitted).
 *
 * buildCopyPlacements turns last month's reference into placements on the new month's matching
 * weekdays, which the caller saves a week at a time through the ordinary weekly save. The rules this
 * pins:
 *   - only a doctor who still maps to a customer on the seat's list is placed (a name-only or a
 *     left-the-list entry is not);
 *   - he lands on every EDITABLE day whose weekday he was on last month, on the list types that day
 *     allows, at his first place (or none, for a customer not validated yet);
 *   - a day fills only up to what its cap still has room for, and never doubles a doctor already on it;
 *   - the order is deterministic (AM before PM, then by customer id) so the copy is reproducible;
 *   - over the grade norm is allowed (owner decision 3) — nothing here caps a doctor's month total.
 */

// 2026-10-03 Sat (6) · 04 Sun (0) · 05 Mon (1) · 06 Tue (2) · 07 Wed (3) · 08 Thu (4, AM only).
const SATURDAY = "2026-10-03";
const SUNDAY = "2026-10-04";
const THURSDAY = "2026-10-08";
const WEEK = "2026-10-03";
const BOTH: PhoenixCrmDoctorListType[] = ["AM", "PM"];
const CAPS = { amDailyCap: 5, pmDailyCap: 15 };

function customer(customerId: string, listType: PhoenixCrmDoctorListType, placeId: string | null): PlannerCustomer {
  return {
    customerId,
    name: customerId,
    listType,
    grade: null,
    speciality: null,
    visitsThisMonth: 0,
    pending: placeId === null,
    places: placeId === null ? [] : [{ placeId, label: null, address: null, lat: 0, lon: 0, brick: null, zone: null, timings: [] }],
  };
}

function day(
  date: string,
  listTypes: PhoenixCrmDoctorListType[],
  editable: boolean,
  items: Array<{ customerId: string; listType: PhoenixCrmDoctorListType }> = [],
): CopyWeek["days"][number] {
  return { date, listTypes, editable, items };
}

export function runPhoenixCrmPlanCopyTests() {
  // ── A doctor on the list is placed on his weekday, at his place ─────────────────────────────────
  {
    const entries: CopyEntry[] = [{ nativeCustomerId: "cust-pm", listType: "PM", weekdays: [6] }];
    const customers = [customer("cust-pm", "PM", "place-pm")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true), day(SUNDAY, BOTH, true)] };
    const result = buildCopyPlacements(entries, customers, [week], CAPS);
    assert.equal(result.size, 1, "the one week that gains a placement appears, and no other");
    assert.deepEqual(
      result.get(WEEK),
      [{ planDate: SATURDAY, customerId: "cust-pm", placeId: "place-pm", exceptionType: null, exceptionNote: null }],
      "the doctor lands only on Saturday (his weekday), at his first place, as a plain placement",
    );
  }

  // ── A name-only entry and one that has left the list are not placed ─────────────────────────────
  {
    const entries: CopyEntry[] = [
      { nativeCustomerId: null, listType: "PM", weekdays: [6] },
      { nativeCustomerId: "gone", listType: "PM", weekdays: [6] },
    ];
    const customers = [customer("still-here", "PM", "place-x")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true)] };
    assert.equal(buildCopyPlacements(entries, customers, [week], CAPS).size, 0, "nothing to copy when no reference doctor still maps");
  }

  // ── A doctor already on the day is not doubled ──────────────────────────────────────────────────
  {
    const entries: CopyEntry[] = [{ nativeCustomerId: "cust-pm", listType: "PM", weekdays: [6] }];
    const customers = [customer("cust-pm", "PM", "place-pm")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true, [{ customerId: "cust-pm", listType: "PM" }])] };
    assert.equal(buildCopyPlacements(entries, customers, [week], CAPS).size, 0, "a doctor already on Saturday is not placed again");
  }

  // ── A day the rep can no longer change is skipped ───────────────────────────────────────────────
  {
    const entries: CopyEntry[] = [{ nativeCustomerId: "cust-pm", listType: "PM", weekdays: [6] }];
    const customers = [customer("cust-pm", "PM", "place-pm")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, false)] };
    assert.equal(buildCopyPlacements(entries, customers, [week], CAPS).size, 0, "a passed / locked day never receives a copy");
  }

  // ── The day's cap is honoured — a full list gets nothing more ───────────────────────────────────
  {
    const full = Array.from({ length: 5 }, (_, index) => ({ customerId: `am-${index}`, listType: "AM" as PhoenixCrmDoctorListType }));
    const entries: CopyEntry[] = [{ nativeCustomerId: "cust-am", listType: "AM", weekdays: [6] }];
    const customers = [customer("cust-am", "AM", "place-am")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true, full)] };
    assert.equal(buildCopyPlacements(entries, customers, [week], CAPS).size, 0, "a Saturday already at the 5-AM cap has no room for the copy");
  }

  // ── The day's list types gate a placement — a PM doctor is not placed on a morning ──────────────
  {
    const entries: CopyEntry[] = [
      { nativeCustomerId: "cust-pm", listType: "PM", weekdays: [4] },
      { nativeCustomerId: "cust-am", listType: "AM", weekdays: [4] },
    ];
    const customers = [customer("cust-pm", "PM", "place-pm"), customer("cust-am", "AM", "place-am")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(THURSDAY, ["AM"], true)] };
    const result = buildCopyPlacements(entries, customers, [week], CAPS);
    assert.deepEqual(
      result.get(WEEK)?.map((draft) => draft.customerId),
      ["cust-am"],
      "Thursday is a morning (AM only), so the AM account is copied and the PM doctor is not",
    );
  }

  // ── The order is deterministic: AM before PM, then by customer id ───────────────────────────────
  {
    const entries: CopyEntry[] = [
      { nativeCustomerId: "pm-1", listType: "PM", weekdays: [6] },
      { nativeCustomerId: "am-2", listType: "AM", weekdays: [6] },
      { nativeCustomerId: "am-1", listType: "AM", weekdays: [6] },
    ];
    const customers = [customer("pm-1", "PM", "p"), customer("am-2", "AM", "p"), customer("am-1", "AM", "p")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true)] };
    const result = buildCopyPlacements(entries, customers, [week], CAPS);
    assert.deepEqual(
      result.get(WEEK)?.map((draft) => draft.customerId),
      ["am-1", "am-2", "pm-1"],
      "AM sorts before PM, and same-list doctors sort by id — a reproducible copy a test can assert",
    );
  }

  // ── A customer not validated yet copies with no place ───────────────────────────────────────────
  {
    const entries: CopyEntry[] = [{ nativeCustomerId: "cust-pending", listType: "PM", weekdays: [6] }];
    const customers = [customer("cust-pending", "PM", null)];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true)] };
    assert.deepEqual(
      buildCopyPlacements(entries, customers, [week], CAPS).get(WEEK),
      [{ planDate: SATURDAY, customerId: "cust-pending", placeId: null, exceptionType: null, exceptionNote: null }],
      "a carried-over customer with no place yet is copied with placeId null, planned like anyone else",
    );
  }

  // ── One reference merges weekday sets across duplicate entries ──────────────────────────────────
  {
    const entries: CopyEntry[] = [
      { nativeCustomerId: "cust-pm", listType: "PM", weekdays: [6] },
      { nativeCustomerId: "cust-pm", listType: "PM", weekdays: [0] },
    ];
    const customers = [customer("cust-pm", "PM", "place-pm")];
    const week: CopyWeek = { weekStart: WEEK, days: [day(SATURDAY, BOTH, true), day(SUNDAY, BOTH, true)] };
    assert.deepEqual(
      buildCopyPlacements(entries, customers, [week], CAPS).get(WEEK)?.map((draft) => draft.planDate),
      [SATURDAY, SUNDAY],
      "a doctor listed twice last month merges to both weekdays and is placed on each",
    );
  }
}
