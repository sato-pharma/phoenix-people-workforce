import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessCvLifecycleLinkExpiry,
  buildCvLifecycleLinkExpiryMessage,
  CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS,
  type ExpiryJudgeableLink,
} from "../src/lib/recruitment/cv-lifecycle-link-expiry.ts";
import { permissionGateKeys } from "./support/page-gate-reader.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MANAGEMENT SCREEN FOR THE OWNER'S LIVE CV-LIFECYCLE GOOGLE SHEET.
//
// #3102 shipped the domain service, the API, the table and the Apps Script on 2026-09-04 and no UI
// at all. So the only token that has ever existed was minted by hand in SQL against production,
// with its audit row hand-written to match what the route writes, and nothing in Phoenix could
// list, revoke or renew it. It expires 2027-09-04, at which point the feed answers 403 and the
// sheet keeps showing yesterday's numbers rather than an error — the failure mode nobody notices.
//
// Two things are worth pinning, and they are different in kind:
//
//   1. THE JUDGEMENT. `assessCvLifecycleLinkExpiry` is read by the screen AND by the daily alarm.
//      That sharing is the design — one answer to "is this about to go dark" — so its branches are
//      tested as behaviour, not as source text.
//   2. THE SHAPE. Everything else here is a source-pinning assertion, and each pins a rule that
//      would otherwise regress silently and invisibly: a token reaching the browser, a gate drifting
//      from its API, a horizontal scroll, a rounded corner.
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function link(overrides: Partial<ExpiryJudgeableLink> = {}): ExpiryJudgeableLink {
  return {
    expiresAt: new Date(NOW + 200 * MS_PER_DAY).toISOString(),
    id: "link-1",
    label: "Owner live CV lifecycle Google Sheet",
    revokedAt: null,
    ...overrides,
  };
}

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * Source with COMMENTS REMOVED, for the markup assertions in section 6.
 *
 * Those assertions are of the form "this string must not appear", and the file they scan explains
 * itself by NAMING the things it must not do — "never `overflow-x-auto` over a min-width floor",
 * "no `rounded-*` anywhere". Scanning the raw text therefore fails on the documentation of the very
 * rule being kept, which would train the next author to delete the explanation rather than the
 * violation. Stripping comments first is what lets a file say why it is shaped the way it is.
 *
 * `//` is stripped only when NOT preceded by `:`, so a `https://` inside a string survives.
 */
function withoutComments(source: string): string {
  return stripComments(source);
}

