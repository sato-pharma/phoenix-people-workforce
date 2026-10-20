import type { ReactNode } from "react";

import { CrmNote, CrmStat, CrmStatGrid, CrmTable } from "@/components/phoenix-crm/ui";
import { buildPlanVsActual, type ManagerDayPlan, type PlanRowOutcome, type PlanVsActualRow, type PlanVsActualSummary } from "@/lib/phoenix-crm/manager-day-plan";
import {
  managerVisitAreaLines,
  managerVisitClock,
  managerVisitCustomerType,
  managerVisitHalfLabel,
  type ManagerDayVisit,
} from "@/lib/phoenix-crm/manager-visit-detail";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — a manager's day as ONE table (owner, 2026-10-20: "a ONE table — the plan as a header, then the actual
 * status, matching or not, then the area and brick of the actual, then the address and the time").
 *
 * Four columns, in that order, and nothing else beside them:
 *   Plan · Actual status · Area · Brick · Address · Time
 * One row per planned customer and one per visit nobody planned. The rest of a visit's record (the customer's type,
 * territory, who came along, products, location pin, comment) is NOT another column: it is one spanning line under the
 * row it belongs to, inside the same table, so nothing the owner asked for earlier is lost and the table stays four wide.
 *
 * 🔴 The status on a planned row is the weekly report's (`Done` / `Not done` / `Today` / `Coming`), set beside the visit
 *    that proves it; this component decides nothing. "Matches the plan" is said only where the report said Done.
 * 🔴 House rules built in: square edges (`rounded-none`), the module's own `CrmTable` (fixed layout, named widths) so it
 *    fits its panel, cards instead of a table when the PANEL — not the screen — is narrower than 720px (`@container`: the
 *    private calendar's day sits in a column that can be narrow on a wide desktop), nothing truncated with an ellipsis,
 *    and a customer or place always read by NAME. The AM · PM · Pharmacies golden rule: a half is its own chip, a
 *    pharmacy its own word, and nothing here adds one to another.
 * 🔴 Pure markup — no state, no fetch — so a client screen and a server page draw it identically.
 */

const OUTCOME_STYLES: Record<PlanRowOutcome, { chip: string; accent: string }> = {
  ahead: { accent: "border-l-sky-400", chip: "border-sky-200 bg-sky-50 text-sky-700" },
  done: { accent: "border-l-emerald-500", chip: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  no_plan: { accent: "border-l-slate-300", chip: "border-slate-200 bg-slate-50 text-slate-600" },
  not_checkable: { accent: "border-l-slate-300", chip: "border-slate-200 bg-slate-50 text-slate-600" },
  not_done: { accent: "border-l-rose-500", chip: "border-rose-200 bg-rose-50 text-rose-700" },
  open: { accent: "border-l-amber-400", chip: "border-amber-200 bg-amber-50 text-amber-800" },
  unplanned: { accent: "border-l-violet-500", chip: "border-violet-200 bg-violet-50 text-violet-700" },
};

/** What the verdict means in a sentence, so a reader never has to know the report's vocabulary. */
const OUTCOME_SENTENCE: Record<PlanRowOutcome, string | null> = {
  ahead: null,
  done: "Matches the plan.",
  no_plan: "No sent plan to match against.",
  not_checkable: "Nothing to check for this half-day.",
  not_done: "Nothing was logged for it.",
  open: "Not due yet, or still open today.",
  unplanned: "Visited, but not on the plan.",
};

const HALF_STYLES: Record<string, string> = {
  AM: "border-cyan-200 bg-cyan-50 text-cyan-800",
  Pharmacy: "border-emerald-200 bg-emerald-50 text-emerald-800",
  PM: "border-orange-200 bg-orange-50 text-orange-800",
};

const KIND_STYLES: Record<ManagerDayVisit["kind"], string> = {
  chain: "border-violet-200 bg-violet-50 text-violet-700",
  double: "border-sky-200 bg-sky-50 text-sky-700",
  product_manager: "border-teal-200 bg-teal-50 text-teal-700",
  single: "border-slate-300 bg-slate-100 text-slate-700",
};

/**
 * The header cell of `crmThClassName` (ui.tsx), copied rather than imported: that module is "use client" and this file
 * is drawn by a server page too, and a server module may not import a plain value out of a client one (the RSC
 * boundary pin). Keep the two strings equal.
 */
const TH_CLASS =
  "border-b border-slate-200 bg-slate-50 px-3 py-2.5 align-bottom text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500 border-t-2 border-t-slate-900";

function Chip({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-none border px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.08em]", className)}>
      {children}
    </span>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">{children}</p>;
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="break-words text-xs font-semibold leading-5 text-slate-500">{children}</p>;
}

function HalfChip({ half }: { half: string }) {
  return <Chip className={HALF_STYLES[half] ?? HALF_STYLES.AM}>{half}</Chip>;
}

/** The half-day, then what was planned for it: who with, which customer, the note. */
function PlanCell({ row }: { row: PlanVsActualRow }) {
  if (!row.plan) {
    return (
      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <HalfChip half={row.half} />
          <Chip className="border-slate-300 bg-white text-slate-600">Not planned</Chip>
        </div>
        <Muted>{row.outcome === "no_plan" ? "No sent plan covers this day." : "Nobody put this visit on the week."}</Muted>
      </div>
    );
  }
  const { plan } = row;
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <HalfChip half={row.half} />
        <Chip className="border-slate-300 bg-slate-100 text-slate-700">{plan.kindLabel}</Chip>
        {plan.flagLabel ? <Chip className="border-amber-200 bg-amber-50 text-amber-800">{plan.flagLabel}</Chip> : null}
      </div>
      <p className="break-words text-sm font-black leading-5 text-slate-950" dir="auto">
        {plan.title}
      </p>
      {plan.customerName ? (
        <p className="break-words text-sm font-bold leading-5 text-slate-800" dir="auto">
          {plan.customerName}
        </p>
      ) : (
        <Muted>No customer ticked.</Muted>
      )}
      {plan.place ? (
        <Muted>
          <span dir="auto">{plan.place}</span>
        </Muted>
      ) : null}
      {plan.note ? (
        <p className="whitespace-pre-line break-words border-l-2 border-slate-200 pl-2 text-xs font-semibold leading-5 text-slate-600" dir="auto">
          {plan.note}
        </p>
      ) : null}
    </div>
  );
}

/** The verdict — matching the plan or not — and, when there is a visit, who was seen and how. */
function StatusCell({ row }: { row: PlanVsActualRow }) {
  const style = OUTCOME_STYLES[row.outcome];
  const visit = row.actual;
  const sentence = OUTCOME_SENTENCE[row.outcome];
  const type = visit ? managerVisitCustomerType(visit) : "";
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip className={style.chip}>{row.outcomeLabel}</Chip>
        {visit ? <Chip className={KIND_STYLES[visit.kind]}>{visit.kindLabel}</Chip> : null}
      </div>
      {sentence ? <Muted>{sentence}</Muted> : null}
      {visit ? (
        <>
          <p className="break-words text-sm font-black leading-5 text-slate-950" dir="auto">
            {visit.customerName}
          </p>
          {type ? <p className="break-words text-xs font-bold leading-5 text-slate-700">{type}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            <Chip className="border-slate-200 bg-white text-slate-600">{managerVisitHalfLabel(visit)}</Chip>
            {visit.awaitingValidation ? <Chip className="border-slate-200 bg-white text-slate-600">Not scored yet</Chip> : null}
            {visit.inVacantTerritory ? <Chip className="border-amber-200 bg-amber-50 text-amber-800">Vacant area</Chip> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The brick, then the area, of the visit that was made — never of the plan. Each on its own line. */
function AreaBrickCell({ row }: { row: PlanVsActualRow }) {
  const visit = row.actual;
  if (!visit) return <Muted>—</Muted>;
  const lines = managerVisitAreaLines(visit);
  if (lines.length === 0) return <Muted>No area or brick on file.</Muted>;
  return (
    <div className="grid min-w-0 gap-0.5">
      {lines.map((line) => (
        <p className="break-words text-sm font-bold leading-5 text-slate-800" dir="auto" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

/** The street address the visit was logged at, then the Cairo clock it was logged at. */
function AddressTimeCell({ row }: { row: PlanVsActualRow }) {
  const visit = row.actual;
  if (!visit) return <Muted>—</Muted>;
  return (
    <div className="grid min-w-0 gap-1">
      {visit.address ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-800" dir="auto">
          {visit.address}
        </p>
      ) : (
        <Muted>No address on file.</Muted>
      )}
      {visit.placeLabel ? (
        <Muted>
          <span dir="auto">{visit.placeLabel}</span>
        </Muted>
      ) : null}
      <p className="text-base font-black tabular-nums leading-6 tracking-tight text-slate-950">{managerVisitClock(visit.loggedAt)}</p>
    </div>
  );
}

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className="min-w-0 break-words">
      <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">{label} </span>
      <span className="text-xs font-bold leading-5 text-slate-700">{children}</span>
    </span>
  );
}

/** The rest of the visit's record — one line under its row, so the table stays four wide. Null when there is nothing more to say. */
function MoreAboutVisit({ row }: { row: PlanVsActualRow }) {
  const visit = row.actual;
  if (!visit) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1">
      {visit.territoryName ? <Fact label="Territory">{visit.territoryName}</Fact> : null}
      <Fact label="With">
        {visit.withPeople.length > 0 ? (
          visit.withPeople.map((person, index) => (
            <span key={`${person.role}|${person.name}`}>
              {index > 0 ? ", " : ""}
              <span dir="auto">{person.name}</span>
              <span className="font-semibold text-slate-500">{` · ${person.role}`}</span>
            </span>
          ))
        ) : (
          <span className="font-semibold text-slate-500">{visit.source === "own" ? "Alone." : "No one else named."}</span>
        )}
      </Fact>
      <Fact label="Products">
        {visit.products.length > 0 ? visit.products.join(", ") : <span className="font-semibold text-slate-500">None recorded.</span>}
      </Fact>
      {visit.pharmacyName && visit.listType !== "Pharmacy" ? (
        <Fact label="Pharmacy feedback from">
          <span dir="auto">{visit.pharmacyName}</span>
        </Fact>
      ) : null}
      <Fact label="Location">{visit.hasPin ? "A location was captured." : "No location captured."}</Fact>
      {visit.comment ? (
        <span className="w-full min-w-0 whitespace-pre-line break-words border-l-2 border-slate-200 pl-2 text-xs font-semibold leading-5 text-slate-700" dir="auto">
          {visit.comment}
        </span>
      ) : null}
    </div>
  );
}

/** The summary strip: the day in five numbers. Nothing here is added to anything else. */
function SummaryStrip({ summary }: { summary: PlanVsActualSummary }) {
  return (
    <CrmStatGrid className="@min-[720px]:grid-cols-5">
      <CrmStat label="Planned" note="Customers on the week for this day" value={summary.planned} />
      <CrmStat label="Done" note="Answered by a logged visit" tone="good" value={summary.done} />
      <CrmStat label="Not done" note="The day has closed with no visit" tone={summary.notDone > 0 ? "bad" : "neutral"} value={summary.notDone} />
      <CrmStat label="Still open" note="Today, or a day still to come" value={summary.open} />
      <CrmStat label="Not on the plan" note="Visits nobody planned" tone={summary.unplanned > 0 ? "warn" : "neutral"} value={summary.unplanned} />
    </CrmStatGrid>
  );
}

export function ManagerPlanActualTable({
  plan,
  planUnread,
  rows,
  summary,
}: {
  plan: ManagerDayPlan | null;
  planUnread: boolean;
  rows: readonly PlanVsActualRow[];
  summary: PlanVsActualSummary;
}) {
  return (
    <div className="@container grid min-w-0 gap-3">
      {plan?.sent ? <SummaryStrip summary={summary} /> : null}
      {plan && !plan.sent ? (
        <CrmNote title="No sent plan covers this day" tone="info">
          <p>
            {plan.statusLine ? `${plan.statusLine} ` : ""}A week that was not sent is not judged, so the visits below are listed in full and none is called planned or missed.
          </p>
        </CrmNote>
      ) : null}
      {planUnread ? (
        <CrmNote title="The plan could not be read" tone="warn">
          <p>The visits below are complete. Their plan column is empty because the weekly plan failed to load, not because nothing was planned. Reload to try again.</p>
        </CrmNote>
      ) : null}

      <div className="hidden min-w-0 @min-[720px]:block">
        {/* `desktopOnly={false}`: the container query above decides when this shows, not the viewport. */}
        <CrmTable columns={["26%", "25%", "17%", "32%"]} desktopOnly={false}>
          <thead>
            <tr>
              <th className={TH_CLASS}>Plan</th>
              <th className={TH_CLASS}>Actual status</th>
              <th className={TH_CLASS}>Area · Brick</th>
              <th className={TH_CLASS}>Address · Time</th>
            </tr>
          </thead>
          {rows.map((row, index) => {
            const more = row.actual ? <MoreAboutVisit row={row} /> : null;
            const tint = index % 2 === 0 ? "bg-white" : "bg-slate-50/40";
            return (
              <tbody key={row.id}>
                <tr className={cn("align-top", tint)}>
                  <td className={cn("border-l-4 px-3 pt-3 align-top", more ? "pb-1.5" : "border-b border-b-slate-100 pb-3", OUTCOME_STYLES[row.outcome].accent)}>
                    <PlanCell row={row} />
                  </td>
                  <td className={cn("px-3 pt-3 align-top", more ? "pb-1.5" : "border-b border-slate-100 pb-3")}>
                    <StatusCell row={row} />
                  </td>
                  <td className={cn("px-3 pt-3 align-top", more ? "pb-1.5" : "border-b border-slate-100 pb-3")}>
                    <AreaBrickCell row={row} />
                  </td>
                  <td className={cn("px-3 pt-3 align-top", more ? "pb-1.5" : "border-b border-slate-100 pb-3")}>
                    <AddressTimeCell row={row} />
                  </td>
                </tr>
                {more ? (
                  <tr className={tint}>
                    <td className={cn("border-b border-l-4 border-b-slate-100 px-3 pb-3 pt-1", OUTCOME_STYLES[row.outcome].accent)} colSpan={4}>
                      <div className="border-t border-dashed border-slate-200 pt-2">{more}</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            );
          })}
        </CrmTable>
      </div>

      <div className="grid min-w-0 gap-2.5 @min-[720px]:hidden">
        {rows.map((row) => (
          <article
            className={cn("min-w-0 border border-l-4 border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.05)]", OUTCOME_STYLES[row.outcome].accent)}
            key={row.id}
          >
            <div className="grid min-w-0 gap-3 px-3 py-3">
              <section className="grid gap-1">
                <Label>Plan</Label>
                <PlanCell row={row} />
              </section>
              <section className="grid gap-1 border-t border-slate-100 pt-3">
                <Label>Actual status</Label>
                <StatusCell row={row} />
              </section>
              {row.actual ? (
                <>
                  <section className="grid gap-1 border-t border-slate-100 pt-3">
                    <Label>Area · Brick</Label>
                    <AreaBrickCell row={row} />
                  </section>
                  <section className="grid gap-1 border-t border-slate-100 pt-3">
                    <Label>Address · Time</Label>
                    <AddressTimeCell row={row} />
                  </section>
                  <section className="grid gap-1 border-t border-slate-100 pt-3">
                    <Label>More about the visit</Label>
                    <MoreAboutVisit row={row} />
                  </section>
                </>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/** The table for a day's plan and visits — what a screen that holds them in pieces (the private calendar) draws. */
export function ManagerPlanActual({
  plan,
  planUnread,
  visits,
}: {
  plan: ManagerDayPlan | null;
  planUnread: boolean;
  visits: readonly ManagerDayVisit[];
}) {
  const { rows, summary } = buildPlanVsActual(plan, visits);
  if (rows.length === 0) return null;
  return <ManagerPlanActualTable plan={plan} planUnread={planUnread} rows={rows} summary={summary} />;
}
