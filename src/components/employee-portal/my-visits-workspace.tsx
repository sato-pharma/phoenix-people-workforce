"use client";

import { useMemo, useState } from "react";

import {
  PortalEmptyState,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
  PortalSegmentedTabs,
} from "@/components/employee-portal/portal-primitives";
// Value import MUST come from the client-safe constants module: my-crm-visits.ts is server-only
// (it reaches node:crypto through the employee directory) and importing a value from it here
// breaks the webpack dev build for this route and every route compiled after it.
import { TEAM_VISIT_ROW_CAP } from "@/lib/employee-portal/my-crm-visits-constants";
import { myOffDutyReason, partitionMyVisitRows } from "@/lib/employee-portal/my-visits-partition";
import { utcDate } from "@/lib/format/cairo-datetime";
import type {
  MyCrmCheckinRow,
  MyCrmDoubleVisitRow,
  MyCrmVisitRow,
  TeamCrmVisitRow,
} from "@/lib/employee-portal/my-crm-visits";
import type { VisitTimeSource } from "@/lib/crm/reads";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

const PAGE_SIZE = 25;

type TabId = "visits" | "double" | "checkins" | "team";

// "team" is appended last and only rendered for a viewer who actually has a team (see the filter on
// TABS below), so a Medical Rep's tab strip is unchanged.
//
// Sentence case, and the count sits UNDER the label rather than in brackets beside it: three
// uppercase "LABEL (n)" tabs needed about 400px and a phone gives the strip 285–355px, so the
// Check-ins tab used to sit off the right edge behind a hidden scrollbar.
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "visits", label: "My visits" },
  { id: "double", label: "Double visits" },
  { id: "checkins", label: "Check-ins" },
  { id: "team", label: "Team visits" },
];

/**
 * THE DESKTOP TABLES FIT; THEY NEVER SCROLL SIDEWAYS (the owner's fits-the-screen golden rule).
 *
 * They used to sit in PortalDesktopTable, whose wrapper is `overflow-x-auto` over a 720–1040px
 * `min-width` — the exact shape AGENTS.md §4 names as the bug. Measured on the audit: 286px of
 * sideways scroll at 768px, 386px at 1024px with the sidebar open. Each table is now
 * `w-full table-fixed` over a percentage `<colgroup>`, fitted by MERGING columns: the day carries its
 * AM/PM and the time chip, the contact carries the visit type under the name. Every cell wraps
 * (`break-words`); nothing is `whitespace-nowrap` and nothing is cut with an ellipsis.
 *
 * `hidden … md:table` plus `data-portal-desktop-table` keeps each one desktop-only — below 768px a
 * phone gets the cards. Pinned by tests/my-visits-tables-fit.test.ts.
 */
const TABLE = "hidden w-full table-fixed border-collapse text-left text-sm md:table";
const TD = "break-words px-3 py-3 align-top";

// DATE-ONLY (`ireports360_visits.visit_date` and the window bounds — a `date` column, unlike the vendor
// timestamptz handled by formatVendorLocal below), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
//
// The zone was never the bug here; the LOCALE was. `en-GB` + `month: "short"` is the one field
// CLDR 42 changed ("Sep" -> "Sept"), so this rendered differently on Railway's Node 24 and on an
// older mobile browser, and React discarded the server HTML over the one-character difference —
// hydration error #418, live on /employee-portals/visits until 2026-09-08. `utcDate` keeps the UTC
// pin and the exact output, taking the month from a table that ships with the code rather than
// from whichever ICU build the reader happens to be holding.
function formatDateOnly(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return utcDate(date.toISOString());
}

/** Vendor timestamps are stored as Cairo wall-clock but tagged UTC (iReports360 sends
 * zone-less local times) — render with NO timezone shift, mirroring the admin CRM
 * table's formatVendorLocal (src/components/crm/crm-master-table.tsx). */
function formatVendorLocal(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Date half via the shared table (see formatDateOnly). The time half stays inline: `en-US` with
  // hour12 renders digits and a plain-space "PM" identically on every ICU version in play here.
  const datePart = utcDate(date.toISOString());
  const timePart = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "UTC" }).format(date);
  return `${datePart}, ${timePart}`;
}

function formatVendorTimeOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "UTC" }).format(date);
}

/** The GPS/Logged visit-time badge — ported from the admin CRM master table's
 * VisitTimeCell rather than imported, so this portal module stays structurally
 * independent of the admin surface. */
function VisitTimeBadge({ source, value, phoenix }: { source: VisitTimeSource; value: string | null; phoenix?: boolean }) {
  if (!value) return <span className="text-slate-400">—</span>;
  // A started Phoenix CRM team's own visit: its time alone, never "GPS" or "Logged — not GPS-verified".
  // This page reaches the rep, and he is never told his location is read (Phoenix CRM golden rule #1).
  if (phoenix) return <span title={formatVendorLocal(value)}>{formatVendorTimeOnly(value)}</span>;
  const isGps = source === "gps_checkin";
  return (
    // flex-wrap: in a narrow Day column the chip drops under the time instead of pushing the cell.
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span title={formatVendorLocal(value)}>{formatVendorTimeOnly(value)}</span>
      <span
        className={`rounded px-1 py-0.5 text-phx-xs font-bold uppercase tracking-wide ${
          isGps ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
        }`}
        title={isGps ? "Real GPS check-in time (on site)" : "Logged/save time — not GPS-verified; may be logged later"}
      >
        {isGps ? "GPS" : "Logged"}
      </span>
    </span>
  );
}

function VisitCard({ row }: { row: MyCrmVisitRow }) {
  return (
    <PortalRecordCard
      accent="orange"
      meta={<span>{formatDateOnly(row.visitDate)}{row.ampm ? ` · ${row.ampm}` : ""}</span>}
      status={<VisitTimeBadge phoenix={row.phoenixVisit} source={row.visitTimeSource} value={row.visitTime} />}
      title={row.contactName || row.customerName || row.visitTypeDescription || "Visit"}
    >
      <PortalRecordFields
        fields={[
          { label: "Type", value: row.visitTypeDescription || "—" },
          // No "Customer" field: the vendor's customerName is empty on every visit ever synced
          // (see master.ts). The card title above already falls back to it if that changes.
          { label: "With", value: row.doubleName || "—" },
        ]}
      />
      {row.comment ? (
        <p className="mt-2 rounded border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
          {row.comment}
        </p>
      ) : null}
    </PortalRecordCard>
  );
}

/** A subordinate's visit. Same shape as VisitCard, but the rep's name leads — on a manager's list the
 *  first question is always "whose visit is this?", which never arises on the self tabs. */
function TeamVisitCard({ row }: { row: TeamCrmVisitRow }) {
  return (
    <PortalRecordCard
      accent="emerald"
      meta={<span>{formatDateOnly(row.visitDate)}{row.ampm ? ` · ${row.ampm}` : ""}</span>}
      status={<VisitTimeBadge phoenix={row.phoenixVisit} source={row.visitTimeSource} value={row.visitTime} />}
      title={row.agentName || "Unnamed rep"}
    >
      <PortalRecordFields
        fields={[
          { label: "Contact", value: row.contactName || row.customerName || "—" },
          { label: "Type", value: row.visitTypeDescription || "—" },
          { label: "With", value: row.doubleName || "—" },
        ]}
      />
      {row.comment ? (
        <p className="mt-2 rounded border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
          {row.comment}
        </p>
      ) : null}
    </PortalRecordCard>
  );
}

/**
 * A double visit's time is ALWAYS the save time: fetchMyDoubleVisits (my-crm-visits.ts) resolves it
 * with no check-in on purpose — matching one would mean reading the PRIMARY rep's check-ins, which are
 * outside this viewer's own scope. So it carries the same chip as every other visit, and the chip
 * always says "Logged", never GPS. It used to print the date a second time instead, with no chip.
 */
const DOUBLE_VISIT_TIME_SOURCE: VisitTimeSource = "save_time";

