"use client";

/**
 * Phoenix CRM — choosing the customer for a visit, and the reason for one off the plan.
 *
 * Owner, 2026-09-29:
 *   - PLANNED offers ONLY the customers on today's SENT plan. This is the door, not the gate: the
 *     server decides from the plan's own history whether the visit really was planned, and a mismatch
 *     comes back asking for a reason rather than being filed as planned.
 *   - OUT OF PLAN is his list minus today's plan — pending customers included, customers waiting
 *     outside the list excluded (a visit to one of them is an out-of-list visit). It needs a written
 *     reason, and counts once his manager and then SFE approve it.
 *   - PHARMACY (owner, 2026-10-03) is the pharmacies on his list — every one he has not dropped,
 *     validated or not — and only them. A pharmacy is never planned, never approved and never validated
 *     (pharmacy-call-rules.ts), so it is no longer offered under Out of plan, where it was asked for a
 *     reason and an approval it never needed. One that is not on his list yet he adds right here, by
 *     its name and with no approval ("Add a pharmacy", rule 3d), and the visit form opens on it.
 *
 * Grouped by brick with the module's one palette (brick-tints.ts), not-yet-visited first and the
 * customers who receive today ahead of the ones who do not, so his day reads geographically — and in
 * the order he can actually walk it — before he taps anything (Golden Rule #1, the EASY half).
 */

import { useState } from "react";
import { MapPin, Plus, Search } from "lucide-react";

import { brickTintMap } from "@/components/phoenix-crm/brick-tints";
import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { countText } from "@/components/phoenix-crm/format";
import { customerMetaText, monthVisitsText, PENDING_PILL, pendingVisitsText, VALIDATE_FIRST_PILL } from "@/components/phoenix-crm/labels";
import { OffPlanAllowanceCard } from "@/components/phoenix-crm/offplan-allowance";
import { pharmacyWhereLine } from "@/components/phoenix-crm/pharmacy-details";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmPill,
  crmInputClassName,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import { useInsideCrmStepForm } from "@/components/phoenix-crm/step-form";
import { directionsPlace, directionsUrl } from "@/lib/phoenix-crm/directions";
import { UNVALIDATED_CUSTOMER_VISIT_REFUSED } from "@/lib/phoenix-crm/entry-rules";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { offPlanBlock, type OffPlanAllowance } from "@/lib/phoenix-crm/offplan-cap-rules";
import { movedDayReason } from "@/lib/phoenix-crm/offplan-day";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { UNPLANNED_REASON_MAX } from "@/lib/phoenix-crm/unplanned-rules";
import type { VisitCustomerOption } from "@/lib/phoenix-crm/view-types";
import { VISIT_WAITING_PILL } from "@/lib/phoenix-crm/visit-resend-rules";
import { cn } from "@/lib/utils";

/** Which customers a picker offers. */
export type PickerMode = "planned" | "out_of_plan" | "pharmacy";

/** The sentence describeDayWindows gives a place that does not receive on the day. */
const NOT_RECEIVING = "Does not receive this day";

/** Customers shown at a time. */
const PICKER_PAGE = 25;

/** The brick a customer is grouped under. A customer with no place yet has none. */
const NO_BRICK = "__no_brick__";
const NO_BRICK_LABEL = "Not mapped yet";

/**
 * Whether a customer can be seen today, from his places' own receiving hours: 0 receives today at one
 * of his places, 1 has no place to read hours from yet, 2 has places and none of them receives today.
 * A customer with nothing to read sits in the MIDDLE rather than last — no hours is not "closed".
 */
export function receivingRank(customer: Pick<VisitCustomerOption, "places">): 0 | 1 | 2 {
  if (customer.places.length === 0) return 1;
  return customer.places.some((place) => place.todayWindows !== NOT_RECEIVING) ? 0 : 2;
}

/**
 * The customers a mode offers: not-yet-visited first, and inside each half the customers who receive
 * today ahead of the ones who do not (GOLDEN RULE #1, the EASY half — the door he can walk through now
 * is the one at the top). The server already sorts today's plan first and then by name, and the sort
 * here is stable, so that order holds inside each band. A list with no hours to read has every
 * customer in the same band, so its order is left exactly as the server sent it.
 */
