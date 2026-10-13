import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessLiveFeedAmbiguity,
  type FeedAmbiguityJudgeableLink,
} from "../src/lib/share-links/live-feed-ambiguity.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A SECOND LIVE FEED LINK PAUSES THE WEEKLY TOKEN ROTATION, AND NOTHING SAID SO.
//
// On 2026-10-08 16:23 Cairo a second live feed link was minted from
// /recruitment/cv-lifecycle-sheet without the previous one being revoked. From 09 October
// `phoenix-cv-lifecycle-rotate-sheet-token` (cron-job.org job 8387636, Fridays 04:03 Cairo) hit its
// own guard and answered `rotated: false` with "2 live cv-lifecycle feed links exist; resolve the
// ambiguity before rotating". That route returns HTTP 200 for every falsy outcome by design, so
// cron-job.org showed a green `lastStatus: 1` and the ONLY signal anywhere was
// `job_heartbeats.last_detail` — surfaced by the heartbeat sweep four days later, after 3 d 22 h
// unrotated.
//
// THREE THINGS ARE PINNED HERE, and they are different in kind:
//
//   1. THE JUDGEMENT. `assessLiveFeedAmbiguity` is read by both live-sheet screens, so its branches
//      are tested as BEHAVIOUR, with the real October figures as the fixture.
//   2. THE WORDS AND THE SHAPE of the shared banner, as source assertions — each one pinning a rule
//      that regresses silently: a token reaching the browser, a horizontal scroll, a rounded corner,
//      an ellipsis.
//   3. THE PARITY WITH THE GUARD, across ALL THREE rotations. The verdict's filter must be the
//      guard's filter — `surface = 'feed'` AND `revoked_at IS NULL`, with NO expiry test — or the
//      screen says "fine" while the Friday job goes on refusing. The marketing rotation is pinned
//      here too even though marketing has no management screen (`SHARE_LINK_FEEDS` records that
//      `screen: null` deliberately), because its guard is the same contract.
//
// AND THE ROTATION LOGIC IS UNTOUCHED, which is asserted rather than asserted-in-prose: none of the
// three rotation modules may import this verdict.
// ─────────────────────────────────────────────────────────────────────────────

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * The two links as production held them on 2026-10-13, which is the whole fixture.
 *
 * The busy one is the OLDER link and the near-silent one is the NEWER: 3,116 reads with the latest
 * at 03:34 Cairo that morning, against exactly one read eight seconds after minting — the mint
 * screen's own confirmation fetch. Any implementation that answers "the newest" or "the first row
 * the service returned" names the wrong one, and revoking the one it names takes the sheet dark.
 */
const BUSY_OCTOBER_2: FeedAmbiguityJudgeableLink = {
  accessCount: 3116,
  id: "link-oct-02",
  label: "Owner live CV lifecycle Google Sheet",
  lastAccessedAt: "2026-10-13T01:34:00.000Z",
  revokedAt: null,
};

const QUIET_OCTOBER_8: FeedAmbiguityJudgeableLink = {
  accessCount: 1,
  id: "link-oct-08",
  label: "Rotated CV-lifecycle feed link",
  lastAccessedAt: "2026-10-08T14:23:08.000Z",
  revokedAt: null,
};

function feedLink(overrides: Partial<FeedAmbiguityJudgeableLink> = {}): FeedAmbiguityJudgeableLink {
  return { ...BUSY_OCTOBER_2, ...overrides };
}

