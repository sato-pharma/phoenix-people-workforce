// THE JUDGEMENT behind "the weekly token rotation is paused" — pure, no IO, NO IMPORTS AT ALL.
//
// WHAT HAPPENED, AND WHY THIS EXISTS.
// On 2026-10-08 16:23 Cairo a second live feed link was minted from /recruitment/cv-lifecycle-sheet
// without the previous one being revoked. The next morning `phoenix-cv-lifecycle-rotate-sheet-token`
// (cron-job.org job 8387636, Fridays 04:03 Cairo) hit its own guard and returned `rotated: false`
// with "2 live cv-lifecycle feed links exist; resolve the ambiguity before rotating". That route
// answers HTTP 200 for every falsy outcome by design, so cron-job.org showed `lastStatus: 1` —
// green — and the ONLY signal anywhere in the system was `job_heartbeats.last_detail`, which the
// heartbeat sweep surfaced FOUR DAYS LATER. The token sat unrotated for 3 d 22 h.
//
// THE GUARD IS CORRECT AND IS NOT WEAKENED HERE. Rotating blind could revoke the token the Google
// Sheet is actually reading, and the sheet would then go dark until a human edited Apps Script. The
// defect was never the refusal — it was that the refusal was invisible on the screen where the
// second link had just been created. This module is that verdict and nothing else: it reads no
// database, changes no rotation behaviour, and the three rotation modules do not import it.
//
// IT MIRRORS THE GUARD'S OWN QUERY DELIBERATELY: `surface = 'feed'` AND `revoked_at IS NULL`, WITH
// NO EXPIRY FILTER. All three rotations select exactly that — `src/lib/direct-orders/`,
// `src/lib/marketing-requests/sheet-token-rotation.ts` and
// `src/lib/recruitment/cv-lifecycle-sheet-token-rotation.ts`, each `.eq("surface", "feed")
// .is("revoked_at", null).limit(2)` — so an EXPIRED-but-unrevoked feed link still makes the count 2
// and still pauses rotation. A verdict that quietly excluded it would tell the owner everything is
// fine while the Friday job goes on refusing, which is the exact silence this is here to end.
//
// WHICH LINK IS THE SHEET READING — AND IT IS NOT THE NEWEST.
// Measured on production 2026-10-13: the 2 October token had 3,116 reads with its latest at 03:34
// Cairo that morning, while the 8 October one had exactly ONE read, 8 seconds after it was minted —
// the mint screen's own confirmation fetch. Ordering newest-first would therefore have named the
// wrong link, and revoking the one it named is the outage. The discriminator is the PAIR: a live
// `last_accessed_at` and the high read count, on the same link. When those two signals disagree, or
// when nothing has been read at all, this refuses to name a reader rather than guess — the cost of
// guessing wrong is the sheet going dark, so an honest "cannot tell" is the cheaper answer.
//
// NO IMPORTS is load bearing, the same way `cv-lifecycle-link-expiry.ts` next door has none: both
// management screens are `"use client"` components, so anything this file imported would be bundled
// for the browser.

/** A feed link's own identity in the verdict. Never a token, not even a preview of one. */
export type LiveFeedLinkReading = {
  accessCount: number;
  id: string;
  label: string | null;
  lastAccessedAt: string | null;
};

/**
 * The minimum a judgement needs — structural, so all three screens' row types fit unchanged.
 *
 * `surface` is OPTIONAL because the CV-lifecycle list does not carry it: that table is feed-only by
 * construction (`createCvLifecycleShareLink` always inserts `surface: "feed"`, and
 * `assertCvLifecycleShareToken` refuses any other value outright), so its mapper drops the column.
 * An absent surface therefore reads as `"feed"`. The direct-orders and marketing lists DO carry it,
 * and there it matters: both tables also hold `'live'` links, which the rotation guard never counts.
 */
export type FeedAmbiguityJudgeableLink = {
  accessCount: number;
  id: string;
  label: string | null;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  surface?: string | null;
};

export type LiveFeedAmbiguityVerdict = {
  /** Unrevoked `feed` links — the number the rotation guard itself counts. */
  liveFeedCount: number;
  /** More than one, so the weekly rotation refuses. The one state this module exists to name. */
  paused: boolean;
  /** The link the evidence says the sheet is reading, or `null` when the evidence cannot say. */
  readingNow: LiveFeedLinkReading | null;
  /** Every other live feed link — and when undecided, ALL of them, including the likely reader. */
  strays: LiveFeedLinkReading[];
  /** The two signals disagree, or nothing has been read: do not revoke on this verdict alone. */
  undecided: boolean;
};

