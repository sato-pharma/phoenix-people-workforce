"use client";

// Business Review — the rollups the owner asked for by name.
//
//   CustomersByAreaTable — "how many customers did this area have in May" — one row per area,
//                          one column per month, with the change across the window.
//   RoleActivityTable    — activity per job role: reps, district managers, product managers,
//                          training managers, national managers. Each row carries the limits of
//                          what its role can honestly be measured on, printed verbatim.
//   PeopleActivityTable  — the individuals behind that role table, ranked, and capped.
//
// TWO COUNTING RULES, BOTH LOAD-BEARING:
//
//  1. CUSTOMERS ARE UNIONED, NEVER SUMMED. A doctor seen by two reps in one area is ONE customer
//     that month. So an area's window total is NOT the sum of its months, and the table says so
//     rather than letting a reader add the row up and find a different number.
//  2. A ROLE WITH A NAMED LIMIT PRINTS THE LIMIT. Visits per product do not exist in the CRM feed
//     — there is no product column. Rather than leaving a Product Manager's row looking idle, the
//     note says what is and is not measurable.
//
// DESKTOP TABLE / MOBILE CARDS, on the house primitives. The owner's standing rule is that a phone
// never gets a table, and the portal surface these mount into states the same rule in its own
// header. A ~900px table inside a bare `overflow-x-auto` scrolls sideways in a container that gives
// no hint it is scrollable, and the last column — here the window total, the number the whole table
// is for — is the first thing off the right edge.
//
// PortalResponsiveDataList renders BOTH halves and hides one in CSS, so its cost is 2x the row
// count at every width (18.8MB of HTML shipped to phones on Doctor Coverage before #2282). Every
// list below is bounded before it reaches the primitive: one row per area (~107 company-wide, a
// handful for a District Manager), one row per job role, and `limit` rows of people.

