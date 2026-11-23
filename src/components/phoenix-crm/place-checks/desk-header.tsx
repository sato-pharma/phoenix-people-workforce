"use client";

/**
 * Phoenix CRM — Place checks: the one line at the top of the Super Admin's board.
 *
 * How many decisions wait, in one unit, from one function (`placeCheckDesk`): the number Needs You shows,
 * counted before the filters so it never moves with one. Beside it, what the number is made of, how many
 * of them one press settles, how many have waited too long, and where the SFE Manager's recommendations
 * wait. Nothing here is a second count of anything.
 *
 * 🔴 A FIGURE THAT COULD NOT BE READ SAYS SO, NEVER A ZERO. The rule that approves by itself is read by the
 * page; when that read failed the header says it could not be read.
 *
 * 🔴 IT STANDS BESIDE THE PAGE'S TITLE, NOT UNDER IT (`PlaceCheckTop`, 23 Nov 2026). As a band of its own
 * it was 77 px and a gap between the title and the tabs; the page hands the board its title band and the
 * line is drawn in that band's own slot. A board handed no band draws the line where it always stood.
 *
 * 🔴 THE SFE MANAGER'S ONES WAIT FOR THE SUPER ADMIN TOO, ON THEIR OWN PAGE (owner, 19 Nov 2026: "the
 * recommended by him goes separately in a separate page for admin decision"). The sentence said they
 * waited "on the SFE Manager's recommendation", which read as the SFE Manager's move; they already carry
 * it, and the decision is his.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { deskHeadline, deskLongWait, deskMakeUp, PLACE_CHECK_LANE_LABEL } from "@/lib/phoenix-crm/place-check-lanes";
import { signWinsSentence } from "@/lib/phoenix-crm/sign-wins-rules";

/** Said in place of the rule's own sentence when the page could not read it. */
export const SIGN_WINS_UNREAD = "Whether the system is still approving by itself could not be read just now. Nothing below depends on it.";

/**
 * Where the board's top line stands: in the page's own title band when the page handed one in (`hero`),
 * else by itself at the top of the board. The band is the page's; the line is the board's.
 */
export function PlaceCheckTop({ children, hero }: { children: ReactNode; hero: ((line: ReactNode) => ReactNode) | undefined }) {
  return <>{hero ? hero(children) : children}</>;
}

export function PlaceCheckDeskHeader({ board, review }: { board: PlaceCheckBoard; review: ReactNode }) {
  const { desk, sfeRecommended, signWins } = board;
  if (!desk) return null;
  const lanes =
    desk.decisions === 0
      ? ""
      : `${desk.ready} in ${PLACE_CHECK_LANE_LABEL.ready}, ${desk.yourCall} in ${PLACE_CHECK_LANE_LABEL.your_call}.`;
  const said = [deskMakeUp(desk), lanes].filter((part) => part !== "").join(" ");
  const long = deskLongWait(desk);
  // The rule's standing is on "Approved by the system"; the header speaks only when it is off or unread.
  const rule = signWins === undefined ? null : signWins === null ? SIGN_WINS_UNREAD : signWins.on ? null : signWinsSentence(signWins);
  return (
    <div className="min-w-0 max-w-full border border-l-4 border-slate-200 border-l-orange-500 bg-white px-4 py-2" data-desk-line>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <p className="break-words text-lg font-black text-slate-900">{deskHeadline(desk)}</p>
          {said ? <p className="mt-0.5 break-words text-sm text-slate-600">{said}</p> : null}
          {long ? <p className="mt-0.5 break-words text-sm font-black text-orange-800">{long}</p> : null}
        </div>
        {/* Beside the headline on a wide screen, under it on a narrow one: as a band of its own it stood
            40 px above the first waiting place (measured at 1440 in the preview, 23 Nov 2026). */}
        {sfeRecommended && sfeRecommended.count > 0 ? (
          <p className="min-w-0 max-w-full flex-1 basis-64 break-words text-sm text-slate-700" data-desk-sfe>
            {sfeRecommended.count} more {sfeRecommended.count === 1 ? "has" : "have"} the SFE Manager&apos;s recommendation and {sfeRecommended.count === 1 ? "waits" : "wait"} for your decision on their own page.{" "}
            <Link className="font-black text-slate-900 underline underline-offset-2" href={sfeRecommended.href}>
              Open SFE recommendations
            </Link>
          </p>
        ) : null}
        {review}
      </div>
      {rule ? <p className="mt-2 break-words border-t border-slate-100 pt-2 text-sm text-slate-700">{rule}</p> : null}
    </div>
  );
}
