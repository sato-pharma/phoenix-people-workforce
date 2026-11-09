"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  TerritoryAreaPayload,
  TerritoryClosingTotals,
  TerritorySkeleton,
} from "@/lib/sales/territory/types";
import { areaLoadFailedText } from "@/lib/sales/territory/drilldown-words";

export type AreaFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; payload: TerritoryAreaPayload };

export type UseTerritoryTreeResult = {
  skeleton: TerritorySkeleton;
  periods: string[];
  areaState: (areaCode: string) => AreaFetchState;
  loadArea: (areaCode: string) => void;
  /** Region and area totals from the closing engine (published months only); null until loaded,
   *  and stays null if the read fails — a header then shows no figure, never a false zero. */
  closingTotals: TerritoryClosingTotals | null;
};

/**
 * The one shared fetch/expand/cache pipeline behind both the desktop and mobile renderers —
 * they mount simultaneously (CSS-toggled) and both call this same hook instance, so an area
 * expanded on one layout stays loaded if the viewport crosses the breakpoint.
 *
 * Fetch granularity is one Area per call (see the module design doc for why this is the right
 * lazy-load boundary): Region/Area/Block/Brick names all come from the already-loaded
 * skeleton; only the pharmacy-level data is deferred until a user expands an Area lane, and
 * that one call returns the whole area's brick -> pharmacy -> month breakdown at once.
 */
export function useTerritoryTree(skeleton: TerritorySkeleton): UseTerritoryTreeResult {
  const [states, setStates] = useState<Map<string, AreaFetchState>>(new Map());
  const [periods, setPeriods] = useState<string[]>(skeleton.window?.periods ?? []);
  // Keyed by the line it was read for, so a line switch never shows the previous line's totals.
  const [totalsRead, setTotalsRead] = useState<{ line: string; totals: TerritoryClosingTotals } | null>(null);
  const closingTotals = totalsRead && totalsRead.line === skeleton.officialLine ? totalsRead.totals : null;
  const cacheRef = useRef<Map<string, TerritoryAreaPayload>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadArea = useCallback((areaCode: string) => {
    const key = areaCode.trim().toUpperCase();
    if (!key || cacheRef.current.has(key) || inFlightRef.current.has(key)) return;

    inFlightRef.current.add(key);
    setStates((prev) => new Map(prev).set(key, { status: "loading" }));

    const controller = new AbortController();
    // Echo the skeleton's line so a Super Admin / CEO fetch stays on the line they picked (the
    // server ignores it for every other role, whose line is derived from their own scope).
    const lineParam = skeleton.officialLine ? `?line=${encodeURIComponent(skeleton.officialLine)}` : "";
    fetch(`/api/employee-portals/territory-drilldown/area/${encodeURIComponent(key)}${lineParam}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          // Auth middleware can redirect to the login page, which fetch follows and
          // returns as HTML — detect it before .json() throws a confusing parse error. The viewer
          // is told what to do, never an HTTP code.
          throw new Error(areaLoadFailedText(response.status));
        }
        const json = (await response.json()) as {
          success: boolean;
          message?: string;
          periods?: string[];
          areaCode?: string;
          bricks?: TerritoryAreaPayload["bricks"];
          reconciled?: boolean;
          totalUnits?: number;
          totalValue?: number;
        };
        if (!response.ok || !json.success) {
          throw new Error(json.message || areaLoadFailedText(response.status));
        }
        const payload: TerritoryAreaPayload = {
          areaCode: json.areaCode ?? key,
          bricks: json.bricks ?? [],
          reconciled: json.reconciled ?? false,
          totalUnits: json.totalUnits ?? 0,
          totalValue: json.totalValue ?? 0,
        };
        cacheRef.current.set(key, payload);
        if (json.periods?.length) setPeriods(json.periods);
        setStates((prev) => new Map(prev).set(key, { status: "loaded", payload }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStates((prev) =>
          new Map(prev).set(key, {
            status: "error",
            // A dropped connection (TypeError) or a broken body (SyntaxError) speaks browser, not the
            // viewer's words; only the errors thrown above carry a sentence worth showing.
            message:
              error instanceof Error && !(error instanceof TypeError) && !(error instanceof SyntaxError)
                ? error.message
                : areaLoadFailedText(null),
          }),
        );
      })
      .finally(() => {
        inFlightRef.current.delete(key);
      });
  }, [skeleton.officialLine]);

  // Totals at a glance load after first paint, once per drilled line — the page never waits on them.
  useEffect(() => {
    if (!skeleton.officialLine) return;
    const line = skeleton.officialLine;
    const controller = new AbortController();
    fetch(`/api/employee-portals/territory-drilldown/totals?line=${encodeURIComponent(skeleton.officialLine)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return;
        const json = (await response.json()) as { success?: boolean; totals?: TerritoryClosingTotals };
        if (json.success && json.totals && !controller.signal.aborted) setTotalsRead({ line, totals: json.totals });
      })
      .catch(() => {
        // A failed read leaves the headers without a total; it never shows a zero.
      });
    return () => controller.abort();
  }, [skeleton.officialLine]);

  const areaState = useCallback(
    (areaCode: string): AreaFetchState => states.get(areaCode.trim().toUpperCase()) ?? { status: "idle" },
    [states],
  );

  return { skeleton, periods, areaState, loadArea, closingTotals };
}
