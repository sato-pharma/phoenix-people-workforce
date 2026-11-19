"use client";

/**
 * The Super Admin's Place checks board, with the one-by-one review handed in.
 *
 * The page is a server component and cannot pass the board a function, so this is the one client file
 * that does it. 🔴 IT IS THE ONLY WAY THE REVIEW REACHES THE BOARD: the board never imports the review,
 * so a district manager's portal page, which draws the same board in `mode="team"`, carries none of it.
 */

import type { ComponentProps } from "react";

import { PlaceCheckDecidesProvider } from "@/components/phoenix-crm/place-check-decides";
import { PlaceReviewDeckButton } from "@/components/place-review-deck/review-deck-button";
import { ValidationReviewsBoard } from "@/components/phoenix-crm/validation-reviews-board";
import type { DeckTab } from "@/lib/place-review-deck/slides";

type BoardProps = Omit<ComponentProps<typeof ValidationReviewsBoard>, "mode" | "reviewDeck">;

/**
 * `decides` is false for the SFE Manager (owner, 2026-11-19: "only able to recommend validation or not
 * recommend, never able to take a decision"): the board leaves out every decision control and the
 * one-by-one review, which is nothing but decisions, and draws his two recommendation buttons instead.
 */
export function PlaceChecksWithDeck({ decides, openOn, ...board }: BoardProps & { decides: boolean; openOn: DeckTab | null }) {
  return (
    <PlaceCheckDecidesProvider decides={decides}>
      <ValidationReviewsBoard
        {...board}
        mode="company"
        reviewDeck={decides ? (input, rows) => <PlaceReviewDeckButton input={input} openOn={openOn} rows={rows} /> : undefined}
      />
    </PlaceCheckDecidesProvider>
  );
}
