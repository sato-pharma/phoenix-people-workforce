"use client";

import { AlertTriangle, ChevronRight, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

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

export type WorkloadVisitDetail = {
  ampm: string | null;
  contact: string | null;
  customer: string | null;
  /** "campaign" is the payload's word for an UNPLANNED visit; the card prints "Unplanned" / "Planned". */
  kind: string;
  /** On a partner visit, the rep who logged it — resigned or not (visit-workload.ts). Optional so a
   * payload from a server built before it still renders the bare "double". */
  repName?: string | null;
  /** "agent" · "partner" (a double visit a rep logged) · "own" (a manager's single visit he logged himself). */
  role: string;
  submittedAt: string | null;
};

export type WorkloadCheckinDetail = {
  address: string | null;
  at: string | null;
  contact: string | null;
  lat: number | null;
  lon: number | null;
  via: string | null;
};

export type WorkloadEvidenceDay = {
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
  /** The trip's UNPLANNED visits (the payload keeps the old key). */
  campaignVisits: number;
  dateBreakdown: WorkloadEvidenceDay[];
  idleDates: string[];
  matchStatus: string;
  matchedDates: string[];
  /** A manager's own single visits on the trip, inside every figure above. Absent when unread. */
  managerOwnVisits?: number;
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
export function formatClock(value: string | null) {
  const match = /[T ](\d{2}:\d{2})/.exec(String(value ?? ""));
  return match ? match[1] : "—";
}

/**
 * A day's visits and check-ins, every one printed: the visit's kind, who was visited, the partner
 * on a double, AM or PM and the time the rep SAVED it; the check-in's number (the same number its
 * pin wears on the map), who or where, how it was logged and the time of the check-in itself.
 * Shared by the folded row and the always-open block below, so the two cannot drift.
 */
function DayDetail({
  checkins,
  firstCheckinNumber,
  visits,
}: {
  checkins: WorkloadCheckinDetail[];
  /** Trip-wide numbering when the whole trip is on one map; 1 for a day on its own. */
  firstCheckinNumber: number;
  visits: WorkloadVisitDetail[];
}) {
  return (
    // `[&>*]:min-w-0`: below `md` this is one column, and a grid item defaults to
    // `min-width: auto`, so the longest visit line would size the column (measured 283 vs 436).
    <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Visits</p>
        {visits.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">No visits saved</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {visits.map((visit, index) => (
              <li className="flex items-center justify-between gap-2 text-xs" key={index}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "shrink-0 px-1 py-0.5 text-phx-3xs font-bold uppercase",
                      visit.kind === "campaign" ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700",
                    )}
                  >
                    {visit.kind === "campaign" ? "Unplanned" : "Planned"}
                  </span>
                  <span className="break-words text-slate-700">
                    {visit.contact || visit.customer || "—"}
                    {visit.contact && visit.customer && visit.customer !== visit.contact ? (
                      <span className="text-slate-400"> · {visit.customer}</span>
                    ) : null}
                    {visit.role === "partner" ? (
                      visit.repName ? (
                        <>
                          {" · double with "}
                          <span className="font-semibold text-slate-900">{visit.repName}</span>
                        </>
                      ) : (
                        " · double"
                      )
                    ) : visit.role === "own" ? (
                      " · own visit"
                    ) : null}
                  </span>
                </span>
                {/* Each timing says what it IS: when the rep SAVED the CRM record is a
                    different clock from when he physically checked in. */}
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
        {checkins.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">No GPS check-ins</p>
        ) : (
          <ol className="mt-1 space-y-1">
            {checkins.map((checkin, index) => (
              <li className="flex items-center justify-between gap-2 text-xs" key={index}>
                <span className="flex min-w-0 items-start gap-1.5">
                  <span className="mt-px inline-flex h-4 min-w-4 shrink-0 items-center justify-center bg-orange-500 px-1 font-mono text-phx-3xs font-black text-white">
                    {firstCheckinNumber + index}
                  </span>
                  <span className="break-words text-slate-700">
                    {checkin.contact ||
                      checkin.address ||
                      (checkin.lat != null && checkin.lon != null
                        ? `${checkin.lat.toFixed(4)}, ${checkin.lon.toFixed(4)}`
                        : "—")}
                    {checkin.contact && checkin.address ? (
                      <span className="block text-slate-500">{checkin.address}</span>
                    ) : null}
                    {checkin.via ? <span className="text-slate-400"> · via {checkin.via}</span> : null}
                  </span>
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
  );
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
 * One trip day: its figures and verdict on the row, its visits, check-ins and route map behind a
 * click. The map mounts only once the day is opened — a Google map per day, all drawn at once, was
 * most of what made a long trip unreadable.
 */
function TripDayRow({
  day,
  dayCount,
  dayNumber,
  pharmacyText,
}: {
  day: WorkloadEvidenceDay;
  dayCount: number;
  dayNumber: number;
  pharmacyText: string;
}) {
  const [opened, setOpened] = useState(false);
  const visits = day.visits ?? [];
  const checkins = day.checkins ?? [];
  const hasDetail = visits.length > 0 || checkins.length > 0;
  const idle = day.total === 0;

  const figures = (
    <span className="grid grid-cols-3 gap-x-3 font-mono text-xs text-slate-700 sm:flex sm:flex-wrap sm:gap-x-4">
      <span>
        <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">AM </span>
        {fmt(day.am)}
      </span>
      <span>
        <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">PM </span>
        {fmt(day.pm)}
      </span>
      <span className="break-words">
        <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Pharmacies </span>
        {pharmacyText}
      </span>
      <span className="text-sky-700">
        <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Planned </span>
        {fmt(day.regular)}
      </span>
      <span className="text-violet-700">
        <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Unplanned </span>
        {fmt(day.campaign)}
      </span>
    </span>
  );

  const head = (
    <span className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center">
      <span className="min-w-0">
        {dayCount > 1 ? (
          <span className="block text-phx-2xs font-black uppercase tracking-wide text-slate-400">
            Day {fmt(dayNumber)} of {fmt(dayCount)}
          </span>
        ) : null}
        <span className="block text-xs font-bold text-slate-900">
          {formatDateValue(day.date, null, { weekday: "short" })}
        </span>
      </span>
      <span className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">{figures}</span>
      <span className="flex items-center gap-2 justify-self-end">
        {idle ? (
          <span className="whitespace-nowrap text-xs font-black text-rose-600">No activity</span>
        ) : (
          <span className="whitespace-nowrap text-xs font-bold text-emerald-700">{fmt(day.total)} field visits</span>
        )}
        {hasDetail ? (
          <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
        ) : null}
      </span>
    </span>
  );

  if (!hasDetail) {
    return <li className={cn("px-3 py-2.5", idle ? "bg-rose-50" : undefined)}>{head}</li>;
  }

  return (
    <li className={idle ? "bg-rose-50" : undefined}>
      <details className="group" onToggle={(event) => setOpened(event.currentTarget.open)}>
        <summary className="cursor-pointer list-none px-3 py-2.5 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
          {head}
        </summary>
        <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-3 py-3">
          <DayDetail checkins={checkins} firstCheckinNumber={1} visits={visits} />
          {opened && checkins.length > 0 ? (
            <div className="min-w-0">
              <p className="mb-1 text-phx-2xs font-black uppercase tracking-wide text-slate-400">Route map</p>
              {/* overflow-hidden is load-bearing: Google Maps draws absolutely-positioned internals
                  wider than their box (measured at 375px: 247 vs 486), which pushed the page sideways. */}
              <div className="min-w-0 overflow-hidden">
                <TripDayRouteMap checkins={checkins} />
              </div>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * One trip day with nothing behind a click (owner, 2026-11-07: "any information or data you have
 * for the trip must be shown"). The day's figures on the first line, then every visit and every
 * check-in. No map here: the page that asks for this draws the WHOLE trip on one map above.
 */
function TripDayOpen({
  day,
  dayCount,
  dayNumber,
  firstCheckinNumber,
  map,
  pharmacyText,
}: {
  day: WorkloadEvidenceDay;
  dayCount: number;
  dayNumber: number;
  firstCheckinNumber: number;
  /** The day's own map, drawn by the caller (Expense Approvals: one map for each trip day). */
  map?: ReactNode;
  pharmacyText: string;
}) {
  const visits = day.visits ?? [];
  const checkins = day.checkins ?? [];
  const idle = day.total === 0;
  return (
    <li className="border border-slate-200 bg-white">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1.5 border-l-[3px] px-3 py-2.5",
          idle ? "border-l-rose-500 bg-rose-50" : "border-l-emerald-500 bg-slate-50",
        )}
      >
        <span className="min-w-0">
          {dayCount > 1 ? (
            <span className="mr-2 text-phx-2xs font-black uppercase tracking-wide text-slate-400">
              Day {fmt(dayNumber)} of {fmt(dayCount)}
            </span>
          ) : null}
          <span className="text-sm font-bold text-slate-900">{formatDateValue(day.date, null, { weekday: "short" })}</span>
        </span>
        {idle ? (
          <span className="whitespace-nowrap text-xs font-black text-rose-600">No field activity</span>
        ) : (
          <span className="whitespace-nowrap text-xs font-bold text-emerald-700">{fmt(day.total)} field visits</span>
        )}
        <span className="grid grid-cols-3 gap-x-3 font-mono text-xs text-slate-700 sm:ml-auto sm:flex sm:flex-wrap sm:gap-x-4">
          <span>
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">AM </span>
            {fmt(day.am)}
          </span>
          <span>
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">PM </span>
            {fmt(day.pm)}
          </span>
          <span className="break-words">
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Pharmacies </span>
            {pharmacyText}
          </span>
          <span className="text-sky-700">
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Planned </span>
            {fmt(day.regular)}
          </span>
          <span className="text-violet-700">
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">Unplanned </span>
            {fmt(day.campaign)}
          </span>
        </span>
      </div>
      {/* The map first, the day's visits and check-ins listed UNDER it (owner, 2026-11-07:
          "and every day's visits is listed under the map"). */}
      {map}
      {visits.length > 0 || checkins.length > 0 ? (
        <div className="border-t border-slate-200 px-3 py-3">
          <DayDetail checkins={checkins} firstCheckinNumber={firstCheckinNumber} visits={visits} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Actual field-visit workload for one trip, read from the admin/CRM mirror
 * (`/api/outstation/visit-workload`) — every field visit where the rep is the primary agent OR
 * the double-visit partner, planned AND unplanned, with no departed-agent exclusion. Auto-loads
 * for the given rep + trip window so a focused decision panel needs no extra click.
 */
export function TripWorkloadEvidencePanel({
  alwaysOpen = false,
  declaredAm,
  declaredPharmacies = null,
  declaredPm,
  hrId,
  onLoaded,
  renderDayMap,
  storedMatchedAt = null,
  storedMatchStatus = null,
  tripEndDate,
  tripStartDate,
}: {
  /**
   * Every day printed in full, folding nothing (Expense Approvals, 2026-11-07). Default false:
   * the request drawer keeps its folding rows, each with its own map when opened.
   */
  alwaysOpen?: boolean;
  declaredAm: number;
  /** The stored third figure. NULL = not counted separately: a request stamped before the
   * 2026-09-21 split (its pharmacies sit inside AM/PM), a hand-typed workload, or an import. */
  declaredPharmacies?: number | null;
  declaredPm: number;
  hrId: string | null;
  /** The live read, once it lands (null on a failure) — so the caller can pin the check-ins on its
   * own map and word its verdict. The fetch is this panel's; nothing is read twice. */
  onLoaded?: (data: TripWorkloadEvidence | null) => void;
  /**
   * With `alwaysOpen`, the map drawn at the foot of EACH day block — the caller owns it so it can
   * pin that day's photos and stops beside the check-ins (owner, 2026-11-07: "in a multiple day
   * trip separate each day from the other; if 3 days then I should have 3 maps"). The check-ins
   * are numbered across the trip; `firstCheckinNumber` is this day's first.
   */
  renderDayMap?: (day: WorkloadEvidenceDay, firstCheckinNumber: number) => ReactNode;
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
  // The latest callback, read when the fetch lands — a new function identity on every render of
  // the caller must not re-run the fetch.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      // Yield once so the reset/loading setState lands after an await, not synchronously in the
      // effect body (react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;
      if (!hrId || !tripStartDate) {
        setState({ status: "idle" });
        onLoadedRef.current?.(null);
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
        if (!cancelled) {
          setState({ data: payload.data as TripWorkloadEvidence, status: "done" });
          onLoadedRef.current?.(payload.data as TripWorkloadEvidence);
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            error: error instanceof Error ? error.message : "Workload lookup failed.",
            sessionExpired: Boolean((error as { sessionExpired?: boolean })?.sessionExpired),
            status: "error",
          });
          onLoadedRef.current?.(null);
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
  const idleDayCount = data.dateBreakdown.filter((day) => day.total === 0).length;
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
        {/* The one line a long trip needs first: how many of its days carry no field work. Counted
            from the same rows listed below, so the two can never disagree. */}
        {idleDayCount > 0 ? (
          <span className="text-phx-xs font-black text-rose-600">
            {data.dateBreakdown.length > 1
              ? `${fmt(idleDayCount)} of ${fmt(data.dateBreakdown.length)} days with no field activity`
              : "No field activity on this day"}
          </span>
        ) : null}
      </div>
      {freshness.verdict === "stale" && freshness.headline ? (
        <div className="flex items-start gap-2 border border-amber-300 bg-amber-50 p-3">
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
        <div className="border border-phx-line bg-white p-3">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Declared (sheet)</p>
          <p className="mt-1 font-mono text-sm font-bold text-slate-900">
            AM {fmt(declaredAm)} · PM {fmt(declaredPm)} · Pharmacies{" "}
            {declaredPharmacies === null ? "not counted separately" : fmt(declaredPharmacies)}
          </p>
        </div>
        <div className={cn("border p-3", mismatch ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50")}>
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
        <div className="border border-phx-line bg-white p-3">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Visit type</p>
          <p className="mt-1 font-mono text-sm font-bold text-slate-900">
            Planned {fmt(data.regularVisits)} · Unplanned {fmt(data.campaignVisits)}
          </p>
          {/* A manager's visits count to him both ways (owner, 6 Nov 2026): with a rep, and on his own. */}
          {data.managerOwnVisits ? (
            <p className="mt-0.5 font-mono text-phx-2xs font-bold text-slate-600">
              With a rep {fmt(data.regularVisits + data.campaignVisits - data.managerOwnVisits)} · Own visits{" "}
              {fmt(data.managerOwnVisits)}
            </p>
          ) : null}
        </div>
      </div>
      {/* DAY BY DAY (owner, 2026-11-06: "so confusing … specially when the trip is more than 1 day").
          This used to be a seven-column table, then — further down — a second, always-open list of
          the same days with every visit and every check-in. Now each trip day is ONE block: its
          figures and verdict in the row itself. In the request drawer its visits, check-ins and
          route sit behind a click and the map is only drawn for a day that is opened; on Expense
          Approvals (`alwaysOpen`) every day is open and the caller draws ONE MAP PER DAY under it
          (owner, 2026-11-07: "if 3 days then I should have 3 maps"). A list, not a table, so a
          phone gets the same rows with nothing scrolling sideways. */}
      {alwaysOpen ? (
        <ol className="space-y-2">
          {data.dateBreakdown.length === 0 ? (
            <li className="border border-phx-line bg-white px-3 py-6 text-center text-xs font-semibold text-slate-400">
              No days in range.
            </li>
          ) : (
            data.dateBreakdown.map((day, index) => {
              // The check-ins are numbered across the whole trip, matching their pins on the map.
              const firstCheckinNumber =
                1 + data.dateBreakdown.slice(0, index).reduce((sum, earlier) => sum + (earlier.checkins?.length ?? 0), 0);
              return (
                <TripDayOpen
                  day={day}
                  dayCount={data.dateBreakdown.length}
                  dayNumber={index + 1}
                  firstCheckinNumber={firstCheckinNumber}
                  key={day.date}
                  map={renderDayMap?.(day, firstCheckinNumber)}
                  pharmacyText={pharmacyCellText(day)}
                />
              );
            })
          )}
        </ol>
      ) : (
        <ol className="divide-y divide-slate-200 border border-phx-line bg-white">
          {data.dateBreakdown.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs font-semibold text-slate-400">No days in range.</li>
          ) : (
            data.dateBreakdown.map((day, index) => (
              <TripDayRow
                day={day}
                dayCount={data.dateBreakdown.length}
                dayNumber={index + 1}
                key={day.date}
                pharmacyText={pharmacyCellText(day)}
              />
            ))
          )}
        </ol>
      )}
    </div>
  );
}
