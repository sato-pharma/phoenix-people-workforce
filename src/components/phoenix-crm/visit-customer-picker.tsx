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
 *
 * Grouped by brick with the module's one palette (brick-tints.ts), not-yet-visited first and the
 * customers who receive today ahead of the ones who do not, so his day reads geographically — and in
 * the order he can actually walk it — before he taps anything (Golden Rule #1, the EASY half).
 */

import { useState } from "react";
import { Search } from "lucide-react";

import { brickTintMap } from "@/components/phoenix-crm/brick-tints";
import { DirectionsLink } from "@/components/phoenix-crm/directions-link";
import { countText } from "@/components/phoenix-crm/format";
import { customerMetaText, monthVisitsText, PENDING_PILL, pendingVisitsText } from "@/components/phoenix-crm/labels";
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
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { UNPLANNED_REASON_MAX, UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";
import type { VisitCustomerOption } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** Which customers a picker offers. */
export type PickerMode = "planned" | "out_of_plan";

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
  const offered = customers.filter((customer) => !customer.outside && (mode === "planned" ? customer.plannedToday : !customer.plannedToday));
  return [...offered].sort(
    (left, right) => Number(left.visitedToday) - Number(right.visitedToday) || receivingRank(left) - receivingRank(right),
  );
}

/**
 * Where his "Directions" link goes (owner, 2026-10-02): the saved place he receives at today, else his
 * first saved place — null when no place of his has a usable point, and then there is no link.
 */
export function customerDirectionsUrl(customer: Pick<VisitCustomerOption, "places">): string | null {
  return directionsUrl(directionsPlace(customer.places, (place) => place.todayWindows !== NOT_RECEIVING));
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
  onBack,
  onChooseUnplanned,
  onPick,
}: {
  /** The form's whole customer list: brick hues are keyed off it, so a brick keeps its colour. */
  allCustomers: ReadonlyArray<VisitCustomerOption>;
  mode: PickerMode;
  onBack: () => void;
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

  const title = mode === "planned" ? "Planned visit" : "Out of plan";
  // Said only when there are hours to order by: a list with none keeps the server's order, and saying
  // "receiving today first" over it would describe an order that is not there.
  const byHours = offered.some((customer) => customer.places.length > 0);

  return (
    <CrmPanel>
      <CrmBackBar backLabel={mode === "planned" ? "Add visit" : "Unplanned visit"} onBack={onBack} title={title} />
      <CrmBlock>
        <div className="grid min-w-0 gap-3">
          <p className="break-words text-sm font-semibold text-slate-600">
            {mode === "planned" ? "Today’s plan, grouped by brick." : "Your list, without today’s plan, grouped by brick."}
            {byHours ? " Customers who receive today come first." : ""} Tap the customer you are with.
          </p>
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
          {shown.length === 0 ? (
            <div className="grid gap-2 border border-dashed border-slate-200 px-3 py-4 text-center">
              <p className="text-sm font-semibold text-slate-500">
                {offered.length > 0
                  ? "No customer matches."
                  : mode === "planned"
                    ? "Nobody is on a plan you have sent for today."
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
                        return (
                          <li className="min-w-0" key={customer.customerId}>
                            <button
                              className="block w-full min-w-0 rounded-none border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-orange-300 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={customer.visitedToday}
                              onClick={() => onPick(customer.customerId)}
                              type="button"
                            >
                              <span className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                                <span className="min-w-0 flex-1">
                                  <span className="block break-words text-sm font-black text-slate-950">{customer.name}</span>
                                  <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</span>
                                </span>
                                <span className="flex max-w-full flex-wrap gap-1">
                                  {customer.pending ? <CrmPill tone="orange">{PENDING_PILL}</CrmPill> : null}
                                  {customer.visitedToday ? <CrmPill tone="good">Visited today</CrmPill> : null}
                                </span>
                              </span>
                              <PlaceWindows customer={customer} />
                              {/* A customer not validated yet has no month standing to report: "2 of 3 visits this
                                  month" would read as progress on a figure his visits do not move. */}
                              <span className="mt-1 block text-xs font-semibold text-slate-600">
                                {customer.pending ? pendingVisitsText(customer.visitsThisMonth) : monthVisitsText(customer.visitsThisMonth, customer.target)}
                              </span>
                            </button>
                            {/* The way to his saved place (owner, 2026-10-02) hangs UNDER the card, joined by its
                                border, never inside it: the card is one button, and a link inside a button is
                                markup a phone resolves by firing the card. No saved place, no strip. */}
                            {directions ? (
                              <div className="flex min-w-0 flex-wrap justify-end border border-t-0 border-slate-200 bg-white px-3 py-1.5">
                                <DirectionsLink customerName={customer.name} href={directions} />
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
 */
export function OutOfPlanReason({
  customer,
  deciders,
  initialReason,
  onBack,
  onContinue,
}: {
  customer: VisitCustomerOption;
  /** "Mona Adel decides it first, then SFE." */
  deciders: string;
  initialReason: string;
  onBack: () => void;
  onContinue: (reason: string) => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const [problem, setProblem] = useState<string | null>(null);
  const length = reason.trim().length;
  // Inside Add visit's step form the form's own foot carries Back: one Back, never two.
  const framed = useInsideCrmStepForm();

  function next() {
    if (length < UNPLANNED_REASON_MIN) {
      setProblem(`Write why you went — at least ${UNPLANNED_REASON_MIN} characters.`);
      return;
    }
    onContinue(reason.trim());
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Back" onBack={onBack} title="Out of plan" />
      <CrmBlock>
        <p className="break-words text-base font-black text-slate-950">{customer.name}</p>
        <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        <CrmNote className="mb-3" title="It counts once it is approved" tone="info">
          {deciders} Until then it counts in nothing — not your call rate, not coverage, not frequency.
        </CrmNote>
        <CrmField
          error={problem}
          hint={length < UNPLANNED_REASON_MIN ? `At least ${UNPLANNED_REASON_MIN} characters.` : `${countText(UNPLANNED_REASON_MAX - reason.length)} left.`}
          htmlFor="phoenix-crm-out-of-plan-reason"
          label="Why you went"
        >
          <textarea
            className={crmTextareaClassName}
            dir="auto"
            id="phoenix-crm-out-of-plan-reason"
            maxLength={UNPLANNED_REASON_MAX}
            onChange={(event) => {
              setProblem(null);
              setReason(event.target.value);
            }}
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
