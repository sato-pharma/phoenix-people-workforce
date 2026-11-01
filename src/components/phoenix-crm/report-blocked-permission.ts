"use client";

/**
 * Phoenix CRM — reporting a permission the BROWSER blocked, so that it reaches the refused-readings
 * board instead of dying on the glass.
 *
 * 🔴 WHY THIS EXISTS AT ALL. Every other refusal on that board was decided by the server: the phone
 * sent a reading and a door turned it away. A blocked permission never produces a reading, so it
 * never reaches a door and never reached a row — on 10 and 12 October 2026 Norhan Gamal's iPhone
 * answered PERMISSION_DENIED five times, `phoenix_crm_refused_readings` held NOTHING for her seat,
 * and the only trace anywhere was the touch trail (since retired), which recorded the message only if
 * the rep happened to press it. So the one place that knows is the browser, and the browser now says so.
 *
 * 🔴 IT IS FIRE-AND-FORGET AND IT CHANGES NOTHING THE REP SEES (golden rule #1). It is called AFTER
 * the message is set, never before; it returns void, awaits nothing, throws nothing and is never on
 * the path of anything the rep is waiting for. The route answers 204 whatever happens, so there is
 * no answer worth reading either.
 *
 * `keepalive` is set because the commonest moment to be blocked is the moment a rep gives up and
 * leaves the screen — a report the browser drops at unload is a report of exactly the case this was
 * built for.
 */

import { type BlockedPermission, type RefusedSubject } from "@/lib/phoenix-crm/refused-readings-rules";

const ENDPOINT = "/api/phoenix-crm/refused-readings";

/**
 * The territory's seat, read off the path:
 * `/employee-portals/field-crm/day/<seatId>` is the only route that names one, and null everywhere
 * else is correct rather than missing — the ROUTE resolves the rep from the session.
 */
export function seatFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.indexOf("day");
  const seat = at >= 0 ? parts[at + 1] : undefined;
  return seat ? decodeURIComponent(seat) : null;
}

export function reportBlockedPermission(input: {
  permission: BlockedPermission;
  subjectKind: RefusedSubject;
  /** Passed by a screen that already holds one; otherwise it is read off the path. */
  seatId?: string | null;
  test?: boolean;
}): void {
  try {
    const seatId =
      input.seatId ?? (typeof window === "undefined" ? null : seatFromPath(window.location.pathname));
    void fetch(ENDPOINT, {
      body: JSON.stringify({
        permission: input.permission,
        subjectKind: input.subjectKind,
        seatId,
        test: input.test === true,
      }),
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => {
      // Swallowed on purpose: a report that does not arrive is a hole in a board, never a cost to
      // the rep, who is already reading his message.
    });
  } catch {
    // Same reason. Nothing this file can do is worth a second failure on a phone already refusing.
  }
}