export function runCvLifecycleShareLinksScreenTests() {
  // ── 1. The judgement, branch by branch ─────────────────────────────────────

  // The window boundary, from both sides. A link exactly ON the threshold warns; one day further
  // out does not. Asserting only one side would let an off-by-one through in whichever direction
  // was not tested, and the direction that matters is the silent one — warning too LATE.
  const atThreshold = assessCvLifecycleLinkExpiry(
    [link({ expiresAt: new Date(NOW + CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS * MS_PER_DAY).toISOString() })],
    NOW,
  );
  assert.equal(atThreshold.expiringSoon.length, 1, "a link exactly at the threshold must warn");
  assert.equal(atThreshold.expiringSoon[0]!.daysLeft, CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS);
  assert.equal(atThreshold.healthy, false);
  assert.equal(atThreshold.liveCount, 1, "a link that is expiring is still LIVE");

  const justOutside = assessCvLifecycleLinkExpiry(
    [
      link({
        expiresAt: new Date(NOW + (CV_LIFECYCLE_LINK_EXPIRY_WARNING_DAYS + 1) * MS_PER_DAY).toISOString(),
      }),
    ],
    NOW,
  );
  assert.deepEqual(justOutside.expiringSoon, [], "one day past the window is not a warning");
  assert.equal(justOutside.healthy, true);
  assert.equal(justOutside.liveCount, 1);

  // A REVOKED link is finished on purpose. Reporting it as expiring — or counting it as live —
  // would make the alert cry wolf on every link the owner has ever correctly retired, and an alert
  // that is usually wrong is an alert nobody reads.
  const revoked = assessCvLifecycleLinkExpiry(
    [
      link({
        expiresAt: new Date(NOW + 2 * MS_PER_DAY).toISOString(),
        revokedAt: "2026-08-01T00:00:00.000Z",
      }),
    ],
    NOW,
  );
  assert.deepEqual(revoked.expiringSoon, [], "a revoked link is not expiring");
  assert.deepEqual(revoked.expired, [], "a revoked link is not expired");
  assert.equal(revoked.liveCount, 0, "a revoked link is not live");
  assert.equal(revoked.healthy, true);

  // An EXPIRED link is the state the sheet is already dead in.
  const lapsed = assessCvLifecycleLinkExpiry(
    [link({ expiresAt: new Date(NOW - 3 * MS_PER_DAY).toISOString() })],
    NOW,
  );
  assert.equal(lapsed.expired.length, 1);
  assert.equal(lapsed.expired[0]!.daysAgo, 3);
  assert.equal(lapsed.liveCount, 0, "an expired link is not live");
  assert.equal(lapsed.healthy, false);

  // Expiry is inclusive at the instant itself: a token whose expires_at has just been reached is
  // refused by assertCvLifecycleShareToken (`< Date.now()` on a stamp already past), so a screen
  // that still called it live would contradict the route serving the feed.
  const exactlyNow = assessCvLifecycleLinkExpiry([link({ expiresAt: new Date(NOW).toISOString() })], NOW);
  assert.equal(exactlyNow.expired.length, 1, "a link expiring at this instant is expired, not live");
  assert.equal(exactlyNow.liveCount, 0);

  // An unparseable date is not a verdict either way. Inventing one would either fabricate an expiry
  // or drop a live link out of the count; skipping leaves the row on screen where a human sees it.
  const unparseable = assessCvLifecycleLinkExpiry([link({ expiresAt: "not a date" })], NOW);
  assert.equal(unparseable.healthy, true);
  assert.equal(unparseable.liveCount, 0);
  assert.deepEqual(unparseable.expired, []);

  // Soonest first, in both lists — the banner reads element [0] and calls it "the" deadline.
  const many = assessCvLifecycleLinkExpiry(
    [
      link({ expiresAt: new Date(NOW + 20 * MS_PER_DAY).toISOString(), id: "b" }),
      link({ expiresAt: new Date(NOW + 3 * MS_PER_DAY).toISOString(), id: "a" }),
      link({ expiresAt: new Date(NOW + 400 * MS_PER_DAY).toISOString(), id: "far" }),
    ],
    NOW,
  );
  assert.deepEqual(
    many.expiringSoon.map((entry) => entry.id),
    ["a", "b"],
    "expiring links are ordered soonest first, and a distant one is not included",
  );
  assert.equal(many.liveCount, 3);

  // ── 2. The message a human actually receives ───────────────────────────────

  const deadMessage = buildCvLifecycleLinkExpiryMessage(
    assessCvLifecycleLinkExpiry([link({ expiresAt: new Date(NOW - MS_PER_DAY).toISOString() })], NOW),
  );
  assert.ok(
    deadMessage.includes("stopped receiving data"),
    "an expired link must say the sheet has stopped, not merely that a date passed",
  );
  assert.ok(
    deadMessage.includes("no live link left"),
    "with nothing live the message must say so — that is the whole outage",
  );
  assert.ok(
    deadMessage.includes("FEED_URL"),
    "the message must name the property to edit; a warning with no repair is a nag",
  );
  assert.ok(
    !/[0-9a-f]{16}/i.test(deadMessage),
    "no token-shaped string may ever reach a notification body",
  );

  const soonMessage = buildCvLifecycleLinkExpiryMessage(
    assessCvLifecycleLinkExpiry([link({ expiresAt: new Date(NOW + 5 * MS_PER_DAY).toISOString() })], NOW),
  );
  assert.ok(soonMessage.includes("about to expire"));
  assert.ok(
    soonMessage.includes("yesterday's numbers"),
    "the warning must explain WHY nothing else will tell them — the sheet fails quietly",
  );

  // ── 3. The token is shown once, and is not in the list AT ALL ──────────────
  //
  // Not "hidden in the UI": absent from the payload. Before this screen existed the list mapper
  // returned `token`, so every live bearer credential was shipped to the browser of anyone holding
  // recruitment:export — visible in devtools, in the React tree, and in any error report that
  // captured a network body. Hiding it in JSX would have left all of that untouched.

  const service = read("../src/lib/recruitment/cv-lifecycle-share-links.ts");
  const listBlock = service.slice(service.indexOf("export async function listCvLifecycleShareLinks"));
  const typeBlock = service.slice(
    service.indexOf("export type CvLifecycleShareLink = {"),
    service.indexOf("function mapLink("),
  );
  assert.ok(
    !/^\s*token:/m.test(typeBlock),
    "CvLifecycleShareLink must NOT carry a `token` field — the list is what reaches the browser",
  );
  assert.ok(typeBlock.includes("tokenPreview: string;"), "the list identifies a link by its 8-char preview");
  // The token itself is not stored (REC-055): the preview is read from its own column, never cut from a token.
  assert.ok(
    service.includes('tokenPreview: String(row.token_preview ?? ""),'),
    "mapLink must read the stored 8-character token_preview",
  );
  assert.ok(!/\brow\.token\b/.test(service), "the service must never read a stored plain token");
  assert.ok(
    listBlock.includes("mapLink(row, names)"),
    "the list must go through mapLink, which is where the token is dropped",
  );

  const view = read("../src/components/recruitment/cv-lifecycle-share-links-view.tsx");
  // A whole token may be touched in exactly two places, and both are the SAME token: the mint
  // response body (`data.token`) and the value stashed from it (`created.token`). Any other read
  // means a token arrived from somewhere else — which today could only be the list.
  const tokenReads = [...view.matchAll(/(\w+)\.token\b/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(tokenReads)].sort(),
    ["created", "data"],
    "the only tokens the screen may read are the one it just minted and the response carrying it",
  );
  assert.ok(
    !/link\.token\b/.test(view),
    "an existing link's token must never be rendered; it is not even fetched",
  );
  assert.ok(
    view.includes("shown once and cannot be retrieved"),
    "the mint panel must say plainly that this is the only sighting",
  );

  // ── 4. The page gate is the API gate, exactly ──────────────────────────────
  //
  // A page narrower than its API strands a holder who can still call it; a page wider offers a link
  // that bounces on arrival — the "offered but bounced" class every-offered-link-opens exists for.

  const page = read("../app/(admin)/recruitment/cv-lifecycle-sheet/page.tsx");
  assert.deepEqual(
    [...permissionGateKeys(page)],
    ["recruitment:export"],
    "the page must gate on recruitment:export and nothing else — the same act the API asserts",
  );
  assert.ok(
    page.includes('resolveNavigationMode(access) === "employee-portal"'),
    "an admin-shell page must refuse portal roles",
  );

  const registry = read("../src/lib/security/access-registry.ts");
  assert.ok(
    registry.includes(
      'pattern: "/api/recruitment/cv-lifecycle/share-links", permission: { resource: "recruitment", action: "export" }',
    ),
    "the registry entry must still name recruitment:export — if it moves, this page must move with it",
  );

  const service_gates = [...service.matchAll(/assertPermission\(access, "(\w+)", "(\w+)"\)/g)].map(
    (match) => `${match[1]}:${match[2]}`,
  );
  assert.deepEqual(
    [...new Set(service_gates)],
    ["recruitment:export"],
    "every entry point in the domain service asserts recruitment:export — list, create AND revoke",
  );

  // ── 5. The admin nav row carries that same clause ─────────────────────────

  const nav = read("../src/config/system-navigation.ts");
  assert.ok(
    nav.includes(
      '{ href: "/recruitment/cv-lifecycle-sheet", icon: Link2, label: "CV Sheet Links", permissions: [{ resource: "recruitment", action: "export" }], roles: hrAuthorityNavigationRoles }',
    ),
    "the admin rail row must exist and carry the page's own gate",
  );
  // No HR rail row since "move recruiting off the HR Business Partner" (owner, 2026-10-08): recruitment:export
  // left the HR Business Partner with recruiting, and the owner fenced this screen off the Talent
  // Acquisition seat on its blueprint — so a row there would be offered to no HR seat at all.
  assert.ok(
    !nav.includes('href: "/hr/recruitment/cv-lifecycle-sheet"'),
    "no HR seat opens CV Sheet Links since 2026-10-08 — an /hr row would be offered to nobody",
  );

  // ── 6. The owner's two golden rules, in the markup ─────────────────────────
  //
  // Both are invisible in review and invisible in a screenshot. A 4px corner reads as house style
  // because tokens.css ships one as the default; a horizontal scroll only appears at a width nobody
  // opened. So they are pinned as text.

  const markup = withoutComments(view);
  assert.ok(markup.includes('className="w-full table-fixed'), "the desktop table must be table-fixed");
  assert.ok(markup.includes("<colgroup>"), "table-fixed without a colgroup declares nothing");
  assert.ok(
    !markup.includes("overflow-x-auto") && !markup.includes("overflow-x-scroll"),
    "never a horizontal scroll — the golden rule calls overflow-x-auto over a min-width floor the BUG",
  );
  assert.ok(!markup.includes("min-w-["), "no min-width floor to scroll over");
  assert.ok(
    !markup.includes("PortalDesktopTable"),
    "a board bound by the fits-the-screen rule must not use PortalDesktopTable",
  );
  assert.ok(markup.includes("md:hidden"), "mobile gets cards — the admin shell never shows a table there");
  assert.ok(!/\brounded(-|\b)/.test(markup), "the square-edge golden rule: no rounded corners anywhere");
  assert.ok(
    !/\btruncate\b/.test(markup) && !/text-ellipsis/.test(markup),
    "the owner's rule: never truncate text with an ellipsis — wrap instead",
  );
  assert.ok(
    markup.includes("break-words") || markup.includes("break-all"),
    "fitting is done by WRAPPING, which is the permitted answer",
  );
  assert.ok(
    markup.includes('timeZone: "Africa/Cairo"'),
    "every time is reported in Cairo local time, never raw UTC",
  );

  // ── 7. The alarm actually runs ─────────────────────────────────────────────
  //
  // A dead man's switch nobody calls is the thing it was built to detect. It rides inside
  // runRecruitmentDailyNotifications, which is ALREADY an entry in the daily route's Promise.all —
  // that list destructures 22 results positionally and has gone off-by-one twice by someone adding
  // a job to it, so adding one more there was the riskier of the two placements.

  const daily = read("../src/lib/recruitment/notifications.ts");
  assert.ok(
    daily.includes("runCvLifecycleLinkExpiryCheck()"),
    "the daily recruitment run must call the expiry check",
  );
  assert.ok(
    daily.indexOf("runCvLifecycleLinkExpiryCheck()") < daily.indexOf("await sendInterviewReminders()"),
    "it must run BEFORE the throwing reminder loop, or a bad reminder suppresses the day's warning",
  );
  const route = read("../app/api/notifications/daily/route.ts");
  assert.ok(
    route.includes("runRecruitmentDailyNotifications()"),
    "…and that run must still be wired into the daily cron",
  );

  const alert = read("../src/lib/recruitment/cv-lifecycle-link-expiry-alert.ts");
  assert.ok(
    alert.includes('channels: ["in_app", "telegram", "push"]'),
    "in-app + Telegram + push only",
  );
  assert.ok(
    !/"email"/.test(withoutComments(alert)),
    "NEVER email: the owner's standing rule, and an alarm must not travel by a channel it may be reporting broken",
  );
  assert.ok(
    alert.includes('module: "system"'),
    "module must be `system` — an unknown module fails CLOSED in resolveTelegramGovernance and drops the alert",
  );
  assert.ok(
    alert.includes('.select("id,label,expires_at,revoked_at")'),
    "the alarm must not select the token column — it cannot leak what it never reads",
  );
}
