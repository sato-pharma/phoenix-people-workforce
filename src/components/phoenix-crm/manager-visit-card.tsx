import type { ReactNode } from "react";

import {
  managerVisitClock,
  managerVisitCustomerType,
  managerVisitWhereLines,
  type ManagerDayVisit,
} from "@/lib/phoenix-crm/manager-visit-detail";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — ONE manager visit in full, the card both the manager's day page and the private calendar draw.
 *
 * Owner, 2026-10-20: a district manager's visits showed as a bare count; he asked for "name, address, brick,
 * type, AM/PM, when, single, double — every single detail, very premium and polished". Everything the record
 * holds is on the card, in the order a reader asks for it: WHEN (the clock, in Cairo), WHICH HALF, SINGLE OR
 * DOUBLE, then WHO the customer is, WHERE they are, who came along, what was discussed.
 *
 * 🔴 The house rules built in: square edges everywhere (`rounded-none`), nothing that scrolls sideways (every
 *    line wraps, a long Arabic name included), no ellipsis anywhere, and no raw ids — a person and a place are
 *    always read by NAME.
 * 🔴 The AM · PM · Pharmacies golden rule: the half is printed as ITS OWN pill and never added to anything, and a
 *    pharmacy is its own word, not a PM.
 * 🔴 Pure markup — no state, no fetch — so a client screen and a server page draw it identically.
 */

const KIND_STYLES: Record<ManagerDayVisit["kind"], string> = {
  chain: "border-violet-200 bg-violet-50 text-violet-700",
  double: "border-sky-200 bg-sky-50 text-sky-700",
  product_manager: "border-teal-200 bg-teal-50 text-teal-700",
  single: "border-slate-300 bg-slate-100 text-slate-700",
};

const BUCKET_STYLES: Record<string, string> = {
  AM: "border-cyan-200 bg-cyan-50 text-cyan-800",
  Pharmacy: "border-emerald-200 bg-emerald-50 text-emerald-800",
  PM: "border-orange-200 bg-orange-50 text-orange-800",
};

const ACCENTS: Record<string, string> = {
  AM: "border-l-cyan-500",
  Pharmacy: "border-l-emerald-500",
  PM: "border-l-orange-500",
};

function Chip({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-none border px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.08em]", className)}>
      {children}
    </span>
  );
}

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0 border border-slate-100 bg-slate-50/80 px-3 py-2">
      <dt className="break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</dt>
      <dd className="mt-1 min-w-0 break-words text-xs font-bold leading-5 text-slate-800">{children}</dd>
    </div>
  );
}

/** "AM" for the half an own visit was counted in, "Pharmacy" for the third list; a ride-along's own list. */
function countedBucket(visit: ManagerDayVisit): "AM" | "PM" | "Pharmacy" {
  if (visit.source === "ride_along" && visit.listType === "Pharmacy") return "Pharmacy";
  return visit.bucket === "AM" ? "AM" : visit.bucket === "PM" ? "PM" : "Pharmacy";
}

function countedAsText(visit: ManagerDayVisit): string {
  const bucket = countedBucket(visit);
  if (visit.source === "own") {
    return `${bucket} half of the day. A single visit the manager made alone, counted in their own report only — never in a rep's figures.`;
  }
  if (bucket === "Pharmacy") return "Pharmacy list. Counted apart, never inside AM or PM, and on the rep's row too.";
  return `${bucket} list, the way the rep's own row counts it. The rep has this visit on their calendar as well.`;
}

function loggedHalfNote(visit: ManagerDayVisit): string | null {
  if (visit.source !== "own" || !visit.loggedHalf || visit.loggedHalf === visit.bucket) return null;
  return `Logged in the ${visit.loggedHalf === "AM" ? "morning" : "afternoon"}, counted in the ${visit.bucket} half it was planned for.`;
}

