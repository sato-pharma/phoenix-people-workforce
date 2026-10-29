"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Manager Scorecard — one row per person who raised marketing requests.
//
// Owner instruction, 2026-10-09: list every manager who did marketing requests, how many he did
// and how many were approved, the total value of those requests, the sum of the forecast ROI, and
// the sum of what has actually come back so far. Mounted on BOTH shells (the admin page and the
// portal's ROI Tracker tab) off one API route, so the two can never show different numbers.
//
// Six columns, not eleven. The fits-the-screen rule is MERGE, never shrink or scroll: each money
// pair rides in one cell as two lines, which is what keeps a `table-fixed` honest at 375px with no
// horizontal scroll. The desktop/mobile switch is on the CONTAINER's width (`@container` +
// `@min-[…]`), not the viewport — this component is mounted inside a tab panel on one shell and a
// page body on the other.
//
// Nothing is computed here. Every figure arrives from `buildMarketingManagerScorecard`, including
// the attribution dedupe; a component that re-summed the rows would read ~52% high.
// ─────────────────────────────────────────────────────────────────────────────

import { FileSpreadsheet, FileText } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { CAIRO_MONTHS, cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  adminPanelClassName,
  adminPanelHeaderClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import type { DistributorFileGap } from "@/lib/marketing-requests/manager-scorecard-awaiting";
import type { MarketingManagerScorecard } from "@/lib/marketing-requests/manager-scorecard";

const money = (value: number): string => `EGP ${Math.round(value).toLocaleString("en-US")}`;
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * YYYY-MM → "Aug 2026". The sales frontier is a month, never a timestamp.
 *
 * 🔴 The month name comes from `CAIRO_MONTHS`, never from `Intl`. This is a `"use client"`
 * component, so every label here is formatted twice — once by Node when the HTML is rendered, again
 * by the browser at hydration — and CLDR 42 renamed abbreviated September from "Sep" to "Sept", so
 * two differently-aged ICU builds disagree by one character and React throws #418. It would only
 * ever have shown up in September. Pinned by `tests/react-418-hydration-safe-text.test.ts`.
 */
function monthLabel(period: string | null): string {
  if (!period) return "no validated sales data yet";
  const [year, month] = (period ?? "").split("-").map((part) => Number(part));
  if (!year || !month || month < 1 || month > 12) return period;
  return `${CAIRO_MONTHS[month - 1]} ${year}`;
}

/**
 * "EGP 5,007 of this is still waiting on a distributor file — Ibn sina has not filed Sept 2026."
 *
 * Owner instruction, 2026-10-09: "show on the Scorecard which zeroes are missing distributor
 * files". It leads with the MONEY, because that is what makes a 0 look like a verdict; the reason
 * follows. Returns null when nothing is waiting, so a row that really did come back empty carries
 * no excuse.
 *
 * 🔴 Months come through `monthLabel` (CAIRO_MONTHS), never `Intl` — see its own note above.
 * Nothing is truncated with an ellipsis: this wraps instead, which is the owner's rule.
 */
function fileGapNote(input: {
  awaitingFileRequests: number;
  awaitingFileValue: number;
  fileGaps: DistributorFileGap[];
}): string | null {
  if (input.awaitingFileRequests < 1 || input.fileGaps.length === 0) return null;
  const names = input.fileGaps.map((gap) => gap.distributorName);
  const periods = [...new Set(input.fileGaps.flatMap((gap) => gap.periods))].sort();
  const who = names.length === 1 ? `${names[0]} has` : `${names.join(", ")} have`;
  const when = periods.map((period) => monthLabel(period)).join(", ");
  const campaigns = `${input.awaitingFileRequests} ${input.awaitingFileRequests === 1 ? "campaign" : "campaigns"}`;
  return `${money(input.awaitingFileValue)} across ${campaigns} cannot be judged yet — ${who} not filed ${when}`;
}

export function MarketingManagerScorecard() {
  const [data, setData] = useState<MarketingManagerScorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The fetch touches no state, so the mount effect below can start it without a synchronous
  // setState — the pattern every sibling tracker in this module uses, and the one lint's
  // react-hooks/set-state-in-effect rule enforces.
  const fetchScorecard = useCallback(async (): Promise<MarketingManagerScorecard> => {
    const response = await fetch("/api/marketing-requests/manager-scorecard", { cache: "no-store" });
    const body = (await response.json()) as MarketingManagerScorecard & { message?: string };
    if (!response.ok) throw new Error(body.message || "The scorecard could not be loaded.");
    return body;
  }, []);

  // The Try again button: here the spinner SHOULD come back, because the click has to show it did
  // something. On mount `loading` is already true, which is why the effect never sets it.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchScorecard());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The scorecard could not be loaded.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetchScorecard]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchScorecard();
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "The scorecard could not be loaded.");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchScorecard]);

  if (loading) {
    return (
      <div className={`${adminPanelClassName} p-6`}>
        <div className="h-5 w-56 animate-pulse bg-slate-200" />
        <div className="mt-4 space-y-2">
          {[0, 1, 2, 3, 4].map((key) => (
            <div className="h-10 animate-pulse bg-slate-100" key={key} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${adminPanelClassName} p-6`}>
        <p className="text-phx-md font-bold text-slate-900">The scorecard could not be loaded</p>
        <p className="mt-1 text-phx-sm text-slate-600">{error}</p>
        <button
          className="mt-4 min-h-10 border border-slate-300 bg-white px-4 text-phx-sm font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className={`${adminSoftPanelClassName} p-6`}>
        <p className="text-phx-md font-bold text-slate-900">No marketing requests in your scope yet</p>
        <p className="mt-1 text-phx-sm text-slate-600">
          This report lists the people who raised marketing requests you can see. Nobody in your team has
          raised one yet.
        </p>
      </div>
    );
  }

  const { rows, totals } = data;

  return (
    <div className="@container/scorecard space-y-6">
      <KpiBand data={data} />
      <ExportBar />

      {/* Desktop: the full table. Hidden below 760px of CONTAINER width, where the cards take over. */}
      <div className={`${adminPanelClassName} hidden @min-[760px]/scorecard:block`}>
        <div className={`${adminPanelHeaderClassName} px-4 py-3`}>
          <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">
            Marketing requests by manager
          </p>
          <p className="mt-0.5 text-phx-xs text-slate-300">
            Distributor sales fully loaded to {monthLabel(data.salesDataAsOf)} — a later month
            counts as soon as its files arrive · read as of{" "}
            {cairoDateTime(data.generatedAtIso)} Cairo
          </p>
        </div>
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              <Th>Manager</Th>
              <Th>Requests</Th>
              <Th numeric>Requested value</Th>
              <Th numeric>Forecast ROI</Th>
              <Th numeric>Actual collected</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b border-slate-100 align-top" key={row.managerHrId}>
                <Td>
                  <p className="text-phx-sm font-bold text-slate-900">{row.managerName}</p>
                  <p className="text-phx-xs text-slate-500">
                    {[row.lineName ? `${row.lineName} line` : null, row.regionName].filter(Boolean).join(" · ") || "—"}
                  </p>
                </Td>
                <Td>
                  <p className="text-phx-sm font-bold text-slate-900">
                    {row.totalRequests} raised · {row.approvedRequests} approved
                  </p>
                  <p className="text-phx-xs text-slate-500">
                    {row.awaitingRequests} awaiting a decision · {row.refusedRequests} refused or called off
                  </p>
                </Td>
                <Td numeric>
                  <p className="text-phx-sm font-bold text-slate-900">{money(row.approvedValue)}</p>
                  <p className="text-phx-xs text-slate-500">{money(row.totalRequestedValue)} asked for</p>
                </Td>
                <Td numeric>
                  <p className="text-phx-sm font-bold text-slate-900">{money(row.expectedRoiValue)}</p>
                  <p className="text-phx-xs text-slate-500">{money(row.requiredRoiValue)} required</p>
                </Td>
                <Td numeric>
                  <p className="text-phx-sm font-bold text-slate-900">{money(row.actualValue)}</p>
                  <p className="text-phx-xs text-slate-500">
                    {percent(row.recoveryRatio)} of approved spend · {percent(row.roiCoverageRatio)} of required
                  </p>
                  {fileGapNote(row) ? (
                    <p className="mt-1 text-phx-xs font-bold text-orange-700">{fileGapNote(row)}</p>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-50">
              <Td>
                <p className="text-phx-sm font-bold text-slate-900">
                  {totals.managerCount} {totals.managerCount === 1 ? "manager" : "managers"}
                </p>
                <p className="text-phx-xs text-slate-500">Company total in your scope</p>
              </Td>
              <Td>
                <p className="text-phx-sm font-bold text-slate-900">
                  {totals.totalRequests} raised · {totals.approvedRequests} approved
                </p>
                <p className="text-phx-xs text-slate-500">
                  {totals.awaitingRequests} awaiting · {totals.refusedRequests} refused
                </p>
              </Td>
              <Td numeric>
                <p className="text-phx-sm font-bold text-slate-900">{money(totals.approvedValue)}</p>
                <p className="text-phx-xs text-slate-500">{money(totals.totalRequestedValue)} asked for</p>
              </Td>
              <Td numeric>
                <p className="text-phx-sm font-bold text-slate-900">{money(totals.expectedRoiValue)}</p>
                <p className="text-phx-xs text-slate-500">{money(totals.requiredRoiValue)} required</p>
              </Td>
              <Td numeric>
                <p className="text-phx-sm font-bold text-slate-900">{money(totals.actualValue)}</p>
                <p className="text-phx-xs text-slate-500">
                  {percent(totals.recoveryRatio)} of approved spend · shared sales counted once
                </p>
                {fileGapNote(totals) ? (
                  <p className="mt-1 text-phx-xs font-bold text-orange-700">{fileGapNote(totals)}</p>
                ) : null}
              </Td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Phone and narrow containers: one card per manager, same figures, no table. */}
      <div className="space-y-3 @min-[760px]/scorecard:hidden">
        {rows.map((row) => (
          <article className={`${adminPanelClassName} p-4`} key={row.managerHrId}>
            <p className="text-phx-md font-bold text-slate-900">{row.managerName}</p>
            <p className="text-phx-xs text-slate-500">
              {[row.lineName ? `${row.lineName} line` : null, row.regionName].filter(Boolean).join(" · ")}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Requests" value={`${row.totalRequests} raised · ${row.approvedRequests} approved`} />
              <Field label="Approved value" value={money(row.approvedValue)} />
              <Field label="Forecast ROI" value={money(row.expectedRoiValue)} />
              <Field label="Required return" value={money(row.requiredRoiValue)} />
              <Field label="Actual collected" value={money(row.actualValue)} />
              <Field label="Of approved spend" value={percent(row.recoveryRatio)} />
            </dl>
            {fileGapNote(row) ? (
              <p className="mt-3 text-phx-xs font-bold text-orange-700">{fileGapNote(row)}</p>
            ) : null}
          </article>
        ))}
        <article className={`${adminSoftPanelClassName} p-4`}>
          <p className="text-phx-md font-bold text-slate-900">Company total in your scope</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Managers" value={String(totals.managerCount)} />
            <Field label="Requests" value={`${totals.totalRequests} raised · ${totals.approvedRequests} approved`} />
            <Field label="Approved value" value={money(totals.approvedValue)} />
            <Field label="Forecast ROI" value={money(totals.expectedRoiValue)} />
            <Field label="Actual collected" value={money(totals.actualValue)} />
            <Field label="Of approved spend" value={percent(totals.recoveryRatio)} />
          </dl>
          {fileGapNote(totals) ? (
            <p className="mt-3 text-phx-xs font-bold text-orange-700">{fileGapNote(totals)}</p>
          ) : null}
        </article>
      </div>
    </div>
  );
}

/**
 * Owner instruction, 2026-10-09: "make me able to extract reports from it either by excel or
 * either by pdf". Plain anchors, not fetch-and-blob: the browser's own download handles the
 * Content-Disposition, survives a slow report without a spinner to maintain, and the file the
 * reader gets is built from HIS scope on the server — the route resolves it, never the query
 * string, so there is nothing here anyone could edit to widen what they receive.
 */
function ExportBar() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* `download` is load-bearing, not decoration: the target is an API route that streams a
          binary, and without it @next/next/no-html-link-for-pages demands a <Link> that would hand
          the attachment to the client router. The same idiom as the module's other export. */}
      <a
        className="inline-flex min-h-10 items-center border border-slate-300 bg-white px-4 text-phx-sm font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
        download
        href="/api/marketing-requests/manager-scorecard/export?format=xlsx"
      >
        <FileSpreadsheet className="mr-2 h-3.5 w-3.5 shrink-0" />
        Download Excel
      </a>
      <a
        className="inline-flex min-h-10 items-center border border-slate-300 bg-white px-4 text-phx-sm font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
        download
        href="/api/marketing-requests/manager-scorecard/export?format=pdf"
      >
        <FileText className="mr-2 h-3.5 w-3.5 shrink-0" />
        Download PDF
      </a>
      <p className="text-phx-xs text-slate-500">
        Both files carry exactly the managers on this page, with the same totals.
      </p>
    </div>
  );
}

function KpiBand({ data }: { data: MarketingManagerScorecard }) {
  const { totals } = data;
  const tiles: Array<{ hint: string; label: string; value: string }> = [
    {
      hint: `${totals.totalRequests} requests raised`,
      label: "Managers",
      value: String(totals.managerCount),
    },
    {
      hint: `${money(totals.totalRequestedValue)} asked for`,
      label: "Approved spend",
      value: money(totals.approvedValue),
    },
    {
      hint: `${money(totals.requiredRoiValue)} required to break even`,
      label: "Forecast ROI",
      value: money(totals.expectedRoiValue),
    },
    {
      hint:
        totals.awaitingFileRequests > 0
          ? `${percent(totals.recoveryRatio)} of approved spend · ${money(totals.awaitingFileValue)} still waiting on a distributor file`
          : `${percent(totals.recoveryRatio)} of approved spend · sales loaded to ${monthLabel(data.salesDataAsOf)}`,
      label: "Actual collected",
      value: money(totals.actualValue),
    },
  ];

  return (
    <dl className="grid grid-cols-1 gap-3 @min-[520px]/scorecard:grid-cols-2 @min-[900px]/scorecard:grid-cols-4">
      {tiles.map((tile) => (
        <div className={`${adminSoftPanelClassName} p-4`} key={tile.label}>
          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{tile.label}</dt>
          <dd className="mt-1 text-phx-lg font-bold text-slate-900">{tile.value}</dd>
          <p className="mt-0.5 text-phx-xs text-slate-500">{tile.hint}</p>
        </div>
      ))}
    </dl>
  );
}

function Th({ children, numeric = false }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th
      className={`px-4 py-2.5 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600 ${
        numeric ? "text-right" : "text-left"
      }`}
      scope="col"
    >
      {children}
    </th>
  );
}

function Td({ children, numeric = false }: { children: ReactNode; numeric?: boolean }) {
  return <td className={`px-4 py-3 ${numeric ? "text-right" : "text-left"}`}>{children}</td>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">{label}</dt>
      <dd className="text-phx-sm font-bold text-slate-900">{value}</dd>
    </div>
  );
}