import {
  PortalDesktopTable,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { cn } from "@/lib/utils";
import type { ReviewPersonRow, ReviewRoleRow } from "@/lib/business-review/sources/roles";
import { formatVisitCountSplit, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { periodColumnLabel } from "@/lib/business-review/period-format";
import { employmentStatusLabel } from "@/lib/employees/employment-status-label";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

const num = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
const egp = (n: number) =>
  stableCurrencyFormatter("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(
    Number.isFinite(n) ? n : 0,
  );

const TH = "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const THR = "px-3 py-2 text-right text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const TD = "px-3 py-2 text-sm";
const TDR = "px-3 py-2 text-sm text-right tabular-nums";

/** The panel's own chrome. No `overflow-x-auto` here — the desktop half brings its own, and adding
 *  one at this level would re-create the sideways-scrolling phone this file exists to avoid. */
function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h2 className="text-sm font-bold">{title}</h2>
        {note && <span className="min-w-0 text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-4 text-sm text-muted-foreground">{children}</p>;
}

/**
 * One labelled figure inside a card.
 *
 * `min-w-0` is not decoration. A grid item defaults to `min-width: auto`, so a long value pushes
 * the whole card wider than the viewport and the text is then cut at an ancestor with no ellipsis
 * — which reads like a copy bug rather than a layout bug (#2218, #2220).
 */
function Field({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 rounded border border-slate-100 bg-slate-50 px-2 py-1.5">
      <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className={cn("mt-0.5 min-w-0 break-words text-xs font-bold tabular-nums text-slate-800", tone)}>
        {value}
      </dd>
    </div>
  );
}

/** Month-over-month movement, coloured. Null when there is nothing to compare against. */
function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (value === 0) return <span className="tabular-nums text-muted-foreground">0</span>;
  return (
    <span className={cn("font-semibold tabular-nums", value > 0 ? "text-emerald-600" : "text-red-600")}>
      {value > 0 ? "+" : ""}
      {num(value)}
    </span>
  );
}

function VacantChip() {
  return (
    <span className="ml-2 rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold text-muted-foreground">
      VACANT
    </span>
  );
}

export type CustomerAreaRow = {
  area: string;
  dm: string;
  line?: string;
  vacant: boolean;
  customersTotal: number;
  customersByMonth: Record<string, number>;
  /** The window total, three ways — AM accounts · PM doctors · Pharmacies. Owner golden rule: a
   *  pharmacy is never counted among the doctors, so the total alone cannot be called "doctors". */
  customersAm: number;
  customersPm: number;
  customersPharmacy: number;
  /** The visits those customers were counted from — what judges their pharmacy figure (below). */
  visitSplit?: VisitCountSplit;
};

/**
 * The three figures in the house wording, middle dot and never a slash — judged by the visits the
 * customers were counted from, so a team that works in Phoenix CRM (which logs no pharmacy visit)
 * reads "Pharmacies not recorded in Phoenix", never 0 (src/lib/crm/visit-count-buckets.ts).
 */
const splitOf = (row: {
  customersAm: number;
  customersPm: number;
  customersPharmacy: number;
  visitSplit?: VisitCountSplit;
  customerVisitSplit?: VisitCountSplit;
}) =>
  formatVisitCountSplit(
    { am: row.customersAm, pm: row.customersPm, pharmacies: row.customersPharmacy },
    { fromVisits: row.customerVisitSplit ?? row.visitSplit },
  );

/**
 * Customers reached per area, month by month — AM accounts, PM doctors and pharmacies apart.
 *
 * The window total is a UNION across the whole window, not the sum of the columns — a doctor seen
 * in both April and May is one customer for the window and one in each of those months. Reading
 * the row as a sum would overstate it every time, so the header says which is which.
 */
export function CustomersByAreaTable({
  areas,
  months,
  showLine = false,
  visitsAvailable,
}: {
  areas: CustomerAreaRow[];
  months: string[];
  showLine?: boolean;
  visitsAvailable: boolean;
}) {
  if (!visitsAvailable) {
    return (
      <Panel title="Customers reached by area, month by month">
        <PanelNote>
          No CRM visit rows exist for this window, so no doctor can be counted. This is not zero doctors.
        </PanelNote>
      </Panel>
    );
  }

  const first = months[0];
  const last = months[months.length - 1];
  const ranked = [...areas].sort((a, b) => b.customersTotal - a.customersTotal);
  const changeOf = (a: CustomerAreaRow) =>
    months.length > 1 ? (a.customersByMonth[last] ?? 0) - (a.customersByMonth[first] ?? 0) : null;

  return (
    <Panel
      note="window total is a union of the months, not their sum · AM accounts, PM doctors and pharmacies apart"
      title="Customers reached by area, month by month"
    >
      <PortalResponsiveDataList
        empty={<PanelNote>No area in scope reached a customer in this window.</PanelNote>}
        getKey={(a) => `${a.line ?? ""}-${a.area}`}
        items={ranked}
        renderCard={(a) => (
          <div className="px-4 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-black text-slate-950">
                {a.area}
                {a.vacant && <VacantChip />}
              </h3>
              <p className="mt-0.5 min-w-0 break-words text-xs font-semibold text-slate-500">
                {showLine && a.line ? `${a.line} · ` : ""}
                {a.dm}
              </p>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2">
              {months.map((m) => (
                <Field key={m} label={periodColumnLabel(m, months)} value={num(a.customersByMonth[m] ?? 0)} />
              ))}
            </dl>
            <dl className="mt-2 grid grid-cols-2 gap-2">
              {months.length > 1 && <Field label="Change" value={<Delta value={changeOf(a)} />} />}
              <Field label="Window (union)" tone="text-slate-950" value={num(a.customersTotal)} />
              <Field label="AM · PM · Pharmacies" value={splitOf(a)} />
            </dl>
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[16%]" />
                {showLine && <col className="w-[10%]" />}
                <col className="w-[14%]" />
                {months.map((m) => (
                  <col key={m} />
                ))}
                {months.length > 1 && <col className="w-[10%]" />}
                <col className="w-[12%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Area</th>
                {showLine && <th className={TH}>Line</th>}
                <th className={TH}>District</th>
                {months.map((m) => (
                  <th className={THR} key={m}>
                    {periodColumnLabel(m, months)}
                  </th>
                ))}
                {months.length > 1 && <th className={THR}>Change</th>}
                <th className={THR}>Window</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((a) => (
                <tr className="border-b border-border/60 last:border-0" key={`${a.line ?? ""}-${a.area}`}>
                  <td className={cn(TD, "break-words font-semibold")}>
                    {a.area}
                    {a.vacant && <VacantChip />}
                  </td>
                  {showLine && <td className={cn(TD, "break-words text-muted-foreground")}>{a.line}</td>}
                  <td className={cn(TD, "break-words text-muted-foreground")}>{a.dm}</td>
                  {months.map((m) => (
                    <td className={TDR} key={m}>
                      {num(a.customersByMonth[m] ?? 0)}
                    </td>
                  ))}
                  {months.length > 1 && (
                    <td className={TDR}>
                      <Delta value={changeOf(a)} />
                    </td>
                  )}
                  <td className={cn(TDR, "font-semibold")}>{num(a.customersTotal)}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </Panel>
  );
}

/**
 * Activity per job role.
 *
 * Territory-owning roles are measured on visits and doctors; managers are measured on the double
 * visits they rode and the reps they rode with. Where a role cannot honestly be measured on either,
 * its row says why instead of showing a zero.
 */
export function RoleActivityTable({ roles, scopeNote }: { roles: ReviewRoleRow[]; scopeNote?: string }) {
  if (roles.length === 0) {
    return (
      <Panel title="Activity by role">
        <PanelNote>No recorded activity for any role in this window.</PanelNote>
      </Panel>
    );
  }
  const noted = roles.filter((r) => r.note);

  return (
    <Panel
      note={`visits, rides and spend per job function${scopeNote ? ` · ${scopeNote}` : ""}`}
      title="Activity by role"
    >
      <PortalResponsiveDataList
        empty={<PanelNote>No recorded activity for any role in this window.</PanelNote>}
        getKey={(r) => r.role}
        items={roles}
        renderCard={(r) => (
          <div className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 break-words text-sm font-black text-slate-950">{r.role}</h3>
              <span className="whitespace-nowrap text-xs font-bold text-slate-500">
                {num(r.people)} of {num(r.headcount)} active
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2">
              <Field label="Field visits" tone="text-slate-950" value={num(r.fieldVisits)} />
              <Field label="Regular" value={num(r.regularVisits)} />
              <Field label="Campaign" value={num(r.campaignVisits)} />
              <Field label="Rides led" value={num(r.ridesLed)} />
              <Field label="Reps coached" value={num(r.repsCoached)} />
              <Field label="Customers" value={num(r.customersReached)} />
              <Field label="AM · PM · Pharmacies" value={splitOf(r)} />
              <Field label="Outstation" value={egp(r.outstationClaimed)} />
              <Field label="Marketing" value={egp(r.marketingCommitted)} />
            </dl>
            {/* The card carries its own limit inline. A role that cannot be measured on visits has
                to say so next to its zeros, not in a footnote a phone reader may never reach. */}
            {r.note && <p className="mt-2 min-w-0 break-words text-xs text-muted-foreground">{r.note}</p>}
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[14%]" />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Role</th>
                <th className={THR}>Headcount</th>
                <th className={THR}>Active</th>
                <th className={THR}>Field visits</th>
                <th className={THR}>Regular</th>
                <th className={THR}>Campaign</th>
                <th className={THR}>Rides led</th>
                <th className={THR}>Reps coached</th>
                <th className={THR}>AM · PM · Pharmacies</th>
                <th className={THR}>Outstation</th>
                <th className={THR}>Marketing</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr className="border-b border-border/60 last:border-0" key={r.role}>
                  <td className={cn(TD, "break-words font-semibold")}>{r.role}</td>
                  <td className={TDR}>{num(r.headcount)}</td>
                  <td className={TDR}>{num(r.people)}</td>
                  <td className={cn(TDR, "font-semibold")}>{num(r.fieldVisits)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{num(r.regularVisits)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{num(r.campaignVisits)}</td>
                  <td className={TDR}>{num(r.ridesLed)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{num(r.repsCoached)}</td>
                  <td className={TDR}>{splitOf(r)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{egp(r.outstationClaimed)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{egp(r.marketingCommitted)}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
      {/* Desktop only — the cards already print each note inline, and repeating it on a phone would
          push the figures a screen further down for no gain. */}
      {noted.length > 0 && (
        <div className="hidden space-y-1.5 border-t border-border px-4 py-3 md:block">
          {noted.map((r) => (
            <p className="text-xs text-muted-foreground" key={r.role}>
              <span className="font-bold text-foreground">{r.role}:</span> {r.note}
            </p>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** The individuals behind the role table, ranked by recorded fieldwork. */
export function PeopleActivityTable({
  people,
  limit = 40,
  scopeNote,
}: { people: ReviewPersonRow[]; limit?: number; scopeNote?: string }) {
  if (people.length === 0) {
    return (
      <Panel title="People by recorded activity">
        <PanelNote>Nobody recorded activity in this window.</PanelNote>
      </Panel>
    );
  }
  const shown = people.slice(0, limit);
  return (
    <Panel
      note={
        (people.length > shown.length
          ? `top ${shown.length} of ${num(people.length)} — the full list is in the Excel export`
          : `${num(people.length)} people`) + (scopeNote ? ` · ${scopeNote}` : "")
      }
      title="People by recorded activity"
    >
      <PortalResponsiveDataList
        empty={<PanelNote>Nobody recorded activity in this window.</PanelNote>}
        getKey={(p) => p.hrId}
        items={shown}
        renderCard={(p, i) => (
          <div className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {/* Names run to 52 characters in this directory, so they wrap rather than push the
                    card past the viewport — the same shape as the #2268 title fix. */}
                <h3 className="min-w-0 break-words text-sm font-black text-slate-950">{p.name}</h3>
                <p className="mt-0.5 min-w-0 break-words text-xs font-semibold text-slate-500">
                  {p.jobTitle || p.role}
                  {p.employmentStatus !== "active" ? ` · ${employmentStatusLabel(p.employmentStatus)}` : ""}
                </p>
              </div>
              {/* `shrink-0` — the chip is `whitespace-nowrap`, so a flex parent that is allowed to
                  shrink it hands it 13px for 21px of content and it hangs out of its own row. */}
              <span className="shrink-0 whitespace-nowrap text-xs font-black tabular-nums text-slate-400">#{i + 1}</span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2">
              <Field label="Field visits" tone="text-slate-950" value={num(p.fieldVisits)} />
              <Field label="Per month" value={p.avgPerActiveMonth.toFixed(1)} />
              <Field label="Active months" value={num(p.activeMonths)} />
              <Field label="Rides led" value={num(p.ridesLed)} />
              <Field label="Customers" value={num(p.customers)} />
              <Field label="AM · PM · Pharmacies" value={splitOf(p)} />
              <Field label="Outstation" value={egp(p.outstationClaimed)} />
            </dl>
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[5%]" />
                <col className="w-[20%]" />
                <col className="w-[15%]" />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>#</th>
                <th className={TH}>Name</th>
                <th className={TH}>Role</th>
                <th className={THR}>Field visits</th>
                <th className={THR}>Per active month</th>
                <th className={THR}>Rides led</th>
                <th className={THR}>AM · PM · Pharmacies</th>
                <th className={THR}>Active months</th>
                <th className={THR}>Outstation</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr className="border-b border-border/60 last:border-0" key={p.hrId}>
                  <td className={cn(TD, "text-muted-foreground")}>{i + 1}</td>
                  <td className={cn(TD, "break-words font-semibold")}>
                    {p.name}
                    {p.employmentStatus !== "active" && (
                      <span className="ml-2 rounded bg-bg-muted px-1.5 py-0.5 text-phx-2xs font-bold uppercase text-muted-foreground">
                        {employmentStatusLabel(p.employmentStatus)}
                      </span>
                    )}
                  </td>
                  <td className={cn(TD, "break-words text-muted-foreground")}>{p.jobTitle || p.role}</td>
                  <td className={cn(TDR, "font-semibold")}>{num(p.fieldVisits)}</td>
                  <td className={TDR}>{p.avgPerActiveMonth.toFixed(1)}</td>
                  <td className={TDR}>{num(p.ridesLed)}</td>
                  <td className={TDR}>{splitOf(p)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{num(p.activeMonths)}</td>
                  <td className={cn(TDR, "text-muted-foreground")}>{egp(p.outstationClaimed)}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </Panel>
  );
}
