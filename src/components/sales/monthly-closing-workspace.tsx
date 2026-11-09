"use client";

import { AlertTriangle, CalendarRange, CheckCircle2, Download, EyeOff, Loader2, Lock, LockOpen, RefreshCw, Send, Sparkles, Table2, Trophy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { ClosingDetailsPanel } from "@/components/sales/closing-details-panel";
import { ClosingMatrixTable } from "@/components/sales/closing-matrix-table";
import { ClosingSummaryFits } from "@/components/sales/closing-summary-fits";
import {
  MonthlyClosingFilters,
  emptyMonthlyClosingFilter,
  type MonthlyClosingFilter,
} from "@/components/sales/monthly-closing-filters";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isRepRankingLine } from "@/lib/sales/closing-rep-ranking-line";
import { monthlyClosingFilterOptions } from "@/lib/sales/monthly-closing-filter-options";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { filterMonthlyClosingMatrix } from "@/lib/sales/monthly-closing-matrix-cells";
import { ClosingPeriodSelect } from "@/components/sales/closing-period-select";
import { closingPeriodGateMessage, closingPeriodOpensOn, isClosingPeriodComplete } from "@/lib/sales/closing-period-gate";
import { describeClosingDeepLinkMiss, type ClosingDeepLinkMiss } from "@/lib/sales/closing-deep-link";
import { describeDroppedFilterChoices, narrowClosingFilterToOptions } from "@/lib/sales/closing-filter-narrowing";
import { describePeriodSelection, periodLabel } from "@/lib/sales/monthly-closing-period-merge";
import type { MonthlySourceCoverage } from "@/lib/sales/source-coverage";
import { quietSourcesSentence } from "@/lib/sales/source-quiet-periods";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxSelectClassName } from "@/components/ui/form-tokens";


type Props = {
  /**
   * Super Admin and the CEO (owner, 2026-09-14). With several months on screen, the three export
   * buttons become the CONSOLIDATED downloads — the months added together — instead of greying out.
   * The routes ask the same question server-side; this only decides what is offered.
   */
  canExportConsolidated?: boolean;
  canPublish?: boolean;
  initialCoverage?: MonthlySourceCoverage | null;
  /**
   * The ?line=/?period= this page was deep-linked with and could NOT honour — from the published-
   * closing email, a bookmark or a pasted link. The loader substitutes the newest month of the
   * first line in silence, so the substitution is stated above the matrix instead. Null when the
   * link was honoured, or when there was no link.
   */
  initialDeepLinkMiss?: ClosingDeepLinkMiss | null;
  initialError: string | null;
  initialMatrix: MonthlyClosingMatrix | null;
  /** The Office-only grid behind every "of which Office" column. Null = could not be read. */
  initialOffice?: MonthlyClosingMatrix | null;
};

type ClosingResponse = {
  coverage?: MonthlySourceCoverage | null;
  data?: MonthlyClosingMatrix;
  error?: string;
  office?: MonthlyClosingMatrix | null;
  /** Months actually read. */
  periods?: string[];
  /** Requested but unreadable — named on screen rather than silently missing from the totals. */
  skipped?: string[];
  success: boolean;
};