export function runLiveFeedRotationPausedTests() {
  // ── 1. The judgement, branch by branch ─────────────────────────────────────

  // The steady state. One live feed link is what a healthy rotation leaves behind every Friday, and
  // a banner that fired on it would be on screen fifty-two weeks a year.
  const steady = assessLiveFeedAmbiguity([BUSY_OCTOBER_2]);
  assert.equal(steady.paused, false, "one live feed link is the steady state, not a fault");
  assert.equal(steady.liveFeedCount, 1, "the one live feed link is counted — a link with no surface column IS a feed link");
  assert.equal(steady.readingNow, null, "with nothing ambiguous there is no link to name");
  assert.deepEqual(steady.strays, [], "nothing is a stray while only one link is live");

  // Nothing at all. A dead report is a different finding, said by the expiry verdict in its own
  // words — this one must not also claim it.
  const nothing = assessLiveFeedAmbiguity([]);
  assert.equal(nothing.paused, false);
  assert.equal(nothing.liveFeedCount, 0, "an empty list counts zero, and says nothing about a dead feed");

  // THE INCIDENT ITSELF, with the rows in the order the service returns them — newest first, which
  // is `order("created_at", { ascending: false })`. So "the first row" and "the newest" are both
  // the WRONG answer here, and only the read evidence gives the right one.
  const incident = assessLiveFeedAmbiguity([QUIET_OCTOBER_8, BUSY_OCTOBER_2]);
  assert.equal(incident.paused, true, "two live feed links pause the rotation — that is the guard");
  assert.equal(incident.liveFeedCount, 2, "both October links are counted");
  assert.equal(incident.undecided, false, "3,116 reads against 1 is not an ambiguous reading");
  assert.equal(
    incident.readingNow?.id,
    BUSY_OCTOBER_2.id,
    "the sheet is reading the BUSY link, which is the older one — never the newest, and never the first row",
  );
  assert.equal(incident.readingNow?.accessCount, 3116, "the banner shows the count the reader compares");
  assert.deepEqual(
    incident.strays.map((link) => link.id),
    [QUIET_OCTOBER_8.id],
    "the stray is the near-silent newer link, and it is the one to revoke",
  );

  // A REVOKED second link is not a second link. This is the guard's own filter: a rotation that
  // succeeded last Friday left a revoked row behind, and every one of them would otherwise pause
  // the next run for ever.
  const withRevoked = assessLiveFeedAmbiguity([
    BUSY_OCTOBER_2,
    feedLink({ id: "retired", revokedAt: "2026-10-06T00:00:00.000Z" }),
  ]);
  assert.equal(withRevoked.paused, false, "a revoked link never counts — the guard filters it out");
  assert.equal(withRevoked.liveFeedCount, 1, "only the unrevoked link is counted");

  // A 'live' HUMAN link is not a feed link. Both the direct-orders and marketing tables hold them,
  // behind a passcode, and the rotation guard counts only `surface = 'feed'`.
  const withHumanLink = assessLiveFeedAmbiguity([
    feedLink({ surface: "feed" }),
    feedLink({ id: "ceo-view", surface: "live" }),
  ]);
  assert.equal(withHumanLink.paused, false, "a 'live' passcode link cannot make a rotation ambiguous");
  assert.equal(withHumanLink.liveFeedCount, 1, "only the feed link is counted");

  // AN ABSENT surface IS A FEED LINK. The CV-lifecycle list does not carry the column — that table
  // is feed-only by construction — so reading `undefined` as "not a feed" would make the one screen
  // the incident happened on the one screen that stays silent.
  const cvShape = assessLiveFeedAmbiguity([
    { accessCount: 3116, id: "a", label: "A", lastAccessedAt: "2026-10-13T01:34:00.000Z", revokedAt: null },
    { accessCount: 1, id: "b", label: "B", lastAccessedAt: "2026-10-08T14:23:08.000Z", revokedAt: null },
  ]);
  assert.equal(cvShape.paused, true, "a row with no surface column is a feed link, not an unknown one");
  assert.equal(cvShape.readingNow?.id, "a", "the busy row is the reader on the CV-lifecycle shape too");

  // AN EXPIRED-BUT-UNREVOKED FEED LINK STILL PAUSES THE ROTATION, and this is the subtle one. All
  // three guards select on `revoked_at IS NULL` alone and test no expiry at all, so a verdict that
  // quietly dropped an expired row would print an all-clear on a screen whose Friday job is
  // refusing — the exact silence this change removes. There is no clock here to drop it with.
  const expiredStray = assessLiveFeedAmbiguity([
    BUSY_OCTOBER_2,
    feedLink({ id: "lapsed", accessCount: 4, lastAccessedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  assert.equal(expiredStray.paused, true, "an unrevoked link pauses rotation whether or not it has expired");
  assert.equal(expiredStray.readingNow?.id, BUSY_OCTOBER_2.id, "the busy link is still the reader beside an expired stray");

  // THE TWO SIGNALS DISAGREE — the most recently read is not the most read. Naming either one would
  // be a guess, and the cost of guessing wrong is the sheet going dark, so this refuses to name one
  // and hands the reader both rows.
  const disagreeing = assessLiveFeedAmbiguity([
    feedLink({ id: "busy-but-stale", accessCount: 5000, lastAccessedAt: "2026-10-01T00:00:00.000Z" }),
    feedLink({ id: "fresh-but-quiet", accessCount: 3, lastAccessedAt: "2026-10-13T01:34:00.000Z" }),
  ]);
  assert.equal(disagreeing.paused, true, "two live links pause the rotation however the evidence reads");
  assert.equal(disagreeing.undecided, true, "disagreeing signals are not a verdict");
  assert.equal(disagreeing.readingNow, null, "no link may be named when the evidence cannot separate them");
  assert.deepEqual(
    disagreeing.strays.map((link) => link.id),
    ["fresh-but-quiet", "busy-but-stale"],
    "both rows are listed, most recently read first, and neither is marked for revoking",
  );

  // NEITHER HAS BEEN READ. Two fresh links and no evidence at all: the honest answer is that this
  // cannot say which one the sheet will use, and a never-read link cannot be the current reader.
  const neitherRead = assessLiveFeedAmbiguity([
    feedLink({ id: "new-a", accessCount: 0, lastAccessedAt: null }),
    feedLink({ id: "new-b", accessCount: 0, lastAccessedAt: null }),
  ]);
  assert.equal(neitherRead.paused, true, "two unread live links still pause the rotation");
  assert.equal(neitherRead.undecided, true, "nothing read means nothing proven");
  assert.equal(neitherRead.readingNow, null, "a never-read link may not be named as the reader");
  assert.equal(neitherRead.strays.length, 2, "both unread links are listed for the reader to check");

  // A TIE on the last read is not agreement either, even when the counts differ — two links read in
  // the same second are two readers, which is a different fault from the one this names.
  const tiedOnRead = assessLiveFeedAmbiguity([
    feedLink({ id: "tie-a", accessCount: 900, lastAccessedAt: "2026-10-13T01:34:00.000Z" }),
    feedLink({ id: "tie-b", accessCount: 10, lastAccessedAt: "2026-10-13T01:34:00.000Z" }),
  ]);
  assert.equal(tiedOnRead.undecided, true, "an identical last read cannot single one out");
  assert.equal(tiedOnRead.readingNow, null, "a tie on the last read names nobody");

  // A TIE on the count is not agreement, for the same reason from the other side.
  const tiedOnCount = assessLiveFeedAmbiguity([
    feedLink({ id: "count-a", accessCount: 500, lastAccessedAt: "2026-10-13T01:34:00.000Z" }),
    feedLink({ id: "count-b", accessCount: 500, lastAccessedAt: "2026-10-11T01:34:00.000Z" }),
  ]);
  assert.equal(tiedOnCount.undecided, true, "an identical read count cannot single one out");

  // An unparseable stamp reads as never-read rather than as a date, so it can never win the
  // "most recently read" comparison by accident.
  const unparseable = assessLiveFeedAmbiguity([
    feedLink({ id: "good", accessCount: 10, lastAccessedAt: "2026-10-13T01:34:00.000Z" }),
    feedLink({ id: "broken", accessCount: 2, lastAccessedAt: "not a date" }),
  ]);
  assert.equal(unparseable.readingNow?.id, "good", "an unreadable stamp is not a recent read");
  assert.deepEqual(unparseable.strays.map((link) => link.id), ["broken"]);

  // THREE live links. The guard's own `.limit(2)` stops counting at two, so the screen is the only
  // place a reader learns there are three — and all the strays must be listed, not just one.
  const three = assessLiveFeedAmbiguity([
    QUIET_OCTOBER_8,
    BUSY_OCTOBER_2,
    feedLink({ id: "third", accessCount: 2, lastAccessedAt: "2026-10-09T00:00:00.000Z" }),
  ]);
  assert.equal(three.liveFeedCount, 3, "every live feed link is counted, not capped at the guard's limit");
  assert.equal(three.readingNow?.id, BUSY_OCTOBER_2.id, "the busy link is the reader among three");
  assert.deepEqual(
    three.strays.map((link) => link.id),
    ["third", QUIET_OCTOBER_8.id],
    "both strays appear, most recently read first",
  );

  // ── 2. The banner's words and shape ────────────────────────────────────────
  //
  // Source assertions, over COMMENT-STRIPPED text. The file explains itself by naming the things it
  // must not do, so scanning the raw source would fail on the documentation of the very rule being
  // kept — which trains the next author to delete the explanation instead of the violation.

  const bannerSource = read("../src/components/share-links/live-feed-ambiguity-banner.tsx");
  const banner = stripComments(bannerSource);

  assert.ok(
    banner.includes("The weekly token rotation is paused"),
    "the heading must name the STALL, not merely report two links — the stall is what nothing else said",
  );
  assert.ok(
    banner.includes("Do not revoke it"),
    "the link the sheet is reading must be marked as the one to leave alone; that is the mistake that costs the outage",
  );
  assert.ok(
    banner.includes("green 200"),
    "it must say why nothing else will tell them — the rotation answers 200 while it refuses",
  );
  assert.ok(
    banner.includes("never simply the newest"),
    "the undecided branch must warn against the newest-link assumption, which is what the incident looked like",
  );
  assert.ok(
    banner.includes("if (!verdict.paused) return null;"),
    "the banner must render NOTHING on the healthy path — a banner that is always up is scrolled past",
  );
  assert.ok(
    banner.includes("cairoDateTime("),
    "a last read is reported in Cairo local time, and with the TIME on it — 03:34 that morning is the discriminator",
  );
  // No token VALUE and no preview of one: a link is named by its LABEL. The word "token" itself is
  // in the heading, which is why this asserts the two ways a value could arrive rather than the word.
  assert.ok(
    !/\.token\b/.test(banner) && !/tokenPreview/.test(banner),
    "the banner may not read a link's token or its preview — it names a link by its label",
  );
  assert.ok(
    !/\brounded(-|\b)/.test(banner),
    "the square-edge golden rule: no rounded corners anywhere",
  );
  assert.ok(
    !/\btruncate\b/.test(banner) && !/text-ellipsis/.test(banner) && !/line-clamp/.test(banner),
    "the owner's rule: never truncate text with an ellipsis — wrap instead",
  );
  assert.ok(
    !banner.includes("overflow-x-auto") && !banner.includes("overflow-x-scroll") && !banner.includes("min-w-["),
    "never a horizontal scroll, and no min-width floor to scroll over",
  );
  assert.ok(
    banner.includes("break-words"),
    "fitting is done by WRAPPING, which is the permitted answer at 375px",
  );
  assert.ok(
    !banner.includes("toLocaleString"),
    "the read count is rendered raw: a locale thousands separator is built twice and is a hydration mismatch",
  );

  // ── 3. Both screens read it, and the direct-orders panel reads it WHILE CLOSED ──

  const cvView = stripComments(read("../src/components/recruitment/cv-lifecycle-share-links-view.tsx"));
  const doPanel = stripComments(read("../src/components/direct-orders/report-share-links-panel.tsx"));

  for (const [name, source, sheet] of [
    ["the CV sheet links screen", cvView, "CV Lifecycle"],
    ["the direct-orders report panel", doPanel, "Direct Orders"],
  ] as const) {
    assert.ok(
      source.includes("assessLiveFeedAmbiguity(links)"),
      `${name} must judge the list it already holds — one judgement, shared, never a second reading`,
    );
    assert.ok(
      source.includes(`<LiveFeedAmbiguityBanner sheet="${sheet}"`),
      `${name} must render the shared banner, named with the sheet's human name`,
    );
  }

  // The banner goes ABOVE the expiry banner on the CV screen. A paused rotation is the only state
  // there that blocks a machine until a human acts; the expiry question has thirty days of runway.
  assert.ok(
    cvView.indexOf("<LiveFeedAmbiguityBanner") < cvView.indexOf("<ExpiryBanner"),
    "the rotation banner is rendered before the expiry banner, not under it",
  );

  // And the emerald all-clear is suppressed by the BANNER'S OWN branches, not by `verdict.healthy`.
  // A verdict with no live link is `healthy` by that flag and still renders the rose "the sheet is
  // not being fed", so suppressing on the flag would hide a real outage behind the rotation banner —
  // two expired, unrevoked links is exactly that case.
  assert.ok(
    cvView.includes("expiryBannerIsTheAllClear(verdict)"),
    "the suppression must go through the helper that mirrors the banner's branches",
  );
  assert.ok(
    /function expiryBannerIsTheAllClear[\s\S]{0,260}liveCount > 0/.test(cvView),
    "that helper must require a LIVE link, or it suppresses the dead-feed warning as well as the all-clear",
  );
  assert.ok(
    !cvView.includes("ambiguity.paused && verdict.healthy"),
    "suppressing on verdict.healthy hides the rose dead-feed banner — the flag is true with zero live links",
  );

  // THE DIRECT-ORDERS PANEL MUST LOAD ITS LIST ON MOUNT. It used to fetch nothing until somebody
  // clicked it open, and a warning behind a closed button is the silence this whole change removes.
  assert.ok(
    !doPanel.includes("if (!open) return;"),
    "the panel must not defer its list read to the open click — the banner has to show while closed",
  );
  assert.ok(
    doPanel.indexOf("<LiveFeedAmbiguityBanner") < doPanel.indexOf("onClick={() => setOpen(true)}"),
    "the banner sits above the collapsed button, so it is on the report page without a click",
  );

  // ── 4. The verdict's filter IS the guard's filter, in all three rotations ───
  //
  // The screens are two; the guards are three. Marketing has no management screen at all — the
  // `screen: null` in SHARE_LINK_FEEDS records that as a decision, not a gap — so its guard is
  // pinned here or nowhere.

  const rotations = [
    ["cv-lifecycle", read("../src/lib/recruitment/cv-lifecycle-sheet-token-rotation.ts")],
    ["direct-orders", read("../src/lib/direct-orders/sheet-token-rotation.ts")],
    ["marketing-requests", read("../src/lib/marketing-requests/sheet-token-rotation.ts")],
  ] as const;

  for (const [name, rawSource] of rotations) {
    const source = stripComments(rawSource);
    assert.ok(
      source.includes('.eq("surface", "feed")'),
      `the ${name} guard counts feed links only — the verdict's own filter mirrors this`,
    );
    assert.ok(
      source.includes('.is("revoked_at", null)'),
      `the ${name} guard counts unrevoked links — the verdict's own filter mirrors this`,
    );
    assert.ok(
      source.includes("live.length > 1"),
      `the ${name} guard must still REFUSE on more than one live link; the banner explains that refusal, it does not replace it`,
    );
    assert.ok(
      !/\.(?:lt|lte|gt|gte)\("expires_at"/.test(source),
      `the ${name} guard applies no expiry filter, so the verdict must not apply one either`,
    );
    assert.ok(
      !source.includes("live-feed-ambiguity") && !source.includes("assessLiveFeedAmbiguity"),
      `the ${name} rotation must not import the verdict — this change is UI only and the guard stays untouched`,
    );
  }

  // The marketing feed's missing screen is a recorded decision, and the moment it gains one the
  // banner belongs on it. Pinned so that `screen: null` cannot quietly become a forgotten gap.
  const feeds = stripComments(read("../src/lib/share-links/feeds.ts"));
  assert.ok(
    /screen: null,\s*sheet: "Marketing Requests"/.test(feeds),
    "marketing is still the feed with no management screen — if that changes, the banner goes on it",
  );
}
