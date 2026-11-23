"use client";

import { useCallback, useEffect, useState } from "react";

import { CrmButton, CrmEmpty, CrmLoadError, CrmLoading, CrmShowMore, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import type { DeskHistoryChoice } from "@/lib/outstation/approvals/desk-view";
import type { DeskHistoryPage, SheetTrip } from "@/lib/outstation/approvals/history";
import type { ClaimKind } from "@/lib/outstation/approvals/types";
import { displayPlace } from "@/lib/outstation/place-label";
import { cn } from "@/lib/utils";

import type { OnPress } from "./desk-decision";
import { HistoryCard, HistoryTableRow } from "./desk-history-row";
import { egp } from "./desk-parts";

const ROUTE = "/api/admin/outstation/approvals/history";
const CHOICES: ReadonlyArray<{ key: DeskHistoryChoice; label: string }> = [
  { key: "all", label: "All decided" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];
const SHEET_ROWS = 50;

type Loaded = DeskHistoryPage & { key: string };

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  const payload = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!response.ok || !payload) throw new Error(payload?.message || "Unable to load the history.");
  return payload;
}

/**
 * History — what was already decided. This component is mounted only when the History lane is
 * opened, so the page itself never reads it: fifty decided claims at a time, newest decision first,
 * and the pre-July sheet trips behind one more press of their own.
 *
 * A decided claim is changed ON its row (owner, 23 Nov 2026: "make me able to reject even if approved
 * in history. Make me easily able to approve or reject"): Reject on an approved claim no payroll has
 * taken, Approve on a rejected one. The row and its buttons are in desk-history-row.tsx; the list
 * reads itself again when a press is answered (`version`).
 */
