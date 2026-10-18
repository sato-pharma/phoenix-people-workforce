"use client";

/**
 * The Super Admin's Place checks board, with the one-by-one review handed in.
 *
 * The page is a server component and cannot pass the board a function, so this is the one client file
 * that does it. 🔴 IT IS THE ONLY WAY THE REVIEW REACHES THE BOARD: the board never imports the review,
 * so a district manager's portal page, which draws the same board in `mode="team"`, carries none of it.
 */

import type { ComponentProps } from "react";

import { PlaceReviewDeckButton } from "@/components/place-review-deck/review-deck-button";
import { ValidationReviewsBoard } from "@/components/phoenix-crm/validation-reviews-board";
import type { DeckTab } from "@/lib/place-review-deck/slides";

type BoardProps = Omit<ComponentProps<typeof ValidationReviewsBoard>, "mode" | "reviewDeck">;

export function PlaceChecksWithDeck({ openOn, ...board }: BoardProps & { openOn: DeckTab | null }) {
  return <ValidationReviewsBoard {...board} mode="company" reviewDeck={(input) => <PlaceReviewDeckButton input={input} openOn={openOn} />} />;
}
