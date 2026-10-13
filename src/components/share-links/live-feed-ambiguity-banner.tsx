import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { LiveFeedAmbiguityVerdict, LiveFeedLinkReading } from "@/lib/share-links/live-feed-ambiguity";

/**
 * "THE WEEKLY TOKEN ROTATION IS PAUSED" — the one state a live-sheet screen could not say.
 *
 * On 2026-10-08 a second live feed link was minted on one of these screens and the previous one was
 * not revoked. Every Friday after that the rotation refused, correctly, and said so into
 * `job_heartbeats.last_detail` and nowhere else: the route answers HTTP 200 on a refusal by design,
 * so cron-job.org stayed green and the screen that had just created the second link looked healthy.
 * Four days passed. This banner is that refusal, in the place where it can be acted on, and it is
 * the ONLY thing this change adds — the rotation modules are untouched and the guard is unchanged.
 *
 * IT NAMES THE LINK THE SHEET IS READING, AND SAYS NOT TO REVOKE IT. That is the whole value: the
 * reader has to revoke ONE of two links that look alike, and getting it wrong takes the sheet dark
 * until somebody edits Apps Script. The discriminator lives in `assessLiveFeedAmbiguity` — a live
 * `last_accessed_at` together with the high read count, never the newest link. When the evidence
 * cannot separate them this says so and names no link to revoke, because a confident wrong answer
 * here is worse than the question.
 *
 * SHARED BY ALL THE LIVE-SHEET SCREENS ON PURPOSE. One wording, one judgement. Two screens phrasing
 * the same stall differently is how a reader learns to distrust both — the same reason
 * `assessCvLifecycleLinkExpiry` is read by its screen and its alarm rather than copied.
 *
 * LAYOUT: the owner's rules. No horizontal scroll at any width and nothing shrunk to fit — every
 * value WRAPS (`break-words`), and nothing is ever cut with an ellipsis. Square corners: no
 * `rounded-*` anywhere. Times in Cairo local, names never raw ids, and no token or token preview
 * appears at all — a link is named by its label.
 *
 * Deliberately has no `"use client"` of its own: it holds no state and no effects, so it is a plain
 * component that renders inside whichever client screen imports it.
 */
export function LiveFeedAmbiguityBanner({
  sheet,
  verdict,
}: {
  /** The sheet's human name — "CV Lifecycle", "Direct Orders". Never a table name. */
  sheet: string;
  verdict: LiveFeedAmbiguityVerdict;
}) {
  // One live feed link is the steady state and zero is a different outage, said elsewhere. Silence
  // here is correct: a banner that renders on the healthy path trains the reader to scroll past it.
  if (!verdict.paused) return null;

  return (
    <section className="border-2 border-rose-500 bg-rose-50 px-4 py-3">
      <h2 className="break-words text-phx-sm font-black uppercase tracking-wider text-rose-800">
        The weekly token rotation is paused
      </h2>
      <p className="mt-1 break-words text-phx-sm font-semibold text-rose-900">
        {verdict.liveFeedCount} live feed links exist for the {sheet} sheet, so the weekly rotation refuses
        rather than risk revoking the one the sheet is reading. It stays paused until one of them is
        revoked, and nothing else will tell you: the rotation answers a green 200 every week while it
        refuses.
      </p>

      {verdict.readingNow ? (
        <>
          <p className="mt-2 break-words text-phx-xs font-black uppercase tracking-wider text-rose-800">
            The sheet is reading this one. Do not revoke it.
          </p>
          <ul className="mt-1 space-y-0.5">
            <LinkLine link={verdict.readingNow} />
          </ul>
          <p className="mt-2 break-words text-phx-xs font-black uppercase tracking-wider text-rose-800">
            Revoke {verdict.strays.length === 1 ? "this one" : "these"} and the rotation resumes on its next
            run.
          </p>
          <ul className="mt-1 space-y-0.5">
            {verdict.strays.map((link) => (
              <LinkLine key={link.id} link={link} />
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="mt-2 break-words text-phx-sm font-semibold text-rose-900">
            {/* Said plainly rather than guessed. The newest link is NOT the reader — on 13 October the
                two-week-old token had 3,116 reads and the newer one had exactly one, eight seconds
                after it was minted — so where the read count and the last read disagree, the only
                safe answer is to look before revoking. */}
            Which link the sheet is reading cannot be told apart from here: the most recently read is not
            the one with the most reads. Check both in the sheet&apos;s Apps Script before revoking either —
            the reader is the busy one whose last read is only hours old, and it is never simply the newest.
          </p>
          <ul className="mt-1 space-y-0.5">
            {verdict.strays.map((link) => (
              <LinkLine key={link.id} link={link} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * One link, with the two numbers the decision turns on.
 *
 * Both are shown on every line, including on the link being kept, because the reader is comparing
 * them — a line that printed only the verdict would be asking to be taken on trust. The count is
 * rendered raw rather than through `toLocaleString`: this text is built once on the server and
 * again on hydrate, and a locale-dependent thousands separator is how a hydration mismatch starts.
 */
function LinkLine({ link }: { link: LiveFeedLinkReading }) {
  return (
    <li className="break-words text-phx-xs text-rose-900">
      <span className="font-black">{link.label ?? "Unlabelled link"}</span>
      {" — "}
      <span className="tabular-nums">{link.accessCount}</span> read{link.accessCount === 1 ? "" : "s"}
      {link.lastAccessedAt ? `, last read ${cairoDateTime(link.lastAccessedAt)}` : ", never read"}
    </li>
  );
}