function DoubleVisitCard({ row }: { row: MyCrmDoubleVisitRow }) {
  return (
    <PortalRecordCard
      accent="sky"
      meta={<span>{formatDateOnly(row.visitDate)}{row.ampm ? ` · ${row.ampm}` : ""}</span>}
      status={<VisitTimeBadge phoenix={row.phoenixVisit} source={DOUBLE_VISIT_TIME_SOURCE} value={row.visitTime} />}
      title={row.contactName || row.customerName || row.visitTypeDescription || "Visit"}
    >
      <PortalRecordFields
        fields={[
          { label: "Type", value: row.visitTypeDescription || "—" },
          { label: "Primary rep", value: row.primaryAgentName || "—" },
        ]}
      />
      {row.comment ? (
        <p className="mt-2 rounded border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
          {row.comment}
        </p>
      ) : null}
    </PortalRecordCard>
  );
}

function CheckinCard({ row }: { row: MyCrmCheckinRow }) {
  return (
    <PortalRecordCard accent="slate" meta={<span>{formatVendorLocal(row.checkDate)}</span>} title={row.contactName || "Check-in"}>
      {row.address ? <p className="text-xs font-semibold leading-5 text-slate-600">{row.address}</p> : null}
    </PortalRecordCard>
  );
}

const OFF_DUTY_TH = "px-3 py-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-white";

/**
 * Leave, public holidays, meetings and training — listed under their own heading, never counted as
 * visits. Same heading, wording and layout as the KPI drill-down's group (rep-visits-detail.tsx), so
 * a rep reads one rule on both screens. Shown rather than dropped: "where was I on the 27th" is a
 * real question. Fitted table, square edges, text wraps — never a sideways scroll.
 */