const FEED_SURFACE = "feed";

function isLiveFeedLink(link: FeedAmbiguityJudgeableLink): boolean {
  if (link.revokedAt) return false;
  // See `FeedAmbiguityJudgeableLink.surface`. Absent means feed-only table, not unknown surface.
  return (link.surface ?? FEED_SURFACE) === FEED_SURFACE;
}

/** Epoch ms of the last read, or `null` for never-read and for an unparseable stamp. */
function lastReadMs(link: FeedAmbiguityJudgeableLink): number | null {
  if (!link.lastAccessedAt) return null;
  const ms = new Date(link.lastAccessedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function readingOf(link: FeedAmbiguityJudgeableLink): LiveFeedLinkReading {
  return {
    accessCount: Number.isFinite(link.accessCount) ? link.accessCount : 0,
    id: link.id,
    label: link.label,
    lastAccessedAt: link.lastAccessedAt,
  };
}

/**
 * One order for both lists: most recently read first, never-read last, ties broken by read count
 * and then by id.
 *
 * The same order everywhere on purpose. A "least active first" order for the strays and a
 * "most active first" order for the undecided case would put the same link in different places on
 * two renders of the same screen, which is how a reader revokes the wrong one.
 */
function orderByEvidence(links: readonly FeedAmbiguityJudgeableLink[]): LiveFeedLinkReading[] {
  return [...links]
    .sort((a, b) => {
      const readA = lastReadMs(a);
      const readB = lastReadMs(b);
      if (readA !== readB) {
        if (readA === null) return 1;
        if (readB === null) return -1;
        return readB - readA;
      }
      if (a.accessCount !== b.accessCount) return b.accessCount - a.accessCount;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(readingOf);
}

/**
 * Is the rotation paused, and if so which link is the sheet actually reading?
 *
 * Takes the whole list the screen already holds — live links, expired ones, revoked ones, and on two
 * of the three tables `'live'` human links as well — and filters it exactly as the rotation guard
 * does. Nothing is passed in but rows: there is no clock here, because the verdict does not depend
 * on one. Expiry is a separate question, answered separately (`cv-lifecycle-link-expiry.ts`), and
 * an expired-but-unrevoked feed link pauses rotation whichever way that question is answered.
 */
export function assessLiveFeedAmbiguity(
  links: readonly FeedAmbiguityJudgeableLink[],
): LiveFeedAmbiguityVerdict {
  const live = links.filter(isLiveFeedLink);

  // One live feed link is the steady state, and zero is the report being dead — which the expiry
  // verdict already says in its own words. Neither is this module's business.
  if (live.length <= 1) {
    return { liveFeedCount: live.length, paused: false, readingNow: null, strays: [], undecided: false };
  }

  const byRead = live.filter((link) => lastReadMs(link) !== null).sort((a, b) => lastReadMs(b)! - lastReadMs(a)!);
  const mostRecentlyRead = byRead[0] ?? null;
  const byCount = [...live].sort((a, b) => b.accessCount - a.accessCount);
  const busiest = byCount[0]!;

  // Both signals must point at the SAME link, and each must point UNAMBIGUOUSLY. A tie on either
  // axis is not agreement — it is two links the evidence cannot separate, and on 8 October the
  // stray's single read was 8 seconds old, so "most recent" alone would have named it.
  const readIsClear = byRead.length === 1 || (byRead.length > 1 && lastReadMs(byRead[0]!)! > lastReadMs(byRead[1]!)!);
  const countIsClear = live.filter((link) => link.accessCount === busiest.accessCount).length === 1;
  const agreed = mostRecentlyRead !== null && mostRecentlyRead.id === busiest.id && readIsClear && countIsClear;

  if (!agreed) {
    return {
      liveFeedCount: live.length,
      paused: true,
      readingNow: null,
      // All of them, including whichever one is probably the reader. Naming a link to revoke on
      // evidence that cannot separate them is the mistake the banner must not help anyone make.
      strays: orderByEvidence(live),
      undecided: true,
    };
  }

  return {
    liveFeedCount: live.length,
    paused: true,
    readingNow: readingOf(mostRecentlyRead),
    strays: orderByEvidence(live.filter((link) => link.id !== mostRecentlyRead.id)),
    undecided: false,
  };
}
