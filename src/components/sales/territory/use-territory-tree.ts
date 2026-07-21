"use client";

import { useCallback, useRef, useState } from "react";

import type { TerritoryAreaPayload, TerritorySkeleton } from "@/lib/sales/territory/types";

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
  const [periods, setPeriods] = useState<string[]>([]);
  const cacheRef = useRef<Map<string, TerritoryAreaPayload>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadArea = useCallback((areaCode: string) => {
    const key = areaCode.trim().toUpperCase();
    if (!key || cacheRef.current.has(key) || inFlightRef.current.has(key)) return;

    inFlightRef.current.add(key);
    setStates((prev) => new Map(prev).set(key, { status: "loading" }));

    const controller = new AbortController();
    fetch(`/api/employee-portals/territory-drilldown/area/${encodeURIComponent(key)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          // Auth middleware can redirect to the login page, which fetch follows and
          // returns as HTML — detect it before .json() throws a confusing parse error.
          throw new Error(
            response.status === 401 || response.status === 403
              ? "Session expired. Please refresh the page and sign in again."
              : `Unexpected server response (HTTP ${response.status}). Please refresh and try again.`,
          );
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
          throw new Error(json.message || "Failed to load this area.");
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
            message: error instanceof Error ? error.message : "Failed to load this area.",
          }),
        );
      })
      .finally(() => {
        inFlightRef.current.delete(key);
      });
  }, []);

  const areaState = useCallback(
    (areaCode: string): AreaFetchState => states.get(areaCode.trim().toUpperCase()) ?? { status: "idle" },
    [states],
  );

  return { skeleton, periods, areaState, loadArea };
}