export function DeskHistory({
  canDecide,
  choice,
  from,
  kind,
  onChoose,
  onOpen,
  onPress,
  pressed,
  search,
  to,
  version,
}: {
  canDecide: boolean;
  choice: DeskHistoryChoice;
  /** The trip dates the desk is narrowed to; null = open. The server filters, like the kind. */
  from: string | null;
  /** The kind the desk is narrowed to; null = every kind. The server filters: History is read a page at a time. */
  kind: ClaimKind | null;
  onChoose: (choice: DeskHistoryChoice) => void;
  onOpen: (requestId: number) => void;
  onPress: OnPress;
  /** The claims inside a press right now: each draws no decision button until it is answered. */
  pressed: ReadonlySet<number>;
  search: string;
  to: string | null;
  /** Goes up when a decided claim was changed, so the list reads again. */
  version: number;
}) {
  // The search is read a moment after the typing stops, so each letter is not a request.
  const [term, setTerm] = useState(search);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const key = `${choice}|${kind ?? ""}|${from ?? ""}|${to ?? ""}|${term}|${version}`;
  /** What every read of this list carries: the decision, the kind, the trip dates and the search. */
  const query = useCallback(
    (offset?: number) => {
      const params = new URLSearchParams({ filter: choice });
      if (kind) params.set("kind", kind);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (term) params.set("search", term);
      if (offset) params.set("offset", String(offset));
      return `${ROUTE}?${params.toString()}`;
    },
    [choice, from, kind, term, to],
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readJson<DeskHistoryPage>(query())
      .then((page) => {
        if (!cancelled) setLoaded({ ...page, key });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailed({ key, message: error instanceof Error ? error.message : "Unable to load the history." });
      });
    return () => {
      cancelled = true;
    };
    // `attempt` re-runs the same read after a failure.
  }, [attempt, key, query]);

  const page = loaded?.key === key ? loaded : null;
  const error = !page && failed?.key === key ? failed.message : null;

  const showMore = useCallback(async () => {
    if (!page || page.nextOffset === null) return;
    setMore(true);
    try {
      const next = await readJson<DeskHistoryPage>(query(page.nextOffset));
      setLoaded((current) => (current?.key === page.key ? { ...next, claims: [...current.claims, ...next.claims], key: current.key } : current));
    } catch (caught) {
      setFailed({ key, message: caught instanceof Error ? caught.message : "Unable to load the history." });
    } finally {
      setMore(false);
    }
  }, [key, page, query]);

  return (
    <section aria-labelledby="desk-tab-history" className="min-w-0 overflow-hidden border border-slate-200 bg-white" data-desk-history id="desk-panel-history" role="tabpanel">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2">
        <h2 className="min-w-0 break-words text-sm font-black text-slate-950">
          <span aria-hidden className="mr-2 inline-block h-2 w-2 bg-orange-500 align-middle" />
          History{page ? ` (${formatNumberValue(page.total)})` : ""}
        </h2>
        <div aria-label="Which decisions" className="flex min-w-0 flex-wrap gap-1.5" role="group">
          {CHOICES.map((entry) => (
            <button
              aria-pressed={choice === entry.key}
              className={cn(
                "inline-flex min-h-11 items-center border px-3 py-1 text-xs font-black transition md:min-h-9",
                choice === entry.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500",
              )}
              data-history-choice={entry.key}
              key={entry.key}
              onClick={() => onChoose(entry.key)}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <CrmLoadError message={error} onRetry={() => setAttempt((current) => current + 1)} />
      ) : !page ? (
        <CrmLoading label="Reading the decided claims" />
      ) : page.claims.length === 0 ? (
        <CrmEmpty
          message={term ? "No decided claim matches the search." : kind || from || to ? "No decided claim matches the kind and the trip dates chosen." : "No claim has been decided yet."}
          title="Nothing here"
        />
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {page.claims.map((claim) => (
              <HistoryCard canDecide={canDecide} claim={claim} key={claim.requestId} onOpen={onOpen} onPress={onPress} pressed={pressed.has(claim.requestId)} />
            ))}
          </div>
          <CrmTable columns={["24%", "15%", null, "12%", "22%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">Employee and trip</th>
                <th className={crmThClassName} scope="col">Where it stands</th>
                <th className={crmThClassName} scope="col">Reason on the claim</th>
                <th className={cn(crmThClassName, "text-right")} scope="col">Claim</th>
                <th className={crmThClassName} scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {page.claims.map((claim) => (
                <HistoryTableRow canDecide={canDecide} claim={claim} key={claim.requestId} onOpen={onOpen} onPress={onPress} pressed={pressed.has(claim.requestId)} />
              ))}
            </tbody>
          </CrmTable>
          {page.nextOffset !== null ? (
            <div className="border-t border-slate-100 px-4 py-3">
              <CrmButton busy={more} onClick={() => void showMore()} size="sm">
                Show {formatNumberValue(Math.min(50, page.total - page.claims.length))} more of the {formatNumberValue(page.total - page.claims.length)} left
              </CrmButton>
            </div>
          ) : null}
        </>
      )}
      <SheetTrips />
    </section>
  );
}

/**
 * The trips that came from the expense sheets before employees filed in Phoenix. Values only: they
 * are decided on the sheet workspace, and nothing here changes one. Read on its own press.
 */
function SheetTrips() {
  const [state, setState] = useState<{ error: string | null; loading: boolean; trips: SheetTrip[] | null }>({ error: null, loading: false, trips: null });
  const [shown, setShown] = useState(SHEET_ROWS);

  const read = async () => {
    setState({ error: null, loading: true, trips: null });
    try {
      const payload = await readJson<{ sheets: SheetTrip[] }>(`${ROUTE}?source=sheets`);
      setState({ error: null, loading: false, trips: Array.isArray(payload.sheets) ? payload.sheets : [] });
    } catch (caught) {
      setState({ error: caught instanceof Error ? caught.message : "Unable to load the sheet trips.", loading: false, trips: null });
    }
  };

  if (!state.trips) {
    return (
      <div className="border-t border-slate-200 px-4 py-3" data-sheet-trips="closed">
        <CrmButton busy={state.loading} onClick={() => void read()} size="sm">
          Show the trips from the expense sheets (before July 2026) and trips whose request was deleted
        </CrmButton>
        {state.error ? <p className="mt-2 text-xs font-bold text-rose-700">{state.error}</p> : null}
      </div>
    );
  }

  const page = state.trips.slice(0, shown);
  return (
    <div className="border-t border-slate-200" data-sheet-trips="open">
      <h3 className="px-4 py-2 text-sm font-black text-slate-950">
        From the expense sheets ({formatNumberValue(state.trips.length)})
        <span className="ml-2 font-semibold text-slate-500">Decided on the sheets. Read only here.</span>
      </h3>
      {state.trips.length === 0 ? (
        <CrmEmpty title="No sheet trips" />
      ) : (
        <>
          <div className="divide-y divide-slate-100 border-t border-slate-100 md:hidden">
            {page.map((trip) => (
              <article className="min-w-0 px-3 py-2.5" key={trip.tripId}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 break-words text-sm font-black text-slate-950">
                    <bdi dir="auto">{trip.employeeName || "Unassigned"}</bdi>
                  </span>
                  <span className="shrink-0 text-sm font-black tabular-nums text-slate-950">{egp(trip.payable)}</span>
                </div>
                <p className="mt-0.5 min-w-0 break-words text-xs font-semibold text-slate-500">
                  {formatDateValue(trip.tripDate)} · <bdi dir="auto">{displayPlace(trip.to)}</bdi> · {sheetDecision(trip)}
                </p>
              </article>
            ))}
          </div>
          <CrmTable columns={["30%", "16%", null, "14%", "14%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">Employee</th>
                <th className={crmThClassName} scope="col">Trip date</th>
                <th className={crmThClassName} scope="col">Route</th>
                <th className={cn(crmThClassName, "text-right")} scope="col">Paid</th>
                <th className={crmThClassName} scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {page.map((trip) => (
                <tr key={trip.tripId}>
                  <td className={crmTdClassName}>
                    <bdi dir="auto">{trip.employeeName || "Unassigned"}</bdi>
                  </td>
                  <td className={crmTdClassName}>{formatDateValue(trip.tripDate)}</td>
                  <td className={crmTdClassName}>
                    <bdi dir="auto">{displayPlace(trip.from)}</bdi> → <bdi dir="auto">{displayPlace(trip.to)}</bdi>
                  </td>
                  <td className={cn(crmTdClassName, "text-right tabular-nums")}>{egp(trip.payable)}</td>
                  <td className={crmTdClassName}>{sheetDecision(trip)}</td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmShowMore left={state.trips.length - page.length} onMore={() => setShown((current) => current + SHEET_ROWS)} page={SHEET_ROWS} />
        </>
      )}
    </div>
  );
}

function sheetDecision(trip: SheetTrip): string {
  const decision = trip.rejected ? "Rejected" : trip.approved ? "Approved" : "Not decided";
  // Filed in Phoenix, its request deleted after payroll took it: only the payroll row is left.
  return trip.requestDeleted ? `${decision} · filed in Phoenix, request deleted` : decision;
}
