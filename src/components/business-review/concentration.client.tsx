"use client";

import {
  SALES_CHANNELS,
  describeSpread,
  type ConcentrationFacts,
  type SalesChannel,
} from "@/lib/business-review/concentration";
import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import {
  SPECIALTY_KIND_LABELS,
  describeSpecialtyMix,
  type SpecialtyMix,
} from "@/lib/business-review/specialty-mix";
import { formatVisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { columnPercents } from "@/lib/business-review/table-columns";
import { periodColumnLabel } from "@/lib/business-review/period-format";
import type { ReviewPersonRow } from "@/lib/business-review/sources/roles";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { cn } from "@/lib/utils";

/**
 * WHERE THIS DISTRICT'S MONEY CAME FROM — the owner's three questions, 2026-09-26: "is he selling
 * from all his bricks or almost of them or only one", "is the bulk of it one customer", "is his
 * sales from distributors or from wholesalers or direct".
 *
 * Renders NOTHING when the facts were not loaded. Null is not zero: the customer-grain read is a
 * separate round trip, and a panel of zeros would tell a district manager he sold through no bricks
 * at all. Where the read HAPPENED and returned nothing, the panel says so in words.
 *
 * Fits the screen by construction — `table-fixed` with a percentage colgroup beside a card list, so
 * it cannot scroll sideways in the admin shell (which grants `overflow-x: auto` to any element with
 * a direct `<table>` child whatever its classes say).
 */

const egp = (n: number) =>
  stableCurrencyFormatter("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(
    Number.isFinite(n) ? n : 0,
  );

const CHANNEL_LABEL: Record<SalesChannel, string> = {
  direct: "Direct orders",
  distributor: "Through distributors",
  wholesaler: "Through wholesalers",
};

const CHANNEL_HINT: Record<SalesChannel, string> = {
  direct: "Placed on the direct-order book and booked by Finance.",
  distributor: "A distributor's sheet, to a pharmacy, hospital or account.",
  wholesaler: "A distributor's sheet, to a warehouse that sells it on.",
};

const TH = "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const THR = "px-3 py-2 text-right text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const TD = "px-3 py-2 align-top text-sm";
const TDR = "px-3 py-2 text-right text-sm tabular-nums";

function Panel({ children, note, title }: { children: React.ReactNode; note?: string; title: string }) {
  return (
    <div className="border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h3 className="min-w-0 break-words text-sm font-bold">{title}</h3>
        {note && <span className="min-w-0 break-words text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="p-1">{children}</div>
    </div>
  );
}

function Spread({
  facts,
  noun,
  title,
}: {
  facts: ConcentrationFacts["bricks"];
  noun: string;
  title: string;
}) {
  return (
    <Panel note={describeSpread(facts, noun)} title={title}>
      <PortalResponsiveDataList
        empty={<p className="px-3 py-4 text-sm text-muted-foreground">No {noun} carried sales in this window.</p>}
        getKey={(row) => row.key}
        items={facts.top}
        renderCard={(row) => (
          <div className="flex items-start justify-between gap-3 px-4 py-3">
            <span className="min-w-0 break-words text-sm font-semibold">{row.label}</span>
            <span className="shrink-0 text-right text-sm tabular-nums">
              {egp(row.value)}
              <span className="block text-phx-xs text-muted-foreground">{row.share.toFixed(1)}%</span>
            </span>
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[52%]" />
                <col className="w-[30%]" />
                <col className="w-[18%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>{noun === "brick" ? "Brick" : "Customer"}</th>
                <th className={THR}>Sales</th>
                <th className={THR}>Share</th>
              </tr>
            </thead>
            <tbody>
              {facts.top.map((row) => (
                <tr className="border-b border-border/60 last:border-0" key={row.key}>
                  <td className={cn(TD, "break-words font-semibold")}>{row.label}</td>
                  <td className={TDR}>{egp(row.value)}</td>
                  <td className={TDR}>{row.share.toFixed(1)}%</td>
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
 * WHAT THE LIST IS MADE OF — the owner's "how many specialties per the district manager list".
 *
 * States the doctor share and passes NO verdict: there is no right proportion, and a rep on a
 * pharmacy-heavy brick may be covering it correctly. An unclassified value is shown VERBATIM
 * rather than folded into either bucket — folding is how "Contract" and "Health Insurance" came to
 * be scored as doctors, costing a fifth of the panel.
 */
export function SpecialtyMixPanel({ mix, scopeNote }: { mix: SpecialtyMix; scopeNote: string }) {
  if (mix.customersTotal === 0 && mix.visitsTotal === 0) return null;
  return (
    <Panel note={describeSpecialtyMix(mix)} title={`What the list is made of — ${scopeNote}`}>
      <PortalResponsiveDataList
        empty={<p className="px-3 py-4 text-sm text-muted-foreground">No customers were visited in this window.</p>}
        getKey={(row) => row.speciality}
        items={mix.specialities}
        renderCard={(row) => (
          <div className="flex items-start justify-between gap-3 px-4 py-3">
            <span className="min-w-0 break-words text-sm font-semibold">
              {row.label}
              <span className="mt-0.5 block text-phx-xs font-normal text-muted-foreground">
                {SPECIALTY_KIND_LABELS[row.kind]}
              </span>
            </span>
            <span className="shrink-0 text-right text-sm tabular-nums">
              {row.customers.toLocaleString("en-US")}
              <span className="block text-phx-xs text-muted-foreground">
                {row.visits.toLocaleString("en-US")} visits
              </span>
            </span>
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[40%]" />
                <col className="w-[30%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Speciality</th>
                <th className={TH}>Counts as</th>
                <th className={THR}>Customers</th>
                <th className={THR}>Visits</th>
              </tr>
            </thead>
            <tbody>
              {mix.specialities.map((row) => (
                <tr className="border-b border-border/60 last:border-0" key={row.speciality}>
                  <td className={cn(TD, "break-words font-semibold")}>{row.label}</td>
                  <td className={cn(TD, "break-words text-muted-foreground")}>{SPECIALTY_KIND_LABELS[row.kind]}</td>
                  <td className={TDR}>{row.customers.toLocaleString("en-US")}</td>
                  <td className={TDR}>{row.visits.toLocaleString("en-US")}</td>
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
 * UNIQUE CUSTOMERS PER PERSON, PER MONTH — the owner's "in July this person got 200 unique
 * customers, in August 250" (2026-09-26).
 *
 * 🔴 THE MONTHS DO NOT ADD UP TO THE TOTAL, AND THAT IS CORRECT. Each cell is a union within its
 * own month; the same doctor seen in July and again in August is one customer in each cell and ONE
 * customer in the window. The Window column is the window's own union, so it is normally smaller
 * than the months summed — the note says so, because a reader who adds the row across and gets a
 * different number will otherwise assume one of them is wrong.
 */
export function CustomersPerMonthTable({
  months,
  people,
  scopeNote,
}: {
  months: string[];
  people: ReviewPersonRow[];
  scopeNote: string;
}) {
  const shown = people.filter((p) => p.customers > 0);
  if (shown.length === 0 || months.length === 0) return null;

  const widths = columnPercents([34, 14], months.length);
  const num = (value: number) => value.toLocaleString("en-US");

  return (
    <Panel
      note="each month is its own union — a doctor seen twice is one customer in each, so the months do not sum to the window"
      title={`Unique customers per month — ${scopeNote}`}
    >
      <PortalResponsiveDataList
        breakpoint="lg"
        empty={<p className="px-3 py-4 text-sm text-muted-foreground">Nobody reached a customer in this window.</p>}
        getKey={(person) => person.hrId}
        items={shown}
        renderCard={(person) => (
          <div className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-words text-sm font-semibold">
                {person.name}
                <span className="mt-0.5 block text-phx-xs font-normal text-muted-foreground">
                  {person.jobTitle || person.role}
                </span>
              </span>
              <span className="shrink-0 text-right text-sm font-bold tabular-nums">
                {num(person.customers)}
                <span className="block text-phx-xs font-normal text-muted-foreground">in the window</span>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {months.map((month) => (
                <span className="min-w-0 text-phx-xs" key={month}>
                  <span className="text-muted-foreground">{periodColumnLabel(month, months)}</span>{" "}
                  <span className="tabular-nums">{num(person.customersByMonth[month] ?? 0)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            breakpoint="lg"
            cols={
              <colgroup>
                {widths.map((width, i) => (
                  <col key={i} style={{ width: `${width}%` }} />
                ))}
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Person</th>
                <th className={THR}>Window</th>
                {months.map((month) => (
                  <th className={THR} key={month}>
                    {periodColumnLabel(month, months)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((person) => (
                <tr className="border-b border-border/60 last:border-0" key={person.hrId}>
                  <td className={cn(TD, "break-words font-semibold")}>
                    {person.name}
                    <span className="mt-0.5 block text-phx-xs font-normal text-muted-foreground">
                      {person.jobTitle || person.role}
                    </span>
                  </td>
                  <td className={cn(TDR, "font-bold")}>{num(person.customers)}</td>
                  {months.map((month) => (
                    <td className={TDR} key={month}>
                      {num(person.customersByMonth[month] ?? 0)}
                    </td>
                  ))}
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
 * EACH REP BESIDE THE TERRITORY HE STANDS IN.
 *
 * 🔴 THE ACHIEVEMENT IS THE AREA'S, NOT THE PERSON'S, and the column says so in those words.
 * An area can carry more than one rep — `AreaSummary.reps` is a count and is routinely above one
 * — so the same percentage appears against each of them. Labelling it "achievement" beside a
 * person's name would read as a personal score, and a manager acting on a personal score that is
 * really a shared territory figure is the one outcome this table must not produce. Targets are set
 * per AREA, never per rep: there is no per-rep achievement in this system to show instead.
 *
 * Only people the month's own attribution placed in an area, who did field work. Somebody with no
 * area has nothing to sit beside, and somebody with no visits has nothing to report.
 */
export function RepRowsTable({
  areas,
  people,
  scopeNote,
  visitsAvailable,
}: {
  areas: { areaCode: string | null; area: string; dm: string; allProducts: { ach: number | null } }[];
  people: ReviewPersonRow[];
  scopeNote: string;
  visitsAvailable: boolean;
}) {
  const areaByCode = new Map(areas.filter((a) => a.areaCode).map((a) => [a.areaCode as string, a]));
  const rows = people
    .filter((p) => p.areaCode != null && p.fieldVisits > 0)
    .map((p) => ({ area: areaByCode.get(p.areaCode as string) ?? null, person: p }))
    .sort((a, b) => b.person.fieldVisits - a.person.fieldVisits);
  if (rows.length === 0) return null;

  const num = (value: number) => value.toLocaleString("en-US");
  const ach = (value: number | null) =>
    value == null ? <span className="text-muted-foreground">not gradeable</span> : `${value.toFixed(1)}%`;

  return (
    <Panel
      note="the percentage is the AREA's, shared by everyone standing in it — targets are set per area, never per rep"
      title={`Rep by rep — ${scopeNote}`}
    >
      <PortalResponsiveDataList
        breakpoint="lg"
        empty={<p className="px-3 py-4 text-sm text-muted-foreground">Nobody did field work in this window.</p>}
        getKey={(row) => row.person.hrId}
        items={rows}
        renderCard={({ area, person }) => (
          <div className="px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 break-words text-sm font-semibold">
                {person.name}
                <span className="mt-0.5 block text-phx-xs font-normal text-muted-foreground">
                  {person.jobTitle || person.role}
                </span>
              </span>
              <span className="shrink-0 text-right text-sm font-bold tabular-nums">
                {ach(area?.allProducts.ach ?? null)}
                <span className="block text-phx-xs font-normal text-muted-foreground">his area</span>
              </span>
            </div>
            <p className="mt-1 break-words text-phx-xs text-muted-foreground">
              {area?.area ?? "Area not resolved"}
              {area?.dm ? ` · ${area.dm}` : ""}
            </p>
            <p className="mt-1 text-phx-xs text-muted-foreground">
              {visitsAvailable
                ? `${num(person.fieldVisits)} visits · ${person.avgPerActiveMonth.toFixed(1)} a month · ${num(person.customers)} customers`
                : "no CRM rows in this window"}
            </p>
            {visitsAvailable && (
              <p className="mt-0.5 text-phx-xs text-muted-foreground">{formatVisitCountSplit(person.visitSplit)}</p>
            )}
          </div>
        )}
        renderTable={() => (
          <PortalDesktopTable
            breakpoint="lg"
            cols={
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[22%]" />
                <col className="w-[14%]" />
                <col className="w-[14%]" />
                <col className="w-[26%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>Rep</th>
                <th className={TH}>Area he stands in</th>
                <th className={THR}>Area achievement</th>
                <th className={THR}>Visits</th>
                <th className={THR}>AM · PM · Pharmacies</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ area, person }) => (
                <tr className="border-b border-border/60 last:border-0" key={person.hrId}>
                  <td className={cn(TD, "break-words font-semibold")}>
                    {person.name}
                    <span className="mt-0.5 block text-phx-xs font-normal text-muted-foreground">
                      {person.jobTitle || person.role}
                    </span>
                  </td>
                  <td className={cn(TD, "break-words")}>
                    {area?.area ?? "Area not resolved"}
                    {area?.dm ? (
                      <span className="mt-0.5 block text-phx-xs text-muted-foreground">{area.dm}</span>
                    ) : null}
                  </td>
                  <td className={cn(TDR, "font-semibold")}>{ach(area?.allProducts.ach ?? null)}</td>
                  <td className={TDR}>
                    {visitsAvailable ? num(person.fieldVisits) : "no data"}
                    {visitsAvailable && (
                      <span className="block text-phx-xs text-muted-foreground">
                        {person.avgPerActiveMonth.toFixed(1)} a month
                      </span>
                    )}
                  </td>
                  <td className={cn(TDR, "break-words")}>
                    {visitsAvailable ? formatVisitCountSplit(person.visitSplit) : "no data"}
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </Panel>
  );
}

export function ConcentrationPanels({
  facts,
  scopeNote,
}: {
  /** Null when the customer-grain read was not performed — the panels then render nothing. */
  facts: ConcentrationFacts | null;
  scopeNote: string;
}) {
  if (!facts) return null;

  const channelRows = SALES_CHANNELS.map((channel) => ({
    channel,
    share: facts.totalValue > 0 ? (facts.channels[channel] / facts.totalValue) * 100 : null,
    value: facts.channels[channel],
  }));

  return (
    <section className="space-y-4">
      <Spread facts={facts.bricks} noun="brick" title={`Bricks — ${scopeNote}`} />
      <Spread facts={facts.customers} noun="customer" title={`Customers — ${scopeNote}`} />
      <Panel note="the three add up to the window's whole sales value" title={`How it reached the market — ${scopeNote}`}>
        <PortalResponsiveDataList
          empty={<p className="px-3 py-4 text-sm text-muted-foreground">No sales in this window.</p>}
          getKey={(row) => row.channel}
          items={channelRows}
          renderCard={(row) => (
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words text-sm font-semibold">{CHANNEL_LABEL[row.channel]}</span>
                <span className="shrink-0 text-right text-sm tabular-nums">
                  {egp(row.value)}
                  <span className="block text-phx-xs text-muted-foreground">
                    {row.share == null ? "—" : `${row.share.toFixed(1)}%`}
                  </span>
                </span>
              </div>
              <p className="mt-1 break-words text-phx-xs text-muted-foreground">{CHANNEL_HINT[row.channel]}</p>
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[28%]" />
                  <col className="w-[38%]" />
                  <col className="w-[20%]" />
                  <col className="w-[14%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Channel</th>
                  <th className={TH}>What it means</th>
                  <th className={THR}>Sales</th>
                  <th className={THR}>Share</th>
                </tr>
              </thead>
              <tbody>
                {channelRows.map((row) => (
                  <tr className="border-b border-border/60 last:border-0" key={row.channel}>
                    <td className={cn(TD, "break-words font-semibold")}>{CHANNEL_LABEL[row.channel]}</td>
                    <td className={cn(TD, "break-words text-muted-foreground")}>{CHANNEL_HINT[row.channel]}</td>
                    <td className={TDR}>{egp(row.value)}</td>
                    <td className={TDR}>{row.share == null ? "—" : `${row.share.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </Panel>
    </section>
  );
}
