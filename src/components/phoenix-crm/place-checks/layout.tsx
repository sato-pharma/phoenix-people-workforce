"use client";

/**
 * Phoenix CRM — Place checks: which of a list's two layouts is drawn, the table or the phone cards.
 *
 * 🔴 EVERY ROW WAS ON THE PAGE TWICE. Each list draws its rows as cards for a phone and as a table for a
 * desktop, and until 23 Nov 2026 both were always rendered, one hidden by its width class. So every
 * photograph, piece of evidence and decision form was in the HTML and in the page twice (measured on
 * production that day: 5,937 KB of HTML, about 7,600 elements, 118 photographs for 16 waiting places and
 * their buildings). A list under this provider draws ONE of the two.
 *
 * The server cannot see the screen, so the page hands in a guess from the request (`placeCheckLayoutGuess`)
 * and the browser corrects it as soon as it has read its own width. The guess is what the server drew and
 * what the browser first agrees with, so nothing is redrawn when the guess was right. A wrong guess shows
 * the right layout once the page is running; the width classes stay on both layouts, so the wrong one is
 * never seen in the meantime.
 *
 * 🔴 WITH NO PROVIDER A LIST DRAWS BOTH, exactly as before. A district manager's portal page and every
 * other screen that draws these lists is unchanged.
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import { PLACE_CHECK_TABLE_FROM_PX, type PlaceCheckLayout } from "@/lib/phoenix-crm/place-check-layout";

const WIDE = `(min-width: ${PLACE_CHECK_TABLE_FROM_PX}px)`;

const Guess = createContext<PlaceCheckLayout | null>(null);

export function PlaceCheckLayoutProvider({ children, guess }: { children: ReactNode; guess: PlaceCheckLayout }) {
  return <Guess.Provider value={guess}>{children}</Guess.Provider>;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function onThisScreen(): PlaceCheckLayout {
  return window.matchMedia(WIDE).matches ? "table" : "cards";
}

/** The one layout to draw, or "both" on a screen that was handed no guess. */
export function usePlaceCheckLayout(): PlaceCheckLayout | "both" {
  const guess = useContext(Guess);
  const seen = useSyncExternalStore(subscribe, onThisScreen, () => guess ?? "table");
  return guess === null ? "both" : seen;
}