export function ManagerVisitCard({ visit }: { visit: ManagerDayVisit }) {
  const bucket = countedBucket(visit);
  const where = managerVisitWhereLines(visit);
  const customerType = managerVisitCustomerType(visit);
  const loggedNote = loggedHalfNote(visit);

  return (
    <article className={cn("min-w-0 border border-l-4 border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]", ACCENTS[bucket])}>
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <p className="shrink-0 text-base font-black tabular-nums tracking-tight text-slate-950">{managerVisitClock(visit.loggedAt)}</p>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <Chip className={BUCKET_STYLES[bucket]}>{bucket === "Pharmacy" ? "Pharmacy" : visit.source === "own" ? `${bucket} half` : `${bucket} list`}</Chip>
          <Chip className={KIND_STYLES[visit.kind]}>{visit.kindLabel}</Chip>
          <Chip className={visit.planned ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}>
            {visit.planned ? "Planned" : "Not on the plan"}
          </Chip>
          {visit.awaitingValidation ? <Chip className="border-slate-200 bg-white text-slate-600">Not scored yet — customer not validated</Chip> : null}
          {visit.inVacantTerritory ? <Chip className="border-amber-200 bg-amber-50 text-amber-800">Vacant area</Chip> : null}
        </div>
      </header>

      <div className="min-w-0 px-4 py-3.5">
        <h3 className="break-words text-base font-black leading-6 text-slate-950" dir="auto">
          {visit.customerName}
        </h3>
        {customerType ? <p className="mt-0.5 break-words text-xs font-bold leading-5 text-slate-500">{customerType}</p> : null}

        <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Fact label="Where">
            {where.length > 0 ? (
              <span className="grid gap-0.5">
                {where.map((line) => (
                  <span dir="auto" key={line}>
                    {line}
                  </span>
                ))}
              </span>
            ) : (
              <span className="font-semibold text-slate-500">No address on file for this customer.</span>
            )}
            {visit.placeLabel ? (
              <span className="mt-0.5 block font-semibold text-slate-500" dir="auto">
                {visit.placeLabel}
              </span>
            ) : null}
          </Fact>
          <Fact label="Counted as">
            <span className="font-semibold text-slate-700">{countedAsText(visit)}</span>
            {loggedNote ? <span className="mt-0.5 block font-semibold text-slate-500">{loggedNote}</span> : null}
          </Fact>
          {visit.territoryName ? <Fact label="Customer's territory">{visit.territoryName}</Fact> : null}
          {visit.withPeople.length > 0 ? (
            <Fact label="On the visit with">
              <span className="grid gap-0.5">
                {visit.withPeople.map((person) => (
                  <span key={`${person.role}|${person.name}`}>
                    <span dir="auto">{person.name}</span>
                    <span className="font-semibold text-slate-500">{` · ${person.role}`}</span>
                  </span>
                ))}
              </span>
            </Fact>
          ) : visit.source === "own" ? (
            <Fact label="On the visit with">
              <span className="font-semibold text-slate-600">Nobody — the manager was alone.</span>
            </Fact>
          ) : null}
          <Fact label="Products discussed">
            {visit.products.length > 0 ? visit.products.join(", ") : <span className="font-semibold text-slate-500">None recorded.</span>}
          </Fact>
          {visit.pharmacyName && visit.listType !== "Pharmacy" ? (
            <Fact label="Pharmacy feedback from">
              <span dir="auto">{visit.pharmacyName}</span>
            </Fact>
          ) : null}
          <Fact label="Location">
            {visit.hasPin ? "A location was captured with this visit." : "No location was captured with this visit."}
            {visit.placeSource === "on_the_visit" ? (
              <span className="mt-0.5 block font-semibold text-slate-500">The address above was typed or captured on the visit itself.</span>
            ) : null}
          </Fact>
        </dl>

        {visit.comment ? (
          <div className="mt-2 min-w-0 border border-slate-100 bg-white px-3 py-2">
            <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Comment</p>
            <p className="mt-1 whitespace-pre-line break-words text-xs font-semibold leading-5 text-slate-700" dir="auto">
              {visit.comment}
            </p>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** A day's visits, earliest first, one card each. */
export function ManagerVisitList({ visits }: { visits: readonly ManagerDayVisit[] }) {
  return (
    <div className="grid min-w-0 gap-2.5">
      {visits.map((visit) => (
        <ManagerVisitCard key={visit.id} visit={visit} />
      ))}
    </div>
  );
}