export function MonthlyClosingWorkspace({ canExportConsolidated = false, canPublish = false, initialCoverage = null, initialDeepLinkMiss = null, initialError, initialMatrix, initialOffice = null }: Props) {
  const [matrix, setMatrix] = useState<MonthlyClosingMatrix | null>(initialMatrix);
  const [office, setOffice] = useState<MonthlyClosingMatrix | null>(initialOffice);
  const [coverage, setCoverage] = useState<MonthlySourceCoverage | null>(initialCoverage);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingPremium, setIsExportingPremium] = useState(false);
  const [isExportingPremiumXlsx, setIsExportingPremiumXlsx] = useState(false);
  const [isExportingRepRanking, setIsExportingRepRanking] = useState(false);
  const [isExportingConsolidated, setIsExportingConsolidated] = useState(false);
  const [isExportingConsolidatedPremium, setIsExportingConsolidatedPremium] = useState(false);
  const [isExportingConsolidatedPremiumXlsx, setIsExportingConsolidatedPremiumXlsx] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState<MonthlyClosingFilter>(emptyMonthlyClosingFilter);
  const [published, setPublished] = useState<boolean | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [isLocking, setIsLocking] = useState(false);
  // The server's "already locked, by whom, when" — shown instead of an error (see toggleLock).
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  // Bumped after a Publish, whose database trigger locks the month itself: the lock state is read
  // again so the button stops offering "Lock month" for a month that is already locked.
  const [lockReadVersion, setLockReadVersion] = useState(0);
  // A ref, not the isLocking state: it is set before the first await, so a second press can never
  // send a second request while the first is still in flight, whatever React has rendered yet.
  const lockRequestInFlight = useRef(false);
  const [tab, setTab] = useState<"matrix" | "details">("matrix");
  const [skippedPeriods, setSkippedPeriods] = useState<string[]>([]);
  // Cleared the moment the reader loads anything themselves: from then on what is on screen is what
  // they asked for, and the link they arrived by is no longer what they are reading.
  const [deepLinkMiss, setDeepLinkMiss] = useState<ClosingDeepLinkMiss | null>(initialDeepLinkMiss);
  // Filter choices a refresh could not keep, by the NAME the picker showed for them.
  const [droppedFilterLabels, setDroppedFilterLabels] = useState<string[]>([]);

  const selectedLine = matrix?.line ?? "";
  const selectedPeriod = matrix?.period ?? "";
  const availableLines = matrix?.availableLines ?? [];
  const availablePeriods = matrix?.availablePeriods ?? [];

  // The months behind what is on screen. A single-month matrix has no `periods` of its own, so it
  // reads as the one month it is — the absence never means "unknown".
  const selectedPeriods = useMemo(
    () => (matrix?.periods && matrix.periods.length > 0 ? matrix.periods : matrix?.period ? [matrix.period] : []),
    [matrix],
  );
  // Publishing and locking are single-month acts by definition: a lock freezes ONE month's numbers
  // and publishing releases ONE month to the portal. Neither has a meaning over a span, so both are
  // disabled while several months are folded together rather than silently acting on the latest.
  const isMultiPeriod = selectedPeriods.length > 1;
  const periodSpan = describePeriodSelection(selectedPeriods);
  // THE CLOSING GOLDEN RULE — a month is never published during that month (owner, 2026-08-28).
  // The server refuses it regardless (publishClosing calls the same gate); this just shows the
  // reason on the button instead of letting the press come back as an error. Unpublish is never
  // blocked, so this only applies when the button would PUBLISH.
  const periodNotClosedYet = !published && !isMultiPeriod && Boolean(selectedPeriod)
    && !isClosingPeriodComplete(selectedPeriod);
  // A disabled button with only a tooltip explains nothing on a touch screen, so the reason is
  // stated on the page as well.
  const closingOpensOn = periodNotClosedYet ? closingPeriodOpensOn(selectedPeriod) : null;

  const filteredMatrix = useMemo(
    () => (matrix ? filterMonthlyClosingMatrix(matrix, filter) : null),
    [matrix, filter],
  );

  // The Office grid gets the SAME filter. Its cells are looked up by area and product code rather
  // than by position, so an unfiltered grid would still resolve each cell correctly — but its region
  // subtotals and national total would be the unfiltered ones, and "of which Office" would then
  // exceed a filtered row's own total.
  const filteredOffice = useMemo(
    () => (office ? filterMonthlyClosingMatrix(office, filter) : null),
    [office, filter],
  );

  // One plain-language sentence about completeness, or null to show nothing. Missing sources are
  // named (human names, standing rule) with their last-month scale, so "the number looks low"
  // answers itself before anyone re-checks the arithmetic.
  const coverageWarning = useMemo(() => {
    if (!coverage || !coverage.hasPrevData) return null;
    const missing = coverage.missingSources;
    const missingRegions = coverage.missingDirectRegions;
    // A month whose only absences are ones the owner declared is NOT incomplete, and saying it is
    // was the defect he had fixed on 2026-10-09. It still gets a sentence — the month genuinely is
    // lighter than the one before it — but a flat statement of fact, with no "until these arrive"
    // behind it. See the quiet-source carve-out in source-coverage.ts.
    const quiet = coverage.quietSources ?? [];
    if (missing.length === 0 && missingRegions.length === 0) {
      if (quiet.length === 0) return null;
      return `${quietSourcesSentence(coverage.period, quiet)} Every other source that fed `
        + `${coverage.prevPeriod} has filed, so this month is complete.`;
    }
    const parts: string[] = [];
    if (missing.length > 0) {
      const names = missing.slice(0, 3).map((entry) => entry.name);
      const more = missing.length - names.length;
      const scale = coverage.missingPrevValue.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      });
      parts.push(
        `${coverage.period} is missing ${missing.length} of the ${coverage.prevSourceCount} sources that fed ` +
        `${coverage.prevPeriod} — ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""} ` +
        `(${scale} EGP in ${coverage.prevPeriod}).`,
      );
    }
    if (missingRegions.length > 0) {
      parts.push(`The Direct sheet has nothing yet from ${missingRegions.map((entry) => entry.name).join(", ")}.`);
    }
    parts.push("Totals are understated until these arrive.");
    if (quiet.length > 0) parts.push(quietSourcesSentence(coverage.period, quiet));
    return parts.join(" ");
  }, [coverage]);

  // Built from the UNFILTERED matrix, and shared with the Performance Review so the two screens
  // offer the same regions, areas and products — see monthly-closing-filter-options.ts.
  const filterOptions = useMemo(() => monthlyClosingFilterOptions(matrix), [matrix]);
  const droppedFilterNotice = describeDroppedFilterChoices(droppedFilterLabels);

  useEffect(() => {
    if (!canPublish || !selectedLine || !selectedPeriod) return;
    let cancelled = false;
    void (async () => {
      try {
        const query = new URLSearchParams({ line: selectedLine, period: selectedPeriod });
        const response = await fetch(`/api/sales/monthly-closing/publish?${query.toString()}`, { cache: "no-store" });
        const payload = (await response.json()) as { published?: boolean };
        if (!cancelled) setPublished(Boolean(payload.published));
      } catch {
        if (!cancelled) setPublished(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canPublish, selectedLine, selectedPeriod]);

  useEffect(() => {
    if (!canPublish || !selectedLine || !selectedPeriod) return;
    let cancelled = false;
    void (async () => {
      try {
        const query = new URLSearchParams({ line: selectedLine, period: selectedPeriod });
        const response = await fetch(`/api/sales/monthly-closing/lock?${query.toString()}`, { cache: "no-store" });
        // A refused or failed read is UNKNOWN, never "not locked" — 2026-11-06 a database outage
        // answered this read with an error body, Boolean(undefined) turned it into "open", and the
        // screen offered "Lock month" on a month locked since 4 Nov.
        if (!response.ok) throw new Error(`Lock state could not be read (${response.status}).`);
        const payload = (await response.json()) as { locked?: boolean; lock?: { lockedAt?: string } | null };
        if (!cancelled) {
          setLocked(Boolean(payload.locked));
          setLockedAt(payload.lock?.lockedAt ?? null);
        }
      } catch {
        // Fail SAFE the same way the publish check does, and note which way "safe" points: an
        // unreadable lock state is shown as UNLOCKED, never as locked. Claiming a month is
        // protected when the check failed would be the one lie this feature cannot afford.
        if (!cancelled) {
          setLocked(null);
          setLockedAt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canPublish, selectedLine, selectedPeriod, lockReadVersion]);

  async function toggleLock() {
    if (!selectedLine || !selectedPeriod) return;
    if (lockRequestInFlight.current) return;
    lockRequestInFlight.current = true;
    const unlocking = locked === true;
    setIsLocking(true);
    setError(null);
    setLockNotice(null);
    try {
      const response = await fetch("/api/sales/monthly-closing/lock", {
        body: JSON.stringify({ line: selectedLine, period: selectedPeriod }),
        headers: { "Content-Type": "application/json" },
        method: unlocking ? "DELETE" : "POST",
      });
      if (!response.ok) {
        // The route answers { error }, so the sentence is shown, never the raw JSON around it.
        const text = await response.text();
        let message = text;
        try {
          message = String((JSON.parse(text) as { error?: unknown }).error ?? "") || text;
        } catch {
          message = text;
        }
        // The press failed, so what the button showed may be wrong too: read the lock again.
        setLockReadVersion((version) => version + 1);
        throw new Error(message || "Failed to update lock state.");
      }
      const payload = (await response.json()) as {
        alreadyLocked?: boolean;
        lock?: { lockedAt?: string } | null;
        message?: string;
      };
      setLocked(!unlocking);
      setLockedAt(unlocking ? null : payload.lock?.lockedAt || new Date().toISOString());
      // Already locked (by a Publish, another tab or an earlier press) is the state that was asked
      // for, so it is said plainly and never shown as an error.
      if (!unlocking && payload.alreadyLocked && payload.message) setLockNotice(payload.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update lock state.");
    } finally {
      lockRequestInFlight.current = false;
      setIsLocking(false);
    }
  }

  async function togglePublish() {
    if (!selectedLine || !selectedPeriod) return;
    setIsPublishing(true);
    setError(null);
    try {
      const method = published ? "DELETE" : "POST";
      const response = await fetch("/api/sales/monthly-closing/publish", {
        body: JSON.stringify({ line: selectedLine, period: selectedPeriod }),
        headers: { "Content-Type": "application/json" },
        method,
      });
      if (!response.ok) {
        // The route answers { error } — a stale city split comes back as a 409 telling the operator
        // to publish again — so the sentence is shown, never the raw JSON around it.
        const text = await response.text();
        let message = text;
        try {
          message = String((JSON.parse(text) as { error?: unknown }).error ?? "") || text;
        } catch {
          message = text;
        }
        throw new Error(message || "Failed to update publish state.");
      }
      setPublished(!published);
      // Publishing locks the month in the database (phx_freeze_published_closing), so the lock
      // button must read the lock again — left alone it still offered "Lock month", and the press
      // that followed is what failed on 2026-11-04.
      if (method === "POST") setLockReadVersion((version) => version + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update publish state.");
    } finally {
      setIsPublishing(false);
    }
  }

  /**
   * Load a line and a set of months.
   *
   * `keepFilter` is for the REFRESH button alone: same line, same months, same pickers, so the
   * region / area / product selection the reader is working in must survive. The line and month
   * selects pass nothing and still clear it — a different line offers different areas and products,
   * and a selection carried across would be meaningless rather than preserved.
   *
   * A kept filter is narrowed to what the refreshed matrix actually offers, and whatever fell out is
   * named on screen: a refresh exists because the closing can change underneath the page, and a
   * selection left pointing at an area that has just been merged away would read as an empty grid.
   */
  async function reload(line: string, periods: string[], options?: { fresh?: boolean; keepFilter?: boolean }) {
    setIsLoading(true);
    setError(null);
    // A notice about one month's lock never carries over to another.
    setLockNotice(null);
    // The reader has picked a line or a month themselves, so the arrival link's substitution notice
    // no longer describes what is on screen.
    setDeepLinkMiss(null);
    setDroppedFilterLabels([]);
    // The labels the pickers are showing RIGHT NOW, captured before the matrix is replaced — names
    // are what reach the reader, never codes (AGENTS.md §4).
    const labelsBefore = new Map(
      [...filterOptions.areas, ...filterOptions.products, ...filterOptions.regions]
        .map((option) => [option.code, option.label] as const),
    );
    const filterBefore = filter;
    try {
      const query = new URLSearchParams();
      if (line) query.set("line", line);
      // `period` stays the single-month parameter the route has always understood; `periods` is the
      // multi-month one. Sending exactly one month uses the old path, so nothing changes for the
      // reader who never opens the "Several months" side of the picker.
      if (periods.length === 1) query.set("period", periods[0]);
      else if (periods.length > 1) query.set("periods", periods.join(","));
      // Refresh always asks the database; the server may reuse a read of a few seconds ago otherwise.
      if (options?.fresh) query.set("fresh", "1");
      const response = await fetch(`/api/sales/monthly-closing?${query.toString()}`, { cache: "no-store" });
      const text = await response.text();
      const payload: ClosingResponse = text ? JSON.parse(text) : { success: response.ok };
      if (payload.success && payload.data) {
        setMatrix(payload.data);
        setOffice(payload.office ?? null);
        setCoverage(payload.coverage ?? null);
        setSkippedPeriods(payload.skipped ?? []);
        if (options?.keepFilter) {
          const narrowed = narrowClosingFilterToOptions(filterBefore, monthlyClosingFilterOptions(payload.data));
          setFilter(narrowed.filter);
          setDroppedFilterLabels(narrowed.droppedCodes.map((code) => labelsBefore.get(code) ?? code));
        } else {
          setFilter(emptyMonthlyClosingFilter);
        }
      } else {
        setError(payload.error ?? "Failed to load Monthly Closing.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load Monthly Closing.");
    } finally {
      setIsLoading(false);
    }
  }

  /**
   * Ask one export route for its workbook and hand it to the browser.
   *
   * TWO buttons share this: the closing's own workbook and the premium one beside it. They differ
   * only in the route they call, so the selection they send, the errors they surface and the name
   * the file lands under cannot drift apart. Both send the ON-SCREEN filter, because a workbook that
   * quietly covered the whole line while the screen showed one region is the usual reason a report
   * and its export disagree.
   */
  async function runExport(input: {
    /** Anything the route needs beyond the selection — today only `macros: false`. */
    body?: Record<string, unknown>;
    fallbackName: string;
    setBusy: (busy: boolean) => void;
    url: string;
  }) {
    if (!selectedLine || !selectedPeriod) return;
    input.setBusy(true);
    try {
      const response = await fetch(input.url, {
        body: JSON.stringify({
          areaCodes: filter.areaCodes,
          line: selectedLine,
          period: selectedPeriod,
          productCodes: filter.productCodes,
          regionCodes: filter.regionCodes,
          search: filter.search,
          // Spread last so a caller's own field wins, and never the other way round: the selection
          // is what every export agrees on, the extras are what one of them asks for on top.
          ...input.body,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(payload?.error ?? payload?.message ?? "Export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? input.fallbackName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      input.setBusy(false);
    }
  }

  /** The closing's own workbook: matrix, distributor comparison, store split, and the invoice rows. */
  async function handleExport() {
    await runExport({
      fallbackName: "phoenix-monthly-closing.xlsx",
      setBusy: setIsExporting,
      url: "/api/sales/monthly-closing/export",
    });
  }

  /**
   * The premium workbook, added 2026-08-30 at the owner's instruction as a SECOND button rather than
   * a replacement, so both formats stay available and the reader picks whichever they read more
   * comfortably. Same line, same month, same filter, same numbers.
   *
   * What comes back is the owner's OWN .xlsm engine with the month written into it -- its Excel
   * Tables, pivots, slicers and the Rep Card's formulas all live -- plus the pages that were added
   * to it: Watch List, Top Customers, Details and Family by Month. Thirteen sheets. It serves as
   * .xlsm, so the owner's button bar is live -- Export PDF, Refresh, Expand/Collapse all, Reset
   * filters and the region buttons. Export PDF has no macro-free equivalent inside a workbook and
   * a .xlsx holds no code at all, so buttons and extension are one decision, not two. Pass
   * `macros: false` for the plain .xlsx, which removes the buttons rather than ship dead ones.
   */
  async function handlePremiumExport() {
    await runExport({
      fallbackName: "phoenix-monthly-closing-premium.xlsm",
      setBusy: setIsExportingPremium,
      url: "/api/sales/monthly-closing/premium-export",
    });
  }

  /**
   * The same premium workbook, macro-free.
   *
   * WITHOUT THIS BUTTON THE .xlsx WAS REACHABLE BY NOBODY. `macros: false` has been supported by the
   * route since the macro-free build shipped, but this screen never sent it, so every download was
   * the .xlsm and the only way to obtain the .xlsx was to call the API by hand. A capability nothing
   * can reach is indistinguishable from one that was never built.
   *
   * It is the file to SEND. Mail systems strip .xlsm attachments, and Windows blocks macros in
   * anything that arrived from a browser or an inbox — so the reader of a forwarded .xlsm gets a
   * security bar and dead buttons. The .xlsx has no such problem, and since 2026-09-05 it carries a
   * working button bar of its own: Export PDF, and a navigation bar, both built as hyperlinks, which
   * is the one control the format allows. What it cannot have is Expand, Collapse, Refresh and Reset
   * — those run Excel commands, and only the .xlsm can do that.
   */
  async function handlePremiumXlsxExport() {
    await runExport({
      body: { macros: false },
      fallbackName: "phoenix-monthly-closing-premium.xlsx",
      setBusy: setIsExportingPremiumXlsx,
      url: "/api/sales/monthly-closing/premium-export",
    });
  }

  /**
   * THE REP RANKING WORKBOOK — a dressed line's own sheet, as a download of its own.
   *
   * Owner, 2026-10-13, asked how to get it "from admin account" and chose to add a button rather
   * than reach it another way. It had become unreachable here by accident: the closing export route
   * decides by ROLE before it reaches its rep-ranking branch, so Super Admin, SFE Manager, CEO,
   * Finance Manager and the Marketing Manager — everyone who runs this screen — were handed the
   * full six-sheet workbook instead. The button calls a route of its own, beside the frozen one,
   * which asks the SAME builder for the SAME file the portal sends.
   *
   * ANTI INFECTIVE ONLY, and the button is absent on every other line rather than disabled: the
   * workbook does not exist for CNS or Pedia, and a greyed-out control invites a click that can
   * never succeed. The route refuses the other lines independently, by the same single gate.
   *
   * The on-screen filter travels with it, as `runExport` sends it to every export, and since
   * 2026-10-13 it NARROWS THE FILE — owner: "it's supposed to follow my filter. No, it did not
   * follow my filter. All the shit is exported." Both halves take it together, so the channel split
   * can no longer shrink underneath a ranking that did not move: the rows are filtered by the
   * route, the matrices by the builder, and a narrowed file says which rectangle it is on its own
   * Ranking heading and on Trust.
   */
  async function handleRepRankingExport() {
    await runExport({
      fallbackName: "phoenix-monthly-closing-rep-ranking.xlsx",
      setBusy: setIsExportingRepRanking,
      url: "/api/sales/monthly-closing/rep-ranking-export",
    });
  }

  /**
   * CONSOLIDATED downloads — the months on screen added together into one file. Owner, 2026-09-14:
   * Super Admin and the CEO only, in both the closing's own workbook and the premium one. Each goes
   * through `runExport`, so the on-screen filter travels with it exactly as it does for one month;
   * `periods` is the extra the consolidated routes read, and the months are worked out one by one on
   * the server before they are added.
   */
  async function handleConsolidatedExport() {
    await runExport({
      body: { periods: selectedPeriods },
      fallbackName: "phoenix-monthly-closing-consolidated.xlsx",
      setBusy: setIsExportingConsolidated,
      url: "/api/sales/monthly-closing/consolidated-export",
    });
  }

  async function handleConsolidatedPremiumExport() {
    await runExport({
      body: { periods: selectedPeriods },
      fallbackName: "phoenix-monthly-closing-premium-consolidated.xlsm",
      setBusy: setIsExportingConsolidatedPremium,
      url: "/api/sales/monthly-closing/consolidated-premium-export",
    });
  }

  async function handleConsolidatedPremiumXlsxExport() {
    await runExport({
      body: { macros: false, periods: selectedPeriods },
      fallbackName: "phoenix-monthly-closing-premium-consolidated.xlsx",
      setBusy: setIsExportingConsolidatedPremiumXlsx,
      url: "/api/sales/monthly-closing/consolidated-premium-export",
    });
  }

  // With several months on screen the single-month buttons cannot act, so for the two roles allowed
  // a consolidated file they give way to the consolidated ones. Everyone else keeps the greyed-out
  // buttons and their explanation, unchanged.
  const showConsolidatedExports = isMultiPeriod && canExportConsolidated;
  const isExportingAnyConsolidated =
    isExportingConsolidated || isExportingConsolidatedPremium || isExportingConsolidatedPremiumXlsx;
  // The rep ranking button, on the one line that has that workbook. Asked here with the same
  // function the route asks, so the screen and the server can never give two answers about which
  // line it is — see closing-rep-ranking-line.ts.
  const showRepRankingExport = isRepRankingLine(selectedLine);
  const isExportingAnySingleMonth =
    isExporting || isExportingPremium || isExportingPremiumXlsx || isExportingRepRanking;

  if (initialError && !matrix) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-phx-paper p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const selectClassName  = phxSelectClassName;

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Line: {selectedLine || "None"}</AdminInsightChip>
            <AdminInsightChip>{isMultiPeriod ? "Months" : "Month"}: {periodSpan || "No validated data"}</AdminInsightChip>
            <AdminInsightChip tone="slate">Products: {filteredMatrix?.columns.length ?? 0}</AdminInsightChip>
            {canPublish && locked ? (
              <AdminInsightChip tone="orange">Locked — numbers frozen</AdminInsightChip>
            ) : null}
            {canPublish && closingOpensOn ? (
              <AdminInsightChip tone="orange">
                {periodLabel(selectedPeriod)} is still running — closing opens {closingOpensOn}
              </AdminInsightChip>
            ) : null}
            {canPublish && published !== null ? (
              <AdminInsightChip tone={published ? "orange" : "slate"}>
                {published ? "Published to portal" : "Not published"}
              </AdminInsightChip>
            ) : (
              <AdminInsightChip tone="orange">Sales from uploaded distributor sheets</AdminInsightChip>
            )}
          </>
        )}
        description="Sales vs target closing per area and region, rolled up to national. Publish a month to release it to the employee portal."
        eyebrow="Monthly Closing"
        icon={<CalendarRange className="h-4 w-4" />}
        title="Monthly Closing"
      />

      <AdminTableShell
        action={(
          // Six controls, ~750 px if they insist on one line. They have to be able to
          // fold onto a second, or this toolbar takes the whole header row and leaves
          // the "Closing Matrix" title nothing — see AdminSectionHeader.
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">Line</span>
              <SearchableSelect
                className={selectClassName}
                disabled={isLoading || availableLines.length === 0}
                onChange={(event) => void reload(event.target.value, selectedPeriods)}
                value={selectedLine}
              >
                {availableLines.length === 0 ? (
                  <option value="">No products</option>
                ) : (
                  availableLines.map((line) => (
                    <option key={line} value={line}>{line}</option>
                  ))
                )}
              </SearchableSelect>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">
                {isMultiPeriod ? "Months" : "Month"}
              </span>
              <ClosingPeriodSelect
                availablePeriods={availablePeriods}
                disabled={isLoading || availablePeriods.length === 0}
                onChange={(periods) => void reload(selectedLine, periods)}
                value={selectedPeriods}
              />
            </label>
            <Button
              className="gap-2"
              disabled={isLoading}
              // Same line, same months: the reader's region / area / product filter survives the
              // press. Only the two selects above clear it, where the options themselves change.
              onClick={() => void reload(selectedLine, selectedPeriods, { fresh: true, keepFilter: true })}
              variant="secondary"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            {canPublish ? (
              <Button
                className="gap-2"
                disabled={isLocking || isMultiPeriod || !selectedLine || !selectedPeriod}
                onClick={() => void toggleLock()}
                title={
                  isMultiPeriod
                    ? `Locking freezes ONE month. Pick a single month to lock — ${periodSpan} is several.`
                    : locked
                      ? `Locked${lockedAt ? ` ${new Date(lockedAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })}` : ""} — nothing can change this month's numbers, including imports and direct database work. Click to unlock.`
                      : "Freeze this month so nothing can change its numbers afterwards — imports, migrations and direct database work included."
                }
                variant={locked ? "default" : "secondary"}
              >
                {isLocking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : locked ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <LockOpen className="h-4 w-4" />
                )}
                {locked ? "Locked" : "Lock month"}
              </Button>
            ) : null}
            {canPublish ? (
              <Button
                className="gap-2"
                disabled={isPublishing || isMultiPeriod || periodNotClosedYet || !selectedLine || !selectedPeriod}
                onClick={() => void togglePublish()}
                title={
                  isMultiPeriod
                    ? `Publishing releases ONE month to the portal. Pick a single month — ${periodSpan} is several.`
                    : periodNotClosedYet
                      ? closingPeriodGateMessage(selectedPeriod)
                      : undefined
                }
                variant={published ? "secondary" : "default"}
              >
                {isPublishing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : published ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {published ? "Unpublish" : "Publish to portal"}
              </Button>
            ) : null}
          </div>
        )}
        description="Areas grouped by region with region subtotals and a national grand total. Each area is counted once — region and national rows are roll-ups of the areas."
        title="Closing Matrix"
      >
        {error ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          </div>
        ) : !filteredMatrix || availablePeriods.length === 0 ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>No validated Source of Sales data yet. Upload and validate distributor sheets first.</p>
            </AdminCallout>
          </div>
        ) : (
          <>
            {canPublish && published ? (
              <div className="flex items-center gap-2 border-b border-emerald-100 bg-emerald-50/60 px-4 py-2.5 text-xs font-semibold text-emerald-700 md:px-5">
                <CheckCircle2 className="h-4 w-4" />
                This month is published — sales managers and product managers can see it in their portal (scoped to their line / products).
              </div>
            ) : null}
            {canPublish && lockNotice ? (
              <div className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50/60 px-4 py-2.5 text-xs font-semibold text-emerald-700 md:px-5">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{lockNotice}</p>
              </div>
            ) : null}
            {/* The link that opened this page asked for a line or a month the closing does not
                have, and the loader substituted the newest month of the first line. What is on
                screen is a real closing — just not the one that was asked for, which is the one
                thing a reader cannot see for themselves. */}
            {deepLinkMiss ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs font-semibold text-amber-800 md:px-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{describeClosingDeepLinkMiss(deepLinkMiss, { line: selectedLine, period: selectedPeriod })}</p>
              </div>
            ) : null}
            {/* A refresh kept the reader's filter, but the closing had changed under it: whatever it
                could no longer honour is named here rather than dropped quietly. */}
            {droppedFilterNotice ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs font-semibold text-amber-800 md:px-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{droppedFilterNotice}</p>
              </div>
            ) : null}
            {coverageWarning ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs font-semibold text-amber-800 md:px-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{coverageWarning}</p>
              </div>
            ) : null}
            {/* A requested month the closing could not read is NAMED, never dropped quietly — the
                totals below would otherwise cover fewer months than the picker says they do. */}
            {skippedPeriods.length > 0 ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs font-semibold text-amber-800 md:px-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  {skippedPeriods.map((period) => periodLabel(period)).join(", ")}
                  {skippedPeriods.length === 1 ? " has no closing data, so it is" : " have no closing data, so they are"}
                  {" not in the figures below."}
                </p>
              </div>
            ) : null}
            {/* Matrix = the published headline. Details = the invoice lines underneath it,
                so the arithmetic can be checked without leaving the page. */}
            <div className="flex items-center gap-1 border-b border-slate-100 px-4 pt-3 md:px-5">
              {([
                { icon: <CalendarRange className="h-4 w-4" />, key: "matrix" as const, label: "Closing Matrix" },
                { icon: <Table2 className="h-4 w-4" />, key: "details" as const, label: "Details" },
              ]).map((entry) => (
                <button
                  className={cn(
                    "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-bold transition",
                    tab === entry.key
                      ? "border-phx-accent text-[#0B0B0B]"
                      : "border-transparent text-slate-500 hover:text-slate-800",
                  )}
                  key={entry.key}
                  onClick={() => setTab(entry.key)}
                  type="button"
                >
                  {entry.icon}
                  {entry.label}
                </button>
              ))}
            </div>

            {tab === "matrix" ? (
              <>
                <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-5">
                  <MonthlyClosingFilters
                    areas={filterOptions.areas}
                    onChange={setFilter}
                    products={filterOptions.products}
                    regions={filterOptions.regions}
                    value={filter}
                  />
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                    {/* Three workbooks of the same month, side by side — four on a line that also has the rep
                        ranking sheet, which is Anti Infective, CNS and Pedia. The owner's instruction (2026-08-30) was that the premium sheet be
                        added BESIDE this button rather than replacing it, so whoever is reading picks the format
                        they read more comfortably. All of them carry the same line and the same month.

                        🔴 `shrink-0` CAME OFF THIS ROW WHEN THE FOURTH BUTTON WENT ON (2026-10-13), and that is
                        the fits-the-screen rule rather than tidying. A flex item with `shrink-0` is never handed
                        a width narrower than its content, so a `flex-wrap` on that same element never fires —
                        the row just grows past its parent and the page scrolls sideways (see
                        tests/flex-wrap-shrink-guard.test.ts, which exists because of exactly that). Three buttons
                        measure about 530px and fitted; the fourth takes the row past 730px, which is wider than
                        the panel at 640 and 768. With `shrink-0` gone and `flex-wrap` on, the buttons drop onto a
                        second line instead and the document never exceeds the viewport. Each BUTTON keeps its own
                        `shrink-0`, which is correct inside a row that wraps — it stops the labels being squeezed.
                        Above 1024 there is room for one line and nothing moved.

                        THE RECORD FROM WHEN THERE WERE THREE, which is what changed above: `shrink-0` was kept
                        then, and the third button was measured against it rather than assumed to break it — a
                        pinned wrapper is the usual cause of a page scrolling sideways, so it was the thing to
                        check. It did not happen with three: at 700, 768, 900, 1024 and 1280 the document never
                        exceeded the viewport and the row stayed on ONE line, because the FILTERS beside it wrapped
                        instead. Letting the buttons wrap was tried and reverted then — it broke the row into two
                        lines from 768 up for no gain. The gain exists now: four buttons no longer fit a line the
                        filters can give back. At 375 everything stacks, as it always did. Measured with the real
                        filter markup: an early harness used `w-44` selects in place of the real content-sized
                        `<details>` and manufactured an overflow that does not exist. */}
                    {showConsolidatedExports ? (
                      <>
                        <button
                          className={cn(
                            "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50",
                          )}
                          disabled={isExportingAnyConsolidated || filteredMatrix.columns.length === 0}
                          onClick={() => void handleConsolidatedExport()}
                          title={`One closing workbook for ${periodSpan}, the months added together. Each month is worked out on its own, store split included, and only then added.`}
                          type="button"
                        >
                          {isExportingConsolidated ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          Consolidated XLSX
                        </button>
                        <button
                          className={cn(
                            "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-white px-4 text-sm font-bold text-[#0B0B0B] transition hover:border-phx-accent hover:bg-phx-accent hover:text-white disabled:opacity-50",
                          )}
                          disabled={isExportingAnyConsolidated || filteredMatrix.columns.length === 0}
                          onClick={() => void handleConsolidatedPremiumExport()}
                          title={`The premium workbook for ${periodSpan}, the months added together. There is no prior-month comparison: a span of months has no single month before it.`}
                          type="button"
                        >
                          {isExportingConsolidatedPremium ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                          Consolidated Premium XLSM
                        </button>
                        <button
                          className={cn(
                            "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-white px-4 text-sm font-bold text-[#0B0B0B] transition hover:border-phx-accent hover:bg-phx-accent hover:text-white disabled:opacity-50",
                          )}
                          disabled={isExportingAnyConsolidated || filteredMatrix.columns.length === 0}
                          onClick={() => void handleConsolidatedPremiumXlsxExport()}
                          title={`The same consolidated premium workbook for ${periodSpan}, without macros — the one to send.`}
                          type="button"
                        >
                          {isExportingConsolidatedPremiumXlsx ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                          Consolidated Premium XLSX
                        </button>
                      </>
                    ) : (
                    <>
                    <button
                      className={cn(
                        "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50",
                      )}
                      disabled={isExportingAnySingleMonth || isMultiPeriod || filteredMatrix.columns.length === 0}
                      onClick={() => void handleExport()}
                      title={
                        isMultiPeriod
                          ? `This workbook carries the month's own invoice rows on its Data sheet, which is built one month at a time — so it cannot yet cover ${periodSpan}. Pick a single month to export, or use the Performance Review's export, which covers the whole selection.`
                          : "The full closing workbook: the matrix, the distributor comparison, the store split, and every invoice row behind them."
                      }
                      type="button"
                    >
                      {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Export XLSX
                    </button>
                    <button
                      className={cn(
                        "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-white px-4 text-sm font-bold text-[#0B0B0B] transition hover:border-phx-accent hover:bg-phx-accent hover:text-white disabled:opacity-50",
                      )}
                      disabled={isExportingAnySingleMonth || isMultiPeriod || filteredMatrix.columns.length === 0}
                      onClick={() => void handlePremiumExport()}
                      title={
                        isMultiPeriod
                          ? `This workbook is built one month at a time, so it cannot yet cover ${periodSpan}. Pick a single month to export it.`
                          : "The same month, read the other way: an overview, the rep and district-manager rankings, top achievers, the watch list, both matrices with each region foldable, area by product, the families and the biggest customers."
                      }
                      type="button"
                    >
                      {isExportingPremium ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      Export Premium XLSM
                    </button>
                    <button
                      className={cn(
                        "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-white px-4 text-sm font-bold text-[#0B0B0B] transition hover:border-phx-accent hover:bg-phx-accent hover:text-white disabled:opacity-50",
                      )}
                      disabled={isExportingAnySingleMonth || isMultiPeriod || filteredMatrix.columns.length === 0}
                      onClick={() => void handlePremiumXlsxExport()}
                      title={
                        isMultiPeriod
                          ? `This workbook is built one month at a time, so it cannot yet cover ${periodSpan}. Pick a single month to export it.`
                          : "The same premium workbook without macros — this is the one to send. Mail systems strip .xlsm attachments and Windows blocks macros in anything that arrived from an inbox. Export PDF and the navigation bar still work here, as hyperlinks; Expand, Collapse, Refresh and Reset need the .xlsm."
                      }
                      type="button"
                    >
                      {isExportingPremiumXlsx ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Export Premium XLSX
                    </button>
                    </>
                    )}
                    {/* THE DRESSED LINES ONLY (Anti Infective, CNS, Pedia) — absent on a line with no dress
                        rather than greyed out, because the workbook does not exist for it and a disabled
                        control invites a click that can never succeed. The route refuses the other lines
                        independently, by the same single gate.

                        🔴 DRAWN AFTER THE SINGLE-MONTH / CONSOLIDATED SPLIT, NEVER INSIDE IT (owner, 2026-10-13:
                        "still no Export Rep Ranking button on Pedia"). It used to sit in the single-month
                        fragment, so the moment two or more months were picked — which is the first thing a
                        screen shows once July, August and September are all published — the row swapped to the
                        three Consolidated buttons and this one vanished with nothing saying why. It is now
                        always on a dressed line and DISABLED, with the reason in its title, across a span. */}
                    {showRepRankingExport ? (
                      <button
                        className={cn(
                          "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-white px-4 text-sm font-bold text-[#0B0B0B] transition hover:border-phx-accent hover:bg-phx-accent hover:text-white disabled:opacity-50",
                        )}
                        disabled={isExportingAnySingleMonth || isMultiPeriod || filteredMatrix.columns.length === 0}
                        onClick={() => void handleRepRankingExport()}
                        title={
                          isMultiPeriod
                            ? `This workbook is built one month at a time, so it cannot yet cover ${periodSpan}. Pick a single month to export it.`
                            : "The rep ranking sheet this line's portal sends, in the line's own identity — the reps arranged by achievement with their district manager, the three-month trend, the warehouse carve, every counted row and the Trust sheet behind every figure. The same file, read from here. It covers the whole month rather than the filter on screen, because its ranking and its channel split come from different reads."
                        }
                        type="button"
                      >
                        {isExportingRepRanking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trophy className="h-4 w-4" />}
                        Export Rep Ranking
                      </button>
                    ) : null}
                  </div>
                </div>
                {/* Owner decision (2026-08-08): this screen must match the exported workbook, so
                    it now carries the same store split the export always applied — see
                    loadMonthlyClosingWithStoreSplit. The workbook still has its own Store Split
                    audit tab naming exactly which stores moved where. */}
                <div className="border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500 md:px-5">
                  Store sales are shared across their city&apos;s areas — this matrix and the exported workbook show the same numbers.
                </div>
                {/* BESIDE the matrix, never instead of it. The full product matrix cannot fit a
                    screen — CNS measures ~9,600px against a 1,144px container, which is 29px per
                    product — so it keeps its scroll and its role as the auditor's detail view, and
                    this fitting family-grain summary sits above it. Both are folded from the SAME
                    matrix object, so they cannot disagree. */}
                <ClosingSummaryFits matrix={filteredMatrix} />
                <ClosingMatrixTable matrix={filteredMatrix} office={filteredOffice} />
              </>
            ) : (
              <ClosingDetailsPanel
                line={selectedLine}
                period={selectedPeriod}
                // The matrix's own months. Several of them and these rows are ONE of them — the last
                // of the span, which is what mergeMonthlyClosingPeriods leaves in `matrix.period` —
                // so the panel says so rather than letting the two tabs look as if they disagree.
                periodsInView={selectedPeriods}
                showConfidentialToggle
              />
            )}
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
