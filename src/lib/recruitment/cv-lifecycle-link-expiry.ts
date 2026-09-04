// THE JUDGEMENT on the owner's live CV-lifecycle Google Sheet feed token — pure, no IO.
//
// THE FAILURE MODE THIS EXISTS TO PREVENT, said plainly. The sheet is fed by a bearer token with a
// MANDATORY expiry — 2027-09-04 for the one minted by hand on 2026-09-04. On that date the feed
// starts answering 403 and the sheet stops filling. Nothing else changes: no error reaches Phoenix,
// no cron goes red, no notification fires, and the Apps Script writes its failure into a cell in a
// spreadsheet nobody is looking at, because the whole value of the thing is that it looks after
// itself. A stale sheet and a working sheet are indistinguishable at a glance — the numbers are
// still there, they just stopped moving. That is a silence that could last a year.
//
// SEPARATED FROM THE ALARM ON PURPOSE, the same way `job-heartbeat-assess.ts` is separated from
// `job-heartbeat-alert.ts`. The screen at /recruitment/cv-lifecycle-sheet is a CLIENT component, so
// anything it imports is bundled for the browser; the alarm reaches Supabase, the audit log and the
// notification outbox. Keeping the judgement here — with no imports at all — is what lets the screen
// and the daily alarm read the SAME function. That shared reading is the point: a badge and an alert
// firing on different thresholds would be two answers to one question, and the first time they
// disagreed nobody would trust either.

/**
 * How far ahead the warning starts. Thirty days is not arbitrary: minting a replacement means
 * opening the sheet's Apps Script and pasting a new FEED_URL, which is the owner's own hands and
 * cannot be scheduled around a holiday. A week would be a scramble; a quarter would be noise for
 * two months before it mattered.
 */
export const CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The minimum a judgement needs. Structural, so both the screen's row type and a raw row fit. */
export type ExpiryJudgeableLink = {
  expiresAt: string;
  id: string;
  label: string | null;
  revokedAt: string | null;
};

export type CvLifecycleLinkExpiryVerdict = {
  /** Live links inside the warning window, soonest first. */
  expiringSoon: Array<{ daysLeft: number; id: string; label: string | null }>;
  /** Links that have already lapsed and were never revoked — the sheet is dead NOW. */
  expired: Array<{ daysAgo: number; id: string; label: string | null }>;
  /** Nothing to say: either every live link has plenty of runway, or there are none at all. */
  healthy: boolean;
  /** How many links are neither revoked nor expired. Zero is itself a finding — see below. */
  liveCount: number;
};

/**
 * Whole Cairo days between two instants, rounded toward zero.
 *
 * Days, not hours, because that is the unit the answer is acted on in — nobody mints a replacement
 * "in 14 hours". `Math.floor` means a link with 29.9 days left reads as 29, which is the safe
 * direction: it warns a few hours early rather than a few hours late.
 */
function wholeDaysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/**
 * The single judgement, pure and total, that the screen and the alarm both read.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call for two reasons. It makes every branch
 * unit-testable without freezing a clock; and in the React client it keeps the verdict and the data
 * one fact — `Date.now()` in a render body is impure (react-hooks/purity) and a re-render could
 * otherwise flip a row from live to expired mid-paint. The sibling panel records the same trap.
 *
 * A REVOKED link is not expiring and is not expired: it is finished, deliberately, and reporting it
 * would train the reader to ignore the alert. Only the two states a human must act on are returned.
 */
export function assessCvLifecycleLinkExpiry(
  links: readonly ExpiryJudgeableLink[],
  nowMs: number,
): CvLifecycleLinkExpiryVerdict {
  const expiringSoon: CvLifecycleLinkExpiryVerdict["expiringSoon"] = [];
  const expired: CvLifecycleLinkExpiryVerdict["expired"] = [];
  let liveCount = 0;

  for (const link of links) {
    if (link.revokedAt) continue;
    const expiresMs = new Date(link.expiresAt).getTime();
    // An unparseable date is not a verdict. Judging it would either invent an expiry that is not
    // there or silently drop a live link out of the count; skipping it leaves the row visible on
    // the screen, where a human can see the date is wrong.
    if (!Number.isFinite(expiresMs)) continue;

    const daysLeft = wholeDaysBetween(nowMs, expiresMs);
    if (expiresMs <= nowMs) {
      expired.push({ daysAgo: Math.max(0, -daysLeft), id: link.id, label: link.label });
      continue;
    }
    liveCount += 1;
    if (daysLeft <= CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS) {
      expiringSoon.push({ daysLeft, id: link.id, label: link.label });
    }
  }

  expiringSoon.sort((a, b) => a.daysLeft - b.daysLeft);
  expired.sort((a, b) => a.daysAgo - b.daysAgo);

  return {
    expiringSoon,
    expired,
    healthy: expiringSoon.length === 0 && expired.length === 0,
    liveCount,
  };
}

/** Pure message builder — no IO, so the wording is unit-testable without a database. */
export function buildCvLifecycleLinkExpiryMessage(verdict: CvLifecycleLinkExpiryVerdict): string {
  const name = (label: string | null) => label ?? "an unlabelled link";
  const lines: string[] = [];

  if (verdict.expired.length > 0) {
    lines.push("🛑 The live CV-lifecycle Google Sheet has stopped receiving data.");
    lines.push("");
    for (const link of verdict.expired) {
      lines.push(
        `· ${name(link.label)} expired ${link.daysAgo === 0 ? "today" : `${link.daysAgo} day(s) ago`}.`,
      );
    }
    if (verdict.liveCount === 0) {
      lines.push("");
      lines.push("There is no live link left, so the sheet is showing numbers that stopped moving.");
    }
  }

  if (verdict.expiringSoon.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("⚠️ The live CV-lifecycle Google Sheet's link is about to expire.");
    lines.push("");
    for (const link of verdict.expiringSoon) {
      lines.push(
        `· ${name(link.label)} expires in ${link.daysLeft === 0 ? "less than a day" : `${link.daysLeft} day(s)`}.`,
      );
    }
  }

  lines.push("");
  lines.push(
    "When it lapses the sheet keeps showing yesterday's numbers rather than an error, so nothing",
  );
  lines.push("else will tell you. Create a new link, then paste it into the sheet's Apps Script");
  lines.push("(Extensions ▸ Apps Script ▸ Project Settings ▸ Script Properties ▸ FEED_URL).");
  return lines.join("\n");
}
