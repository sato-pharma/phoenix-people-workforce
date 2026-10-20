"use client";

import * as React from "react";

import { phxButtonPrimaryClassName } from "@/components/ui/form-tokens";
import { SEAT_VIEW_EXIT_PATH, SEAT_VIEW_PAGE_PATH } from "@/lib/auth/seat-view-constants";
import { hardNavigate } from "@/lib/navigation/browser-navigation";

// VIEW AS SEAT (src/lib/auth/seat-view.ts) — said on every page of a view, in both shells, so a view can
// never be taken for the real seat. Imports only the plain constants: nothing server-side reaches the
// browser through this file.

const endsAtFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Cairo",
});

export function SeatViewBanner({
  expiresAt,
  personName,
  seatTitle,
}: {
  /** Epoch seconds. */
  expiresAt: number;
  personName: string | null;
  seatTitle: string;
}) {
  const [leaving, setLeaving] = React.useState(false);
  const who = personName ? `${personName} · ${seatTitle}` : seatTitle;

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    try {
      await fetch(SEAT_VIEW_EXIT_PATH, { credentials: "same-origin", method: "POST" });
    } catch {
      // The exit route always clears the cookie; a dropped request still ends within the hour.
    }
    hardNavigate(SEAT_VIEW_PAGE_PATH);
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-orange-300 bg-orange-50 px-4 py-2.5 text-sm text-orange-900"
      data-seat-view-banner=""
      role="status"
    >
      <p className="min-w-0 flex-1 basis-64 leading-snug">
        <span className="font-black">{`Viewing as ${who} — read only.`}</span>{" "}
        {`Nothing here is saved, sent or decided. The view ends by itself at ${endsAtFormatter.format(new Date(expiresAt * 1000))} Cairo time.`}
      </p>
      <button className={phxButtonPrimaryClassName} disabled={leaving} onClick={leave} type="button">
        {leaving ? "Leaving the view…" : "Exit view"}
      </button>
    </div>
  );
}
