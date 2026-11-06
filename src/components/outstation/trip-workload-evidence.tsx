"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { FieldWorkforceRouteMap } from "@/components/field-workforce-compliance/field-workforce-route-map";
import { Badge } from "@/components/ui/badge";
import {
  formatPharmacyFigure,
  pharmacyFigureText,
  pharmacyRecordingOf,
  pharmacyTileFigure,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { humanizeCode } from "@/lib/format/code-label";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { resolveWorkloadFreshness } from "@/lib/outstation/workload-freshness";
import { cn } from "@/lib/utils";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";

type WorkloadVisitDetail = {
  ampm: string | null;
  contact: string | null;
  customer: string | null;
  kind: string;
  /** On a partner visit, the rep who logged it — resigned or not (visit-workload.ts). Optional so a
   * payload from a server built before it still renders the bare "double". */
  repName?: string | null;
  role: string;
  submittedAt: string | null;
};

type WorkloadCheckinDetail = {
  address: string | null;
  at: string | null;
  contact: string | null;
  lat: number | null;
  lon: number | null;
  via: string | null;
};

type WorkloadEvidenceDay = {
  am: number;
  campaign: number;
  checkins: WorkloadCheckinDetail[];
  date: string;
  other: number;
  /** THE AM · PM · PHARMACIES GOLDEN RULE: never inside `am`/`pm`. Optional only so a payload from
   * a server built before the split still renders (it reads 0 there). */
  pharmacies?: number;
  /** Of the day's visits, how many are Phoenix CRM's own — it logs no pharmacy visit. */
  phoenix?: number;
  pm: number;
  regular: number;
  total: number;
  visits: WorkloadVisitDetail[];
};

/**
 * Live evidence as the golden-rule split (src/lib/crm/visit-count-buckets.ts): a trip or day logged in
 * Phoenix CRM, which records no pharmacy visit, reads "not recorded in Phoenix" — never 0. The declared
 * figure keeps its own wording ("not counted separately"); the freshness check reads the counts as before.
 */
function evidenceSplit(am: number, pm: number, pharmacies: number | undefined, phoenix: number | undefined): VisitCountSplit {
  return { am, pm, pharmacies: pharmacies ?? 0, ...(phoenix ? { phoenix } : {}) };
}

export type TripWorkloadEvidence = {
  amWorkload: number;
  campaignVisits: number;
  dateBreakdown: WorkloadEvidenceDay[];
  idleDates: string[];
  matchStatus: string;
  matchedDates: string[];
  otherVisits: number;
  pharmacyWorkload?: number;
  /** Of the trip's visits, how many are Phoenix CRM's own — display only, see evidenceSplit. */
  phoenixWorkload?: number;
  pmWorkload: number;
  regularVisits: number;
  sourceLabel: string;
};

// "unmapped" means the rep has no CRM identity mapping — no visit evidence exists either way,
// so it must read as a warning, never a neutral badge.
const statusTone: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  matched: "success",
  no_activity: "danger",
  partial: "warning",
  unmapped: "warning",
};

function fmt(value: number) {
  return formatNumberValue(Number.isFinite(value) ? value : 0);
}

// CRM timestamps are already Africa/Cairo — extract HH:MM from the raw string with NO tz shift.
function formatClock(value: string | null) {
  const match = /[T ](\d{2}:\d{2})/.exec(String(value ?? ""));
  return match ? match[1] : "—";
}

// Memoize the mapped check-ins so FieldWorkforceRouteMap gets a stable `checkins` reference. Passing
// a fresh array every render churned its map-creation effect and left the Google Map at its bare
// wrapper (blank tiles). `day.checkins` is stable workload state, so this settles the map.
function TripDayRouteMap({ checkins }: { checkins: WorkloadCheckinDetail[] }) {
  const mapped = useMemo(
    () =>
      checkins.map((checkin, index) => ({
        address: checkin.address,
        checkDate: checkin.at ?? "",
        contactName: checkin.via ? `${checkin.contact ?? "Check-in"} (via ${checkin.via})` : checkin.contact,
        id: index,
        lat: checkin.lat,
        lon: checkin.lon,
      })),
    [checkins],
  );
  return <FieldWorkforceRouteMap checkins={mapped} route={null} />;
}

