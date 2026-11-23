"use client";

/**
 * The Super Admin's Place checks board, with the one-by-one review handed in.
 *
 * The page is a server component and cannot pass the board a function, so this is the one client file
 * that does it. 🔴 IT IS THE ONLY WAY THE REVIEW REACHES THE BOARD: the board never imports the review,
 * so a district manager's portal page, which draws the same board in `mode="team"`, carries none of it.
 */

import type { ComponentProps, ReactNode } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { PlaceCheckDecidesProvider } from "@/components/phoenix-crm/place-check-decides";
import { PlaceCheckLayoutProvider } from "@/components/phoenix-crm/place-checks/layout";
import { PlaceReviewDeckButton } from "@/components/place-review-deck/review-deck-button";
import { ValidationReviewsBoard } from "@/components/phoenix-crm/validation-reviews-board";
import type { PlaceCheckLayout } from "@/lib/phoenix-crm/place-check-layout";
import type { DeckTab } from "@/lib/place-review-deck/slides";

type BoardProps = Omit<ComponentProps<typeof ValidationReviewsBoard>, "mode" | "reviewDeck" | "hero">;

/** The page's title band, as the words and the icon it is made of. */
type Title = { eyebrow: string; title: string; description: string; icon: ReactNode };

/**
 * The title band around the board's one line.
 *
 * 🔴 ON A PHONE IT IS THE TITLE AND THAT LINE (owner, 23 Nov 2026: "Fix speed next"). The sentence under
 * the title was two wrapped lines above the first waiting place, and the line beside it already says what
 * waits; a desktop draws the sentence as before. The classes reach the title row alone (the band's first
 * child): its second child is the hairline rule, which must keep its one pixel.
 */
function PlaceChecksTitle({ line, title }: { line: ReactNode; title: Title }) {
  return (
    <AdminPageHero
      actions={line ?? undefined}
      className="max-sm:[&_h1+p]:hidden max-sm:[&>div:first-child]:gap-2 max-sm:[&>div:first-child]:pb-2"
      description={title.description}
      eyebrow={title.eyebrow}
      icon={title.icon}
      title={title.title}
    />
  );
}

/**
 * `decides` is false for the SFE Manager (owner, 2026-11-19: "only able to recommend validation or not
 * recommend, never able to take a decision"): the board leaves out every decision control and the
 * one-by-one review, which is nothing but decisions, and draws his two recommendation buttons instead.
 *
 * 🔴 THE PAGE'S TITLE IS DRAWN HERE, AROUND THE BOARD'S TOP LINE (23 Nov 2026). The page hands the title's
 * words; the board draws "N decisions wait for you" in the band's own slot, so the number stands beside
 * the title and not 93 px under it. And the page's guess at the layout rides in the same way
 * (`place-checks/layout.tsx`): each row is drawn once, as a table or as cards.
 */
export function PlaceChecksWithDeck({
  decides,
  layout,
  openOn,
  title,
  ...board
}: BoardProps & { decides: boolean; layout: PlaceCheckLayout; openOn: DeckTab | null; title: Title }) {
  return (
    <PlaceCheckDecidesProvider decides={decides}>
      <PlaceCheckLayoutProvider guess={layout}>
        <ValidationReviewsBoard
          {...board}
          hero={(line) => <PlaceChecksTitle line={line} title={title} />}
          mode="company"
          reviewDeck={decides ? (input, rows) => <PlaceReviewDeckButton input={input} openOn={openOn} rows={rows} /> : undefined}
        />
      </PlaceCheckLayoutProvider>
    </PlaceCheckDecidesProvider>
  );
}