export function customersFor(mode: PickerMode, customers: ReadonlyArray<VisitCustomerOption>): VisitCustomerOption[] {
  const offered = customers.filter((customer) => {
    if (customer.outside) return false;
    if (isPharmacyListType(customer.listType)) return mode === "pharmacy";
    if (mode === "pharmacy") return false;
    return mode === "planned" ? customer.plannedToday : !customer.plannedToday;
  });
  return [...offered].sort(
    (left, right) => Number(left.visitedToday) - Number(right.visitedToday) || receivingRank(left) - receivingRank(right),
  );
}

/**
 * Where his "Directions" link goes (owner, 2026-10-02): the saved place he receives at today, else his
 * first saved place — null when no place of his has a usable point, and then there is no link.
 *
 * 🔴 A PHARMACY HAS NO SAVED PLACE AT ALL, so since 2026-10-09 its own pin answers instead (owner,
 * the same day he asked for the pin): a pharmacy is validated with no place row — no photo, no
 * timings — so until it could be pinned there was nothing to drive to and this link never drew for
 * one. A doctor is untouched: his places are tried first, and a doctor never carries a pharmacy pin.
 */
export function customerDirectionsUrl(customer: Pick<VisitCustomerOption, "pharmacyPin" | "places">): string | null {
  const place = directionsPlace(customer.places, (place) => place.todayWindows !== NOT_RECEIVING);
  return directionsUrl(place) ?? directionsUrl(customer.pharmacyPin);
}

/** Today's receiving hours at each of his places. */
export function PlaceWindows({ customer }: { customer: VisitCustomerOption }) {
  if (customer.places.length === 0) return null;
  return (
    <span className="mt-1 grid gap-0.5">
      {customer.places.map((place, index) => {
        const where = customer.places.length > 1 ? `${place.label ?? place.address ?? `Place ${index + 1}`}: ` : "";
        const receiving = place.todayWindows !== NOT_RECEIVING;
        return (
          <span className={cn("block break-words text-xs font-semibold", receiving ? "text-emerald-700" : "text-slate-500")} key={place.placeId}>
            {where}
            {receiving ? `Receives today ${place.todayWindows}` : place.todayWindows}
          </span>
        );
      })}
    </span>
  );
}

type PickerGroup = { key: string; name: string; customers: VisitCustomerOption[] };

