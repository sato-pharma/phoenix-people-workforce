"use client";

import { useMemo, useState } from "react";

import {
  PortalDesktopTable,
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
import type {
  MyCrmCheckinRow,
  MyCrmDoubleVisitRow,
  MyCrmVisitRow,
  TeamCrmVisitRow,
} from "@/lib/employee-portal/my-crm-visits";
import type { VisitTimeSource } from "@/lib/crm/reads";

const PAGE_SIZE = 25;

type TabId = "visits" | "double" | "checkins" | "team";

// "team" is appended last and only rendered for a viewer who actually has a team (see the filter on
// TABS below), so a Medical Rep's tab strip is unchanged.
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "visits", label: "My Visits" },
  { id: "double", label: "Double Visits" },
  { id: "checkins", label: "Check-ins" },
  { id: "team", label: "Team Visits" },
];

function formatDateOnly(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
}

/** Vendor timestamps are stored as Cairo wall-clock but tagged UTC (iReports360 sends
 * zone-less local times) — render with NO timezone shift, mirroring the admin CRM
 * table's formatVendorLocal (src/components/crm/crm-master-table.tsx). */
function formatVendorLocal(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
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
function VisitTimeBadge({ source, value }: { source: VisitTimeSource; value: string | null }) {
  if (!value) return <span className="text-slate-400">—</span>;
  const isGps = source === "gps_checkin";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span title={formatVendorLocal(value)}>{formatVendorTimeOnly(value)}</span>
      <span
        className={`rounded px-1 py-0.5 text-phx-3xs font-bold uppercase tracking-wide ${
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
      status={<VisitTimeBadge source={row.visitTimeSource} value={row.visitTime} />}
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
      status={<VisitTimeBadge source={row.visitTimeSource} value={row.visitTime} />}
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

function DoubleVisitCard({ row }: { row: MyCrmDoubleVisitRow }) {
  return (
    <PortalRecordCard
      accent="sky"
      meta={<span>{formatDateOnly(row.visitDate)}{row.ampm ? ` · ${row.ampm}` : ""}</span>}
      status={<span className="text-xs font-bold text-slate-600">{formatVendorLocal(row.visitTime)}</span>}
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
        className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
        disabled={safePage <= 1}
        onClick={onPrevious}
        type="button"
      >
        Previous
      </button>
      <button
        className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
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

  const visitsPage = usePagedRows(visits, page);
  const doublePage = usePagedRows(doubleVisits, page);
  const checkinsPage = usePagedRows(checkins, page);
  const teamPage = usePagedRows(teamVisits, page);
  const rangeLabel = `${formatDateOnly(dateFrom)} – ${formatDateOnly(dateTo)}`;

  return (
    <PortalSection description={`Showing ${rangeLabel}`} eyebrow="CRM Visits" title="My Visits">
      <div className="space-y-4 p-4 sm:p-5">
        <PortalSegmentedTabs>
          {tabs.map((item) => {
            const count =
              item.id === "visits"
                ? visits.length
                : item.id === "double"
                  ? doubleVisits.length
                  : item.id === "team"
                    ? teamVisits.length
                    : checkins.length;
            return (
              <button
                className={`flex-1 whitespace-nowrap rounded px-3 py-2 text-xs font-black uppercase tracking-wide transition ${
                  tab === item.id ? "bg-orange-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"
                }`}
                key={item.id}
                onClick={() => selectTab(item.id)}
                type="button"
              >
                {item.label} ({count})
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
              empty={<PortalEmptyState message="No visits recorded by your team in this window." title="No team visits yet" />}
              getKey={(row) => row.id}
              items={teamPage.paged}
              renderCard={(row) => <TeamVisitCard row={row} />}
              renderTable={() => (
                <PortalDesktopTable minWidth="1040px">
                  <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Rep</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Contact</th>
                      {/* No Customer column - customerName is empty on every visit (see master.ts). */}
                      <th className="px-4 py-3">With</th>
                      <th className="px-4 py-3">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {teamPage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className="px-4 py-3 font-black text-slate-950">{row.agentName || "—"}</td>
                        <td className="px-4 py-3 font-bold text-slate-800">
                          {formatDateOnly(row.visitDate)}
                          {row.ampm ? ` (${row.ampm})` : ""}
                        </td>
                        <td className="px-4 py-3">
                          <VisitTimeBadge source={row.visitTimeSource} value={row.visitTime} />
                        </td>
                        <td className="px-4 py-3 text-slate-700">{row.visitTypeDescription || "—"}</td>
                        <td className="px-4 py-3 text-slate-700">{row.contactName || "—"}</td>
                        <td className="px-4 py-3 text-slate-700">{row.doubleName || "—"}</td>
                        <td className="max-w-[280px] px-4 py-3 leading-5 text-slate-600">{row.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
            <TabPager
              label={teamPage.label}
              onNext={() => setPage((current) => Math.min(teamPage.totalPages, current + 1))}
              onPrevious={() => setPage((current) => Math.max(1, current - 1))}
              safePage={teamPage.safePage}
              totalPages={teamPage.totalPages}
            />
          </>
        ) : null}

        {tab === "visits" ? (
          <>
            <PortalResponsiveDataList
              empty={<PortalEmptyState message="No visits recorded by you in this window." title="No visits yet" />}
              getKey={(row) => row.id}
              items={visitsPage.paged}
              renderCard={(row) => <VisitCard row={row} />}
              renderTable={() => (
                <PortalDesktopTable minWidth="980px">
                  <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Contact</th>
                      {/* No Customer column - customerName is empty on every visit (see master.ts). */}
                      <th className="px-4 py-3">With</th>
                      <th className="px-4 py-3">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {visitsPage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className="px-4 py-3 font-bold text-slate-800">
                          {formatDateOnly(row.visitDate)}
                          {row.ampm ? ` (${row.ampm})` : ""}
                        </td>
                        <td className="px-4 py-3">
                          <VisitTimeBadge source={row.visitTimeSource} value={row.visitTime} />
                        </td>
                        <td className="px-4 py-3 text-slate-700">{row.visitTypeDescription || "—"}</td>
                        <td className="px-4 py-3 font-black text-slate-950">{row.contactName || "—"}</td>
                        <td className="px-4 py-3 text-slate-700">{row.doubleName || "—"}</td>
                        <td className="max-w-[280px] px-4 py-3 leading-5 text-slate-600">{row.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
            <TabPager
              label={visitsPage.label}
              onNext={() => setPage((current) => Math.min(visitsPage.totalPages, current + 1))}
              onPrevious={() => setPage((current) => Math.max(1, current - 1))}
              safePage={visitsPage.safePage}
              totalPages={visitsPage.totalPages}
            />
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
                <PortalDesktopTable minWidth="980px">
                  <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">Primary rep</th>
                      <th className="px-4 py-3">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {doublePage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className="px-4 py-3 font-bold text-slate-800">
                          {formatDateOnly(row.visitDate)}
                          {row.ampm ? ` (${row.ampm})` : ""}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{formatVendorLocal(row.visitTime)}</td>
                        <td className="px-4 py-3 text-slate-700">{row.visitTypeDescription || "—"}</td>
                        <td className="px-4 py-3 font-black text-slate-950">{row.contactName || row.customerName || "—"}</td>
                        <td className="px-4 py-3 text-slate-700">{row.primaryAgentName || "—"}</td>
                        <td className="max-w-[280px] px-4 py-3 leading-5 text-slate-600">{row.comment || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
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
                <PortalDesktopTable minWidth="720px">
                  <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Date &amp; time</th>
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">Address</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {checkinsPage.paged.map((row) => (
                      <tr className="align-top" key={row.id}>
                        <td className="px-4 py-3 font-bold text-slate-800">{formatVendorLocal(row.checkDate)}</td>
                        <td className="px-4 py-3 font-black text-slate-950">{row.contactName || "—"}</td>
                        <td className="max-w-[360px] px-4 py-3 leading-5 text-slate-600">{row.address || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
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
