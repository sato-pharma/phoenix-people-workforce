// Recruitment / ATS — the screening list and a CV's own tab, telling the same story.
//
// Pressing a CV in the screening list opens it on a page of its own, in a new tab. The owner,
// 2026-09-18: "when i view cv and pushed to the end of the screen and i really hustle to go back
// where i where why not when i press on the cv i am redirected into a new tab and page with full
// details". The list tab stays exactly where it was — that is the point of the new tab.
//
// But the list tab was loaded BEFORE the verdict. Without this, a CV shortlisted in its own tab
// went on reading "New" in the list the reader came back to, and the natural next move — open it
// again to check — is the wasted CV this whole change exists to remove. Worse, the list tab's
// send guard (one notification per manager per CV) could not see a send made in the other tab, so
// the same CV could reach the same manager twice.
//
// So every workstation REPORTS what it just wrote, once the server has confirmed it, and every
// other workstation in this browser records it exactly as if it had been done there: the row wears
// the verdict, the star, the "sent" line and the note count. A message is a report of a write that
// already happened — nothing here ever writes to the server, and a tab can never ask another to.
//
// SAME BROWSER ONLY, which is the honest scope: a BroadcastChannel never leaves it. Another
// screener's browser learns on reload, exactly as it always has.
//
// Pure apart from the channel itself, and imported by a "use client" component — so, like
// candidate-status.ts and candidate-rating.ts beside it, nothing here may reach a database.

import { isCandidateRating, type CandidateRating } from "@/lib/recruitment/candidate-rating";
import { isCandidateStatus, type CandidateStatus } from "@/lib/recruitment/candidate-status";

/** One name for every screening tab in this browser — admin shell and portal shell alike. */
export const SCREENING_TAB_CHANNEL = "phoenix.screening.tabs";

/**
 * What one tab tells the others. Each is a write the server has ALREADY confirmed.
 *
 * `sent` carries the managers' hr ids as well as their names: the names are what the row prints,
 * the ids are what the receiving tab's send guard is keyed on. The ids never reach the screen.
 */
export type ScreeningTabMessage =
  | { kind: "decided"; id: string; status: CandidateStatus; note: string | null }
  | { kind: "rated"; id: string; rating: CandidateRating | null }
  | { kind: "sent"; id: string; names: string; managerHrIds: string[] }
  | { kind: "notes"; id: string; count: number };

export type ScreeningTabChannel = {
  post: (message: ScreeningTabMessage) => void;
  close: () => void;
};

/**
 * A message out of anything — whatever arrives on the channel is checked, never trusted.
 *
 * The channel is same-origin by construction, so the realistic sender is this code in another tab.
 * It is still parsed field by field: the day an older tab and a newer deploy are open side by side,
 * a shape one of them does not know must be dropped, not half-applied. ANYTHING UNRECOGNISED IS
 * null, which is the rule every parser in this module family follows.
 *
 * A star of `null` is a real message — the star was taken OFF — so it is told apart from a star
 * that is simply malformed, which `parseCandidateRating` alone would collapse into the same null.
 */
export function parseScreeningTabMessage(data: unknown): ScreeningTabMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  const id = message.id;
  if (typeof id !== "string" || id.trim() === "") return null;

  switch (message.kind) {
    case "decided": {
      const { note, status } = message;
      if (!isCandidateStatus(status)) return null;
      if (note !== null && typeof note !== "string") return null;
      return { id, kind: "decided", note, status };
    }
    case "rated": {
      const { rating } = message;
      if (rating !== null && !isCandidateRating(rating)) return null;
      return { id, kind: "rated", rating };
    }
    case "sent": {
      const { managerHrIds, names } = message;
      if (typeof names !== "string" || names.trim() === "") return null;
      if (!Array.isArray(managerHrIds) || !managerHrIds.every((hrId) => typeof hrId === "string" && hrId !== "")) {
        return null;
      }
      return { id, kind: "sent", managerHrIds: [...managerHrIds], names };
    }
    case "notes": {
      const { count } = message;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
      return { count, id, kind: "notes" };
    }
    default:
      return null;
  }
}

/**
 * Join the channel. Null where the browser has none — the page then works exactly as it did before
 * this existed, and the other tab simply learns on reload.
 *
 * A channel never hears its OWN posts (the HTML spec delivers to every other object of that name),
 * so a tab applying what it just wrote cannot loop back into itself. Posting is wrapped because it
 * can throw on a closed channel, and a report that failed to go out must never fail the write it
 * reports — that write is already on the record.
 */
export function openScreeningTabChannel(
  onMessage: (message: ScreeningTabMessage) => void,
): ScreeningTabChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(SCREENING_TAB_CHANNEL);
  } catch {
    return null;
  }
  channel.onmessage = (event: MessageEvent) => {
    const message = parseScreeningTabMessage(event.data);
    if (message) onMessage(message);
  };
  return {
    close: () => channel.close(),
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        // The write this reports already happened; the other tab catches up on its next load.
      }
    },
  };
}
