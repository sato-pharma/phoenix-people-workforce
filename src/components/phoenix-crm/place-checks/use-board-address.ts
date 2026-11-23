"use client";

/**
 * Phoenix CRM — Place checks: the board's view, kept in the address (`place-check-address.ts`).
 *
 * On the first paint the board reads the address once and opens what it names; from then on every change
 * of tab, filter or page is written back with `history.replaceState`, which moves no history entry and
 * asks the server for nothing. The filters that name a person stay in the session store.
 */

import { useEffect, useRef } from "react";

import {
  parsePlaceCheckAddress,
  parsePrivateFilters,
  PLACE_CHECK_PRIVATE_STORE_KEY,
  placeCheckAddressSearch,
  privateFiltersText,
  type PlaceCheckAddress,
} from "@/lib/phoenix-crm/place-check-address";
import type { ValidationReviewFilters } from "@/lib/phoenix-crm/validation-review-filters";

/** The session store, or null where the browser refuses it (a private window, a blocked store). */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function usePlaceCheckAddress({
  apply,
  chip,
  filters,
  rows,
  tab,
}: {
  /** Called once, after the first paint, with what the address and the session store held. */
  apply: (address: PlaceCheckAddress, kept: Pick<ValidationReviewFilters, "rep" | "decider" | "text">) => void;
  /** The narrowing of Not confirmed, or null while it is the default. */
  chip: string | null;
  filters: ValidationReviewFilters;
  /** How far the open tab's first list is open, or null on its first page. */
  rows: number | null;
  /** The tab he chose, or null while the board is on the tab it opens on by itself. */
  tab: string | null;
}) {
  const applyOnce = useRef(apply);
  const mounted = useRef(false);

  useEffect(() => {
    let kept: string | null = null;
    try {
      kept = sessionStore()?.getItem(PLACE_CHECK_PRIVATE_STORE_KEY) ?? null;
    } catch {
      kept = null;
    }
    applyOnce.current(parsePlaceCheckAddress(window.location.search), parsePrivateFilters(kept));
  }, []);

  const { area, decider, line, list, outcome, period, region, rep, text } = filters;
  useEffect(() => {
    // The first paint only reads: writing here would replace the address before what it names is applied.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const search = placeCheckAddressSearch(window.location.search, { tab, chip, rows, filters: { outcome, period, line, region, area, list } });
    if (search !== window.location.search) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    }
    try {
      const store = sessionStore();
      const privately = privateFiltersText({ rep, decider, text });
      if (privately === null) store?.removeItem(PLACE_CHECK_PRIVATE_STORE_KEY);
      else store?.setItem(PLACE_CHECK_PRIVATE_STORE_KEY, privately);
    } catch {
      // A full or refused store loses nothing but the reload's memory of three filters.
    }
  }, [tab, chip, rows, outcome, period, line, region, area, list, rep, decider, text]);
}