function DaysNotInFieldGroup({ rows, showRep }: { rows: Array<MyCrmVisitRow & { agentName?: string | null }>; showRep: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-slate-100 px-4 py-3">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-600">Days not in the field</h3>
        <p className="text-phx-xs text-slate-500">
          {rows.length.toLocaleString("en-US")} {rows.length === 1 ? "day" : "days"} · leave, public holidays, meetings and
          training · never counted as a visit
        </p>
      </div>
      <div className="p-4">
        <PortalResponsiveDataList
          empty={<p className="px-3 py-6 text-center text-xs text-slate-400">None in this window.</p>}
          getKey={(row) => row.id}
          items={rows}
          renderCard={(row) => (
            <PortalRecordCard
              accent="slate"
              meta={<span>{formatDateOnly(row.visitDate)}{row.ampm ? ` · ${row.ampm}` : ""}</span>}
              title={showRep ? row.agentName || "Unnamed rep" : row.visitTypeDescription || "Not in the field"}
            >
              <PortalRecordFields
                fields={[
                  ...(showRep ? [{ label: "Type", value: row.visitTypeDescription || "—" }] : []),
                  ...(myOffDutyReason(row) ? [{ label: "Reason", value: myOffDutyReason(row) }] : []),
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden md:block">
              <table className="w-full table-fixed border-collapse text-left text-xs" data-portal-desktop-table>
                <colgroup>
                  {showRep ? <col style={{ width: "20%" }} /> : null}
                  <col style={{ width: showRep ? "16%" : "18%" }} />
                  <col style={{ width: showRep ? "20%" : "26%" }} />
                  <col style={{ width: showRep ? "44%" : "56%" }} />
                </colgroup>
                <thead>
                  <tr className="bg-slate-600 text-left">
                    {showRep ? (
                      <th className={OFF_DUTY_TH} scope="col">
                        Rep
                      </th>
                    ) : null}
                    <th className={OFF_DUTY_TH} scope="col">
                      Date
                    </th>
                    <th className={OFF_DUTY_TH} scope="col">
                      Day
                    </th>
                    <th className={OFF_DUTY_TH} scope="col">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr className="bg-white align-top hover:bg-slate-50" key={row.id}>
                      {showRep ? (
                        <td className="break-words px-3 py-2 font-black text-slate-950">{row.agentName || "—"}</td>
                      ) : null}
                      <td className="break-words px-3 py-2 font-semibold text-slate-900">
                        {formatDateOnly(row.visitDate)}
                        {row.ampm ? ` (${row.ampm})` : ""}
                      </td>
                      <td className="break-words px-3 py-2 font-semibold text-slate-600">{row.visitTypeDescription || "—"}</td>
                      <td className="break-words px-3 py-2 text-slate-600">
                        {myOffDutyReason(row) ?? <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        />
      </div>
    </div>
  );
}

function usePagedRows<T>(rows: T[], page: number) {
  return useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const paged = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
    const label =
      rows.length === 0
        ? "0 rows"
        : `${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, rows.length)} of ${rows.length} rows`;
    return { label, paged, safePage, totalPages };
  }, [page, rows]);
}

function TabPager({
  label,
  onNext,
  onPrevious,
  safePage,
  totalPages,
}: {
  label: string;
  onNext: () => void;
  onPrevious: () => void;
  safePage: number;
  totalPages: number;
}) {
  return (
    <PortalPagination label={label}>
      <button
        className={`min-h-10 border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40 md:min-h-9 disabled:shadow-none ${adminControlDepthClassName}`}
        disabled={safePage <= 1}
        onClick={onPrevious}
        type="button"
      >
        Previous
      </button>
      <button
        className={`min-h-10 border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40 md:min-h-9 disabled:shadow-none ${adminControlDepthClassName}`}
        disabled={safePage >= totalPages}
        onClick={onNext}
        type="button"
      >
        Next
      </button>
    </PortalPagination>
  );
}

export function MyVisitsWorkspace({
  checkins,
  dateFrom,
  dateTo,
  doubleVisits,
  teamVisits = [],
  visits,
}: {
  checkins: MyCrmCheckinRow[];
  dateFrom: string;
  dateTo: string;
  doubleVisits: MyCrmDoubleVisitRow[];
  /** A manager's subordinates' visits. Empty (the default) for a viewer with no team — the tab is
   *  then not rendered at all, so non-managers see exactly the three tabs they saw before. */
  teamVisits?: TeamCrmVisitRow[];
  visits: MyCrmVisitRow[];
}) {
  const hasTeam = teamVisits.length > 0;
  const tabs = useMemo(() => TABS.filter((item) => item.id !== "team" || hasTeam), [hasTeam]);
  const [tab, setTab] = useState<TabId>("visits");
  const [page, setPage] = useState(1);

  function selectTab(next: TabId) {
    setTab(next);
    setPage(1);
  }

  // Calls apart from days not in the field — the tab count and the paged list are the calls only,
  // matching the KPI drill-down (owner, 2026-09-25). See my-visits-partition.ts.
  const visitSplit = useMemo(() => partitionMyVisitRows(visits), [visits]);
  const teamSplit = useMemo(() => partitionMyVisitRows(teamVisits), [teamVisits]);

  const visitsPage = usePagedRows(visitSplit.fieldRows, page);
  const doublePage = usePagedRows(doubleVisits, page);
  const checkinsPage = usePagedRows(checkins, page);
  const teamPage = usePagedRows(teamSplit.fieldRows, page);
  const rangeLabel = `${formatDateOnly(dateFrom)} – ${formatDateOnly(dateTo)}`;
  // The shell above already says "My Visits", so the section names the WINDOW instead of repeating
  // the page title. Derived from the two date-only bounds (both UTC midnight, so the difference is a
  // whole number of days), never hard-coded, so it cannot drift from the page's own window.
  const windowDays = Math.round((Date.parse(dateTo) - Date.parse(dateFrom)) / 86_400_000);
  const sectionTitle = Number.isFinite(windowDays) && windowDays > 0 ? `Last ${windowDays} days` : "Your visits";

  return (
    <PortalSection description={`Showing ${rangeLabel}`} eyebrow="CRM Visits" title={sectionTitle}>
      <div className="space-y-4 p-4 sm:p-5">
        {/* A GRID of equal cells, never a scrolling row: three tabs share one row even at 360px, each
            label wrapping over its own count, and a manager's fourth tab makes it two by two on a
            phone. Nothing here is whitespace-nowrap, so no tab can run off the edge. */}
        <PortalSegmentedTabs className={tabs.length === 4 ? "grid grid-cols-2 sm:grid-cols-4" : "grid grid-cols-3"}>
          {tabs.map((item) => {
            const count =
              item.id === "visits"
                ? visitSplit.fieldRows.length
                : item.id === "double"
                  ? doubleVisits.length
                  : item.id === "team"
                    ? teamSplit.fieldRows.length
                    : checkins.length;
            const active = tab === item.id;
            return (
              <button
                aria-pressed={active}
                className={`min-h-10 min-w-0 px-2 py-2 text-center transition ${
                  active ? "bg-orange-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"
                }`}
                key={item.id}
                onClick={() => selectTab(item.id)}
                type="button"
              >
                <span className="block break-words text-xs font-black leading-tight">{item.label}</span>
                <span className={`mt-0.5 block text-sm font-black tabular-nums ${active ? "text-white" : "text-slate-900"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </PortalSegmentedTabs>

        {tab === "team" ? (
          <>
            {teamVisits.length >= TEAM_VISIT_ROW_CAP ? (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                Showing the {TEAM_VISIT_ROW_CAP} most recent team visits in this window. Older ones are not listed —
                a silent cut here would read as &quot;my team stopped visiting&quot;.
              </p>
            ) : null}
            <PortalResponsiveDataList
              empty={<PortalEmptyState message="No field visits recorded by your team in this window." title="No team visits yet" />}
              getKey={(row) => row.id}
              items={teamPage.paged}
              renderCard={(row) => <TeamVisitCard row={row} />}
              renderTable={() => (
                <table className={TABLE} data-portal-desktop-table>
                  <colgroup>
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "17%" }} />
                    <col style={{ width: "25%" }} />
                    <col style={{ width: "15%" }} />
                    <col style={{ width: "25%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="px-3 py-3" scope="col">Rep</th>
                      <th className="px-3 py-3" scope="col">Day</th>
                      {/* No Customer column - customerName is empty on every visit (see master.ts). */}
                      <th className="px-3 py-3" scope="col">Contact</th>
                      <th className="px-3 py-3" scope="col">With</th>
                      <th className="px-3 py-3" scope="col">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {teamPage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className={`${TD} font-black text-slate-950`}>{row.agentName || "—"}</td>
                        <td className={TD}>
                          <span className="block font-bold text-slate-800">
                            {formatDateOnly(row.visitDate)}
                            {row.ampm ? ` · ${row.ampm}` : ""}
                          </span>
                          <span className="mt-1 block text-xs">
                            <VisitTimeBadge phoenix={row.phoenixVisit} source={row.visitTimeSource} value={row.visitTime} />
                          </span>
                        </td>
                        <td className={TD}>
                          <span className="block text-slate-800">{row.contactName || "—"}</span>
                          {row.visitTypeDescription ? (
                            <span className="mt-0.5 block text-xs font-semibold text-slate-500">{row.visitTypeDescription}</span>
                          ) : null}
                        </td>
                        <td className={`${TD} text-slate-700`}>{row.doubleName || "—"}</td>
                        <td className={`${TD} leading-5 text-slate-600`}>{row.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            />
            <TabPager
              label={teamPage.label}
              onNext={() => setPage((current) => Math.min(teamPage.totalPages, current + 1))}
              onPrevious={() => setPage((current) => Math.max(1, current - 1))}
              safePage={teamPage.safePage}
              totalPages={teamPage.totalPages}
            />
            <DaysNotInFieldGroup rows={teamSplit.offDutyRows} showRep />
          </>
        ) : null}

        {tab === "visits" ? (
          <>
            <PortalResponsiveDataList
              empty={<PortalEmptyState message="No field visits recorded by you in this window." title="No visits yet" />}
              getKey={(row) => row.id}
              items={visitsPage.paged}
              renderCard={(row) => <VisitCard row={row} />}
              renderTable={() => (
                <table className={TABLE} data-portal-desktop-table>
                  <colgroup>
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "32%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="px-3 py-3" scope="col">Day</th>
                      {/* No Customer column - customerName is empty on every visit (see master.ts). */}
                      <th className="px-3 py-3" scope="col">Contact</th>
                      <th className="px-3 py-3" scope="col">Double visit with</th>
                      <th className="px-3 py-3" scope="col">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {visitsPage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className={TD}>
                          <span className="block font-bold text-slate-800">
                            {formatDateOnly(row.visitDate)}
                            {row.ampm ? ` · ${row.ampm}` : ""}
                          </span>
                          <span className="mt-1 block text-xs">
                            <VisitTimeBadge phoenix={row.phoenixVisit} source={row.visitTimeSource} value={row.visitTime} />
                          </span>
                        </td>
                        <td className={TD}>
                          <span className="block font-black text-slate-950">{row.contactName || "—"}</span>
                          {row.visitTypeDescription ? (
                            <span className="mt-0.5 block text-xs font-semibold text-slate-500">{row.visitTypeDescription}</span>
                          ) : null}
                        </td>
                        <td className={`${TD} text-slate-700`}>{row.doubleName || "—"}</td>
                        <td className={`${TD} leading-5 text-slate-600`}>{row.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            />
            <TabPager
              label={visitsPage.label}
              onNext={() => setPage((current) => Math.min(visitsPage.totalPages, current + 1))}
              onPrevious={() => setPage((current) => Math.max(1, current - 1))}
              safePage={visitsPage.safePage}
              totalPages={visitsPage.totalPages}
            />
            <DaysNotInFieldGroup rows={visitSplit.offDutyRows} showRep={false} />
          </>
        ) : null}

        {tab === "double" ? (
          <>
            <PortalResponsiveDataList
              empty={
                <PortalEmptyState
                  message="No visits where you accompanied a colleague were recorded in this window."
                  title="No double visits yet"
                />
              }
              getKey={(row) => row.id}
              items={doublePage.paged}
              renderCard={(row) => <DoubleVisitCard row={row} />}
              renderTable={() => (
                <table className={TABLE} data-portal-desktop-table>
                  <colgroup>
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "32%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="px-3 py-3" scope="col">Day</th>
                      <th className="px-3 py-3" scope="col">Contact</th>
                      <th className="px-3 py-3" scope="col">Primary rep</th>
                      <th className="px-3 py-3" scope="col">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {doublePage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className={TD}>
                          <span className="block font-bold text-slate-800">
                            {formatDateOnly(row.visitDate)}
                            {row.ampm ? ` · ${row.ampm}` : ""}
                          </span>
                          <span className="mt-1 block text-xs">
                            <VisitTimeBadge phoenix={row.phoenixVisit} source={DOUBLE_VISIT_TIME_SOURCE} value={row.visitTime} />
                          </span>
                        </td>
                        <td className={TD}>
                          <span className="block font-black text-slate-950">{row.contactName || row.customerName || "—"}</span>
                          {row.visitTypeDescription ? (
                            <span className="mt-0.5 block text-xs font-semibold text-slate-500">{row.visitTypeDescription}</span>
                          ) : null}
                        </td>
                        <td className={`${TD} text-slate-700`}>{row.primaryAgentName || "—"}</td>
                        <td className={`${TD} leading-5 text-slate-600`}>{row.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            />
            <TabPager
              label={doublePage.label}
              onNext={() => setPage((current) => Math.min(doublePage.totalPages, current + 1))}
              onPrevious={() => setPage((current) => Math.max(1, current - 1))}
              safePage={doublePage.safePage}
              totalPages={doublePage.totalPages}
            />
          </>
        ) : null}

        {tab === "checkins" ? (
          <>
            <PortalResponsiveDataList
              empty={<PortalEmptyState message="No GPS check-ins recorded by you in this window." title="No check-ins yet" />}
              getKey={(row) => row.id}
              items={checkinsPage.paged}
              renderCard={(row) => <CheckinCard row={row} />}
              renderTable={() => (
                <table className={TABLE} data-portal-desktop-table>
                  <colgroup>
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "46%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="px-3 py-3" scope="col">Date &amp; time</th>
                      <th className="px-3 py-3" scope="col">Contact</th>
                      <th className="px-3 py-3" scope="col">Address</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {checkinsPage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className={`${TD} font-bold text-slate-800`}>{formatVendorLocal(row.checkDate)}</td>
                        <td className={`${TD} font-black text-slate-950`}>{row.contactName || "—"}</td>
                        <td className={`${TD} leading-5 text-slate-600`}>{row.address || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            />
            <TabPager
              label={checkinsPage.label}
              onNext={() => setPage((current) => Math.min(checkinsPage.totalPages, current + 1))}
              onPrevious={() => setPage((current) => Math.max(1, current - 1))}
              safePage={checkinsPage.safePage}
              totalPages={checkinsPage.totalPages}
            />
          </>
        ) : null}
      </div>
    </PortalSection>
  );
}