export function VisitCustomerPicker({
  allCustomers,
  mode,
  onAddPharmacy,
  onBack,
  offPlan,
  onChooseUnplanned,
  onPharmacyDetails,
  onPick,
  voice = "rep",
}: {
  /** The form's whole customer list: brick hues are keyed off it, so a brick keeps its colour. */
  allCustomers: ReadonlyArray<VisitCustomerOption>;
  mode: PickerMode;
  /** Out of plan: what the allowance still holds (owner, 2026-10-10). A doctor it can no longer take is shown, not offered. */
  offPlan?: OffPlanAllowance;
  /** Who is reading the allowance: the rep, or a manager entering for him. */
  voice?: "rep" | "manager";
  /** Pharmacy visit: a pharmacy not on his list yet, added by its name with no approval. */
  onAddPharmacy?: () => void;
  onBack: () => void;
  /**
   * Pharmacy visit: its own location and its responsible person's phone, both optional (owner,
   * 2026-10-09). Absent for a manager entering a rep's visit, exactly as Add a pharmacy is.
   */
  onPharmacyDetails?: (customerId: string) => void;
  /** Planned with nobody on today's plan: straight to Unplanned. */
  onChooseUnplanned?: () => void;
  onPick: (customerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [listType, setListType] = useState<"all" | PhoenixCrmListType>("all");
  // A page at a time: a territory's whole list is hundreds of buttons, and out of plan is exactly that.
  const [limit, setLimit] = useState(PICKER_PAGE);
  const needle = query.trim().toLowerCase();
  const offered = customersFor(mode, allCustomers);
  const shown = offered.filter(
    (customer) =>
      (listType === "all" || customer.listType === listType) &&
      (!needle || customer.name.toLowerCase().includes(needle) || (customer.speciality ?? "").toLowerCase().includes(needle)),
  );
  const left = shown.length - limit;
  // Keyed off the WHOLE list, never this filtered one: a brick that changes colour as he searches is a
  // brick he cannot learn.
  const tints = brickTintMap(allCustomers.map((customer) => customer.brickId).filter((brickId): brickId is string => Boolean(brickId)));
  const groups: PickerGroup[] = [];
  const groupByKey = new Map<string, PickerGroup>();
  for (const customer of shown.slice(0, limit)) {
    const key = customer.brickId ?? NO_BRICK;
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, name: customer.brickName ?? NO_BRICK_LABEL, customers: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.customers.push(customer);
  }

  const title = mode === "planned" ? "Planned visit" : mode === "pharmacy" ? "Pharmacy visit" : "Out of plan";
  // Said only when there are hours to order by: a list with none keeps the server's order, and saying
  // "receiving today first" over it would describe an order that is not there.
  const byHours = offered.some((customer) => customer.places.length > 0);

  return (
    <CrmPanel>
      <CrmBackBar backLabel={mode === "out_of_plan" ? "Unplanned visit" : "Add visit"} onBack={onBack} title={title} />
      <CrmBlock>
        <div className="grid min-w-0 gap-3">
          <p className="break-words text-sm font-semibold text-slate-600">
            {mode === "planned"
              ? "Today’s plan, grouped by brick."
              : mode === "pharmacy"
                ? "The pharmacies on your list. No plan and no approval: it counts when you log it."
                : "Your list, without today’s plan, grouped by brick."}
            {byHours ? " Customers who receive today come first." : ""} Tap the customer you are with.
          </p>
          {mode === "out_of_plan" && offPlan ? <OffPlanAllowanceCard allowance={offPlan} voice={voice} /> : null}
          {mode === "pharmacy" && onAddPharmacy ? (
            <div>
              <CrmButton onClick={onAddPharmacy}>
                <Plus aria-hidden className="h-4 w-4" />
                Add a pharmacy
              </CrmButton>
            </div>
          ) : null}
          {offered.length > PICKER_PAGE ? (
            <div className="relative min-w-0">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
              <input
                aria-label="Search customers"
                className={cn(crmInputClassName, "appearance-none pl-9")}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PICKER_PAGE);
                }}
                placeholder="Search by name or speciality"
                type="search"
                value={query}
              />
            </div>
          ) : null}
          {mode === "pharmacy" ? null : (
            <CrmChoice
              columns={3}
              label="Which customers"
              onChange={(next) => {
                setListType(next);
                setLimit(PICKER_PAGE);
              }}
              options={[
                { value: "all", label: "All" },
                { value: "AM", label: "AM" },
                { value: "PM", label: "PM" },
              ]}
              value={listType}
            />
          )}
          {shown.length === 0 ? (
            <div className="grid gap-2 border border-dashed border-slate-200 px-3 py-4 text-center">
              <p className="text-sm font-semibold text-slate-500">
                {offered.length > 0
                  ? "No customer matches."
                  : mode === "planned"
                    ? "Nobody is on a plan you have sent for today."
                    : mode === "pharmacy"
                      ? onAddPharmacy
                        ? "No pharmacy is on your list yet. Add the one you are at."
                        : "No pharmacy is on your list yet. Name one on a customer’s visit and it is added."
                      : "Everyone on your list is on today’s plan."}
              </p>
              {offered.length === 0 && mode === "planned" && onChooseUnplanned ? (
                <div>
                  <CrmButton onClick={onChooseUnplanned} variant="primary">
                    Unplanned visit
                  </CrmButton>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid min-w-0 gap-3">
              {groups.map((group) => {
                const tint = tints.get(group.key);
                return (
                  <div className="min-w-0" key={group.key}>
                    {/* The wash is on the heading, never on a row — the way the List tab and the Reps
                        List board draw a brick, from the one shared palette. */}
                    <p
                      className={cn(
                        "mb-1.5 break-words border-l-4 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.16em]",
                        tint ? `${tint.bar} ${tint.fill} text-slate-600` : "border-l-amber-500 bg-amber-50 text-amber-800",
                      )}
                    >
                      {group.name} · {countText(group.customers.length)}
                    </p>
                    <ul className="grid gap-1.5">
                      {group.customers.map((customer) => {
                        const directions = customerDirectionsUrl(customer);
                        // A pharmacy's own place and phone (owner, 2026-10-09). Offered on EVERY
                        // pharmacy row, pinned or not — the un-pinned one is precisely the one worth
                        // offering it to — and on no doctor row, which has a validated place already.
                        const pharmacy = isPharmacyListType(customer.listType);
                        const where = pharmacy ? pharmacyWhereLine(customer.pharmacyPin) : null;
                        const pharmacyDetails = pharmacy && onPharmacyDetails ? () => onPharmacyDetails(customer.customerId) : null;
                        // The allowance holds no place for this doctor: he is listed, with the way out, not offered. A visit
                        // already held on this phone is the same: listed, and never offered a second time.
                        const blocked = customer.waitingToSend ? "waiting" : mode === "out_of_plan" && offPlan ? offPlanBlock(offPlan, customer.customerId) : null;
                        return (
                          <li className="min-w-0" key={customer.customerId}>
                            <button
                              className="block w-full min-w-0 rounded-none border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-orange-300 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={customer.visitedToday || blocked !== null || customer.validateFirst}
                              onClick={() => onPick(customer.customerId)}
                              type="button"
                            >
                              <span className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                                {/* 🔴 A FLOOR, NOT `min-w-0`. The pills are `flex: 0 1 auto` with `min-width: auto`, so they
                                    never yield; with `min-w-0` here the name's min-content is ONE broken character, the flex
                                    line can never overflow, and the parent's `flex-wrap` is inert — the name was squeezed to
                                    59px and broke "Mohamed" mid-word at 375px, while nothing scrolled and no check went red
                                    (measured on staging's own CSS, 2026-10-02). The floor makes the line overflow, so the
                                    pills drop to their own row and the name gets the full width. Above a phone nothing moves. */}
                                <span className="min-w-[9rem] flex-1">
                                  <span className="block break-words text-sm font-black text-slate-950">{customer.name}</span>
                                  <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</span>
                                </span>
                                <span className="flex max-w-full flex-wrap gap-1">
                                  {customer.pending ? <CrmPill tone="orange">{PENDING_PILL}</CrmPill> : null}
                                  {customer.visitedToday ? <CrmPill tone="good">Visited today</CrmPill> : null}
                                  {customer.waitingToSend ? <CrmPill tone="orange">{VISIT_WAITING_PILL}</CrmPill> : null}
                                  {blocked === "day" || blocked === "week" ? <CrmPill tone="warn">{blocked === "day" ? "Plan for another day" : "This week is full"}</CrmPill> : null}
                                  {customer.validateFirst ? <CrmPill tone="warn">{VALIDATE_FIRST_PILL}</CrmPill> : null}
                                </span>
                              </span>
                              <PlaceWindows customer={customer} />
                              {/* A customer not validated yet has no month standing to report: "2 of 3 visits this
                                  month" would read as progress on a figure his visits do not move. */}
                              {/* 🔴 A THIRD VISIT BEFORE VALIDATION IS SAID HERE, NOT AFTER IT IS WRITTEN (System Audit,
                                  31 Oct 2026): listed with the save's own sentence and not offered, like a doctor the
                                  allowance holds no place for. */}
                              <span className="mt-1 block text-xs font-semibold text-slate-600">
                                {customer.validateFirst
                                  ? UNVALIDATED_CUSTOMER_VISIT_REFUSED
                                  : customer.pending
                                    ? pendingVisitsText(customer.visitsThisMonth)
                                    : monthVisitsText(customer.visitsThisMonth, customer.target)}
                              </span>
                            </button>
                            {/* The way to his saved place (owner, 2026-10-02) hangs UNDER the card, joined by its
                                border, never inside it: the card is one button, and a link inside a button is
                                markup a phone resolves by firing the card. No saved place, no strip. */}
                            {/* 🔴 AND A PHARMACY'S OWN PLACE AND PHONE HANG IN THE SAME STRIP (owner,
                                2026-10-09), for the same reason: this is the screen he is on when he
                                walks into the shop, and the alternative was a step inside the visit
                                form, which adds a step for everyone. Where it is reads here; the pin
                                button and the phone box are on the screen the link opens. */}
                            {directions || where || pharmacyDetails ? (
                              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border border-t-0 border-slate-200 bg-white px-3 py-1.5">
                                {where ? <span className="min-w-[8rem] flex-1 break-words text-phx-xs font-semibold text-slate-500">{where}</span> : null}
                                <span className="flex min-w-0 flex-wrap items-center gap-2">
                                  {pharmacyDetails ? (
                                    <button
                                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 md:min-h-9"
                                      onClick={pharmacyDetails}
                                      type="button"
                                    >
                                      <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                                      {customer.pharmacyPin || customer.pharmacyPhone ? "Its place and phone" : "Save its place and phone"}
                                    </button>
                                  ) : null}
                                  <DirectionsLink customerName={customer.name} href={directions} />
                                </span>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
          {left > 0 ? (
            <div>
              <CrmButton onClick={() => setLimit((current) => current + PICKER_PAGE)}>
                Show {countText(Math.min(PICKER_PAGE, left))} more of the {countText(left)} left
              </CrmButton>
            </div>
          ) : null}
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}

/**
 * Why he went to a customer off today's plan — asked BEFORE the visit form, so the form is the same
 * form for every visit. A sentence his manager can act on; it is his own approval, and he sees it.
 * OPTIONAL (owner, 2026-10-29: "Make this question optional") — Continue with the box blank goes on,
 * and the visit is still raised for its approval exactly as before.
 *
 * A customer on his sent plan for another day of this week arrives with the reason already written —
 * "Planned for Tuesday 6 Oct; seen today instead." (owner, 2026-10-02) — and he changes it or goes on.
 * The day his manager sees is read from the plan by the server, not from this box.
 */
export function OutOfPlanReason({
  customer,
  deciders,
  initialReason,
  offPlan,
  onBack,
  onContinue,
  voice = "rep",
}: {
  customer: VisitCustomerOption;
  /** The allowance as it stands, as a compact reminder under the customer. */
  offPlan?: OffPlanAllowance;
  voice?: "rep" | "manager";
  /** "Mona Adel decides it first, then SFE." */
  deciders: string;
  initialReason: string;
  onBack: () => void;
  onContinue: (reason: string) => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const length = reason.trim().length;
  // Inside Add visit's step form the form's own foot carries Back: one Back, never two.
  const framed = useInsideCrmStepForm();
  // On his sent plan for another day of this week, the reason arrives already written (owner,
  // 2026-10-02). Said under the box while it stands as written, the way the products say they came from
  // his last visit: a prefill he cannot see the source of is worse than asking.
  const filled = movedDayReason(customer.plannedOtherDays);

  function next() {
    onContinue(reason.trim());
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Back" onBack={onBack} title="Out of plan" />
      <CrmBlock>
        <p className="break-words text-base font-black text-slate-950">{customer.name}</p>
        <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
        {offPlan ? <OffPlanAllowanceCard allowance={offPlan} className="mt-3" compact voice={voice} /> : null}
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        <CrmNote className="mb-3" title="It counts once it is approved" tone="info">
          {deciders} Until then it counts in nothing — not your call rate, not coverage, not frequency.
        </CrmNote>
        <CrmField
          hint={
            filled !== null && reason.trim() === filled
              ? "Filled in from your plan. Change it if you went for another reason."
              : length === 0
                ? "Optional — you can leave it blank."
                : `${countText(UNPLANNED_REASON_MAX - reason.length)} left.`
          }
          htmlFor="phoenix-crm-out-of-plan-reason"
          label="Why you went (optional)"
        >
          <textarea
            className={crmTextareaClassName}
            dir="auto"
            id="phoenix-crm-out-of-plan-reason"
            maxLength={UNPLANNED_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
            placeholder="A sentence your manager can act on — what took you there."
            rows={3}
            value={reason}
          />
        </CrmField>
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton onClick={next} variant="primary">
            Continue
          </CrmButton>
          {framed ? null : <CrmButton onClick={onBack}>Back</CrmButton>}
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