/**
 * Actual field-visit workload for one trip, read from the admin/CRM mirror
 * (`/api/outstation/visit-workload`) — every field visit where the rep is the primary agent OR
 * the double-visit partner, regular AND campaign, with no departed-agent exclusion. Auto-loads
 * for the given rep + trip window so a focused decision panel needs no extra click.
 */
export function TripWorkloadEvidencePanel({
  declaredAm,
  declaredPharmacies = null,
  declaredPm,
  hrId,
  storedMatchedAt = null,
  storedMatchStatus = null,
  tripEndDate,
  tripStartDate,
}: {
  declaredAm: number;
  /** The stored third figure. NULL = not counted separately: a request stamped before the
   * 2026-09-21 split (its pharmacies sit inside AM/PM), a hand-typed workload, or an import. */
  declaredPharmacies?: number | null;
  declaredPm: number;
  hrId: string | null;
  /**
   * The verdict STAMPED on the request at submission, and when. Optional, so a caller with no
   * stored verdict (an imported expense) simply gets no staleness notice.
   *
   * This panel is the only place both sides exist at once: the stored verdict arrives as a prop,
   * the live read is fetched below. The request drawer prints the stored verdict as a plain fact
   * twenty lines above this panel, so when the two disagree it is this panel — the one holding
   * the evidence — that has to say so. Measurement: `@/lib/outstation/workload-freshness`.
   */
  storedMatchedAt?: string | null;
  storedMatchStatus?: string | null;
  tripEndDate: string;
  tripStartDate: string;
}) {
  const [state, setState] = useState<{
    status: "idle" | "loading" | "done" | "error";
    data?: TripWorkloadEvidence;
    error?: string;
    sessionExpired?: boolean;
  }>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      // Yield once so the reset/loading setState lands after an await, not synchronously in the
      // effect body (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;
      if (!hrId || !tripStartDate) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "loading" });
      try {
        const params = new URLSearchParams({
          employeeHrId: hrId,
          tripEndDate: tripEndDate || tripStartDate,
          tripStartDate,
        });
        const response = await fetch(`/api/outstation/visit-workload?${params.toString()}`, {
          headers: { accept: "application/json" },
        });
        const payload = await response.json();
        if (!response.ok || !payload?.success) {
          const error = new Error(payload?.message || `Request failed (${response.status})`);
          // Carried through so the UI can offer a sign-in instead of implying a permissions
          // problem — an expired session used to surface here as "you do not have access".
          (error as Error & { sessionExpired?: boolean }).sessionExpired =
            response.status === 401 || payload?.error === "session_expired";
          throw error;
        }
        if (!cancelled) setState({ data: payload.data as TripWorkloadEvidence, status: "done" });
      } catch (error) {
        if (!cancelled) {
          setState({
            error: error instanceof Error ? error.message : "Workload lookup failed.",
            sessionExpired: Boolean((error as { sessionExpired?: boolean })?.sessionExpired),
            status: "error",
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [hrId, tripStartDate, tripEndDate]);

  if (!hrId) {
    return (
      <p className="flex items-center gap-2 text-xs font-medium text-rose-600">
        <AlertTriangle className="h-4 w-4 shrink-0" /> This trip is not linked to an employee, so its visits can&apos;t be verified.
      </p>
    );
  }
  if (state.status === "loading" || state.status === "idle") {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading verified workload…
      </p>
    );
  }
  if (state.status === "error" || !state.data) {
    // An expired session is not a permissions problem, so it must not read like one — say what
    // actually happened and offer the one action that fixes it.
    if (state.sessionExpired) {
      return (
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Your session has expired, so the workload evidence could not be loaded.
          <a className="font-bold underline hover:text-amber-900" href="/login">
            Sign in again
          </a>
        </p>
      );
    }
    return <p className="text-xs font-medium text-rose-600">Couldn&apos;t load workload evidence: {state.error}</p>;
  }

  const data = state.data;
  const actualPharmacies = data.pharmacyWorkload ?? 0;
  // A Phoenix CRM day logs no pharmacy visit: "Not recorded", never 0, and a day with both systems
  // names its figure "(iReports360 only)" — the Actual line says why (visit-count-buckets.ts).
  const pharmacyCellText = (day: WorkloadEvidenceDay) => {
    const split = evidenceSplit(day.am, day.pm, day.pharmacies, day.phoenix);
    return pharmacyRecordingOf(split) === "not-recorded"
      ? pharmacyTileFigure(split).value
      : pharmacyFigureText(split, { formatNumber: fmt });
  };
  // Totals across all three figures: a pharmacy visit is field work (owner, 2026-09-21). A request
  // stamped before the split has NULL here with its pharmacies inside AM/PM, so its total still
  // compares like for like with the live AM + PM + Pharmacies.
  const declaredTotal = declaredAm + declaredPm + (declaredPharmacies ?? 0);
  const actualTotal = data.amWorkload + data.pmWorkload + actualPharmacies;
  const mismatch = declaredTotal !== actualTotal;
  const tone = statusTone[data.matchStatus] ?? "neutral";
  // Both sides are in hand here — the stamped verdict as a prop, the live read just fetched — so
  // this is where a stored "no activity" that the CRM has since contradicted gets named.
  const freshness = resolveWorkloadFreshness({
    liveAmWorkload: data.amWorkload,
    liveMatchStatus: data.matchStatus,
    livePharmacyWorkload: actualPharmacies,
    livePmWorkload: data.pmWorkload,
    storedAmWorkload: declaredAm,
    storedMatchedAt,
    storedMatchStatus,
    storedPharmacyWorkload: declaredPharmacies,
    storedPmWorkload: declaredPm,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Verified workload</span>
        <Badge variant={tone}>{humanizeCode(data.matchStatus)}</Badge>
        <span className="text-phx-xs text-slate-500">{data.sourceLabel}</span>
      </div>
      {freshness.verdict === "stale" && freshness.headline ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-amber-700">
              Stored verdict is out of date
            </p>
            <p className="mt-1 text-xs font-semibold leading-relaxed text-amber-900">{freshness.headline}</p>
          </div>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-phx-line bg-white p-3">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Declared (sheet)</p>
          <p className="mt-1 font-mono text-sm font-bold text-slate-900">
            AM {fmt(declaredAm)} · PM {fmt(declaredPm)} · Pharmacies{" "}
            {declaredPharmacies === null ? "not counted separately" : fmt(declaredPharmacies)}
          </p>
        </div>
        <div className={cn("rounded-xl border p-3", mismatch ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50")}>
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Actual (evidence)</p>
          <p className="mt-1 font-mono text-sm font-bold text-slate-900">
            AM {fmt(data.amWorkload)} · PM {fmt(data.pmWorkload)} ·{" "}
            {formatPharmacyFigure(evidenceSplit(data.amWorkload, data.pmWorkload, actualPharmacies, data.phoenixWorkload), { formatNumber: fmt })}
          </p>
          {mismatch ? (
            <p className="mt-0.5 text-phx-2xs font-bold text-rose-600">
              ≠ declared ({fmt(actualTotal)} actual vs {fmt(declaredTotal)} declared)
            </p>
          ) : null}
        </div>
        <div className="rounded-xl border border-phx-line bg-white p-3">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Visit type</p>
          <p className="mt-1 font-mono text-sm font-bold text-slate-900">
            Regular {fmt(data.regularVisits)} · Campaign {fmt(data.campaignVisits)}
          </p>
        </div>
      </div>
      {/* Seven columns with nowrap dates never fitted a phone. This used to be a bare
          `overflow-x-auto` — chosen over `overflow-hidden` because hidden CLIPPED the later
          columns with no way to reach them — but a sideways-scrolling table is not what the phone
          is supposed to get at all (AGENTS.md §4). The table is now desktop-only and the same days
          render as cards below `md`, so nothing scrolls sideways and nothing is clipped. */}
      <div className="overflow-hidden rounded-xl border border-phx-line">
        <PortalResponsiveDataList
          empty={<p className="px-3 py-6 text-center text-xs font-semibold text-slate-400">No days in range.</p>}
          getKey={(day) => day.date}
          items={data.dateBreakdown}
          renderCard={(day) => (
            <PortalRecordCard
              accent={day.total === 0 ? "rose" : "sky"}
              status={
                day.total === 0 ? (
                  <span className="text-xs font-bold text-rose-600">No activity</span>
                ) : (
                  <span className="text-xs font-semibold text-emerald-700">{fmt(day.total)} field visits</span>
                )
              }
              title={formatDateValue(day.date)}
            >
              <PortalRecordFields
                fields={[
                  { label: "AM", value: fmt(day.am) },
                  { label: "PM", value: fmt(day.pm) },
                  { label: "Pharmacies", value: pharmacyCellText(day) },
                  { label: "Regular", value: fmt(day.regular) },
                  { label: "Campaign", value: fmt(day.campaign) },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              className="text-xs"
              cols={
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[15%]" />
                  <col className="w-[13%]" />
                  <col className="w-[14%]" />
                  <col className="w-[16%]" />
                </colgroup>
              }
            >
          <thead className="bg-slate-50 text-phx-2xs uppercase tracking-[0.1em] text-slate-500">
            <tr>
              <th className="px-3 py-2 font-bold">Day</th>
              <th className="px-3 py-2 text-right font-bold">AM</th>
              <th className="px-3 py-2 text-right font-bold">PM</th>
              {/* Pharmacies takes the old Total column's place: the Status cell already prints the
                  day's total ("N field visits"), so the table keeps its seven columns. */}
              <th className="px-3 py-2 text-right font-bold">Pharmacies</th>
              <th className="px-3 py-2 text-right font-bold">Regular</th>
              <th className="px-3 py-2 text-right font-bold">Campaign</th>
              <th className="px-3 py-2 font-bold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.dateBreakdown.map((day) => (
              <tr className={day.total === 0 ? "bg-rose-50/60" : undefined} key={day.date}>
                <td className="break-words px-3 py-2 font-medium text-slate-900">{formatDateValue(day.date)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{fmt(day.am)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{fmt(day.pm)}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{pharmacyCellText(day)}</td>
                <td className="px-3 py-2 text-right font-mono text-sky-700">{fmt(day.regular)}</td>
                <td className="px-3 py-2 text-right font-mono text-violet-700">{fmt(day.campaign)}</td>
                <td className="break-words px-3 py-2">
                  {day.total === 0 ? (
                    <span className="font-bold text-rose-600">No activity</span>
                  ) : (
                    <span className="font-semibold text-emerald-700">{fmt(day.total)} field visits</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
            </PortalDesktopTable>
          )}
        />
      </div>

      {/* Inline visit + route detail: the actual visits and GPS check-ins with submission time
          vs check-in time, ordered by time = the day's route. */}
      {data.dateBreakdown.some((day) => (day.visits?.length ?? 0) > 0 || (day.checkins?.length ?? 0) > 0) ? (
        <div className="space-y-2">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Visits &amp; route detail</p>
          {data.dateBreakdown
            .filter((day) => (day.visits?.length ?? 0) > 0 || (day.checkins?.length ?? 0) > 0)
            .map((day) => (
              <div className="rounded-xl border border-phx-line bg-white p-3" key={`detail-${day.date}`}>
                <p className="text-xs font-bold text-slate-900">{formatDateValue(day.date)}</p>
                <div className="mt-2 space-y-3">
                  {/* `[&>*]:min-w-0` for the same reason as the workspace grid: below `md` this is a
                      single column, and grid items default to `min-width: auto`, so the visit and
                      check-in lists sized the column to their longest line (measured 283 vs 436). */}
                  <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
                    <div>
                      <p className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Visits</p>
                      {!day.visits?.length ? (
                        <p className="mt-1 text-xs text-slate-400">—</p>
                      ) : (
                        <ul className="mt-1 space-y-1">
                          {day.visits.map((visit, index) => (
                            <li className="flex items-center justify-between gap-2 text-xs" key={index}>
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span
                                  className={cn(
                                    "shrink-0 rounded px-1 py-0.5 text-phx-3xs font-bold uppercase",
                                    visit.kind === "campaign" ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700",
                                  )}
                                >
                                  {visit.kind}
                                </span>
                                <span className="break-words text-slate-700">
                                  {visit.contact || visit.customer || "—"}
                                  {visit.role === "partner" ? (
                                    visit.repName ? (
                                      <>
                                        {" · double with "}
                                        <span className="font-semibold text-slate-900">{visit.repName}</span>
                                      </>
                                    ) : (
                                      " · double"
                                    )
                                  ) : null}
                                </span>
                              </span>
                              {/* Each timing says what it IS. The two columns carry different
                                  clocks — when the rep SAVED the CRM record vs when he physically
                                  checked in — and reading a saved-at as a check-in time is exactly
                                  the mistake that makes a trip look wrongly claimed. */}
                              <span className="flex shrink-0 flex-col items-end leading-tight">
                                <span className="whitespace-nowrap text-phx-3xs font-black uppercase tracking-wide text-slate-400">
                                  Saved visit time
                                </span>
                                <span className="whitespace-nowrap font-mono text-slate-500">
                                  {formatClock(visit.submittedAt)}
                                  {visit.ampm ? ` · ${visit.ampm}` : ""}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <p className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Check-ins</p>
                      {!day.checkins?.length ? (
                        <p className="mt-1 text-xs text-slate-400">No GPS check-ins</p>
                      ) : (
                        <ol className="mt-1 space-y-1">
                          {day.checkins.map((checkin, index) => (
                            <li className="flex items-center justify-between gap-2 text-xs" key={index}>
                              <span className="break-words text-slate-700">
                                {index + 1}.{" "}
                                {checkin.contact ||
                                  checkin.address ||
                                  (checkin.lat != null && checkin.lon != null
                                    ? `${checkin.lat.toFixed(4)}, ${checkin.lon.toFixed(4)}`
                                    : "—")}
                                {checkin.via ? <span className="text-slate-400"> · via {checkin.via}</span> : null}
                              </span>
                              <span className="flex shrink-0 flex-col items-end leading-tight">
                                <span className="whitespace-nowrap text-phx-3xs font-black uppercase tracking-wide text-slate-400">
                                  Check-in time
                                </span>
                                <span className="whitespace-nowrap font-mono text-slate-500">{formatClock(checkin.at)}</span>
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </div>
                  {day.checkins?.length ? (
                    <div className="min-w-0">
                      <p className="mb-1 text-phx-2xs font-black uppercase tracking-wide text-slate-400">Route map</p>
                      {/* overflow-hidden is load-bearing: Google Maps renders absolutely-positioned
                          internals (and, when the Maps key is rejected, a fixed-width "can't load
                          Google Maps" overlay) that are WIDER than their container. Measured at
                          375px: `.gm-style` reported clientWidth 247 vs scrollWidth 486, and that
                          239px pushed the whole page sideways. Clipping it here keeps the map's
                          internals from escaping. */}
                      <div className="min-w-0 overflow-hidden">
                        <TripDayRouteMap checkins={day.checkins} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
