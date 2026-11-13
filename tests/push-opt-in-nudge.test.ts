import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  PUSH_OPT_IN_NUDGE_DISMISSED_KEY,
  PUSH_RE_ASK_SLACK_MS,
  isPushOptInNudgeDismissed,
  pushWasDroppedSinceAnswer,
  shouldShowPushOptInNudge,
  withPushOptInNudgeDismissed,
} from "../src/lib/notifications/push-opt-in-nudge-rules.ts";

// The push opt-in nudge exists because 71 of 107 active employees (measured 2026-09-06) have
// never enabled push on any device — the only control for it lived inside Profile, and nothing
// ever pointed anyone at it. This suite pins the two rules that keep the nudge from becoming the
// exact wallpaper it was designed to avoid:
//
//   (a) never shown to someone who already has an ACTIVE push subscription;
//   (b) an answer stands — once recorded, the nudge does not ask that person again...
//   (c) ...until a device that was receiving push stops (owner, 13 Nov 2026: "Ask again after a drop").
//       Measured that day: 63 of the 130 people who ever turned push on had no device left, and the
//       card, answered once, never told any of them. One drop is asked about once.
//
// Both are pure functions with no database, matching the shape of the other settings.ts guard
// (pushSubscriptionSkipReason / tests/push-register-hr-id-guard.test.ts) so they can be broken and
// proven broken without touching Supabase.

function settingsFunctionSource(name: string) {
  const source = readFileSync(new URL("../src/lib/notifications/settings.ts", import.meta.url), "utf8");
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must still be exported from the notification settings module`);
  const rest = source.slice(start + 1);
  const nextDeclaration = rest.search(/\n(?:export )?(?:async )?function /);
  return nextDeclaration === -1 ? rest : rest.slice(0, nextDeclaration);
}

export function runPushOptInNudgeTests() {
  // 1. Baseline: a fresh person — no devices, no prior dismissal — must see the nudge, or the
  //    feature would silently reach nobody.
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, modulePreferences: {} }),
    true,
    "a person with zero active push devices and no dismissal must be offered the nudge",
  );
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, modulePreferences: null }),
    true,
    "a person with no notification_preferences row at all (null module_preferences) must still be offered the nudge",
  );

  // 2. Requirement (a) — the headline. `deviceCount` here mirrors mapPushState's own count, which
  //    only counts rows whose status is "subscribed" — so this is genuinely "already reachable by
  //    push", not merely "has ever seen a subscription row".
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 1, modulePreferences: {} }),
    false,
    "a person with one active push subscription must never see the nudge",
  );
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 3, modulePreferences: {} }),
    false,
    "a person with several active push devices must never see the nudge either",
  );

  // 3. Requirement (b) — dismissal persists. Simulate the exact round trip: merge a dismissal
  //    timestamp into module_preferences, then ask the decision function using the merged object,
  //    the way the client does after reading it back from GET /api/notifications/settings.
  const dismissedAt = "2026-09-06T10:00:00.000Z";
  const dismissedPreferences = withPushOptInNudgeDismissed({}, dismissedAt);
  assert.equal(
    dismissedPreferences[PUSH_OPT_IN_NUDGE_DISMISSED_KEY],
    dismissedAt,
    "the merge must record the dismissal under its own key",
  );
  assert.equal(
    isPushOptInNudgeDismissed(dismissedPreferences),
    true,
    "isPushOptInNudgeDismissed must read back a dismissal the merge just wrote",
  );
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, modulePreferences: dismissedPreferences }),
    false,
    "once dismissed, the nudge must not show again even for a person with zero active devices — a nudge asked twice becomes wallpaper",
  );

  // 4. The merge must be additive, never a silent overwrite of module_preferences — another
  //    feature's own flag living in that same jsonb column must survive a dismissal write.
  const withUnrelatedKey = withPushOptInNudgeDismissed({ someOtherFeatureFlag: true }, dismissedAt);
  assert.equal(
    withUnrelatedKey.someOtherFeatureFlag,
    true,
    "dismissing the push nudge must not erase an unrelated key already stored in module_preferences",
  );
  assert.equal(
    withUnrelatedKey[PUSH_OPT_IN_NUDGE_DISMISSED_KEY],
    dismissedAt,
    "the dismissal key must still be present alongside the preserved unrelated key",
  );

  // 5. A non-string value under the same key (defensive: a future bug or a hand-edited row) must
  //    never be read as a dismissal — only a real timestamp counts.
  assert.equal(
    isPushOptInNudgeDismissed({ [PUSH_OPT_IN_NUDGE_DISMISSED_KEY]: true }),
    false,
    "a truthy non-string value under the dismissal key must not count as a dismissal",
  );

  // 6. Source lock. dismissPushOptInNudge is the only write path — it must actually use the same
  //    merge helper this suite pins, rather than building its own ad hoc object that could drift
  //    from withPushOptInNudgeDismissed and silently stop being additive.
  const writerSource = settingsFunctionSource("dismissPushOptInNudge");
  assert.ok(
    writerSource.includes("withPushOptInNudgeDismissed("),
    "dismissPushOptInNudge must call withPushOptInNudgeDismissed to merge the dismissal, not build the module_preferences payload by hand",
  );

  // 7. Requirement (c) — ask again after a drop. The person turned push on through the card on 6 Sep
  //    (the answer), the phone was last seen receiving on 20 Oct, and it has stopped since.
  const droppedAfter = "2026-10-20T08:00:00.000+00:00";
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, lastDroppedSubscribedAt: droppedAfter, modulePreferences: dismissedPreferences }),
    true,
    "a device that was receiving after the answer and has stopped is the drop: the person is asked again",
  );
  //    A device that stopped BEFORE the answer was already known when the person answered.
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, lastDroppedSubscribedAt: "2026-08-01T08:00:00.000Z", modulePreferences: dismissedPreferences }),
    false,
    "a device that stopped before the answer is not a new drop: the answer stands",
  );
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, lastDroppedSubscribedAt: null, modulePreferences: dismissedPreferences }),
    false,
    "no dropped device at all: the answer stands",
  );
  //    A device receiving now ends the question, whatever else dropped.
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 1, lastDroppedSubscribedAt: droppedAfter, modulePreferences: dismissedPreferences }),
    false,
    "a person with a device receiving now is never asked, even with another device dropped",
  );
  //    One drop is asked about once: answering again moves the answer past it.
  const answeredAgain = withPushOptInNudgeDismissed(dismissedPreferences, "2026-11-13T18:00:00.000Z");
  assert.equal(
    shouldShowPushOptInNudge({ deviceCount: 0, lastDroppedSubscribedAt: droppedAfter, modulePreferences: answeredAgain }),
    false,
    "after the person answers again, the same drop never asks a third time",
  );
  //    The answer and the device's own record are two requests seconds apart, and either may land first.
  const answerMs = Date.parse(dismissedAt);
  assert.equal(pushWasDroppedSinceAnswer(dismissedAt, new Date(answerMs - 5_000).toISOString()), true, "a device recorded five seconds before the answer it belongs to still counts");
  assert.equal(pushWasDroppedSinceAnswer(dismissedAt, new Date(answerMs - PUSH_RE_ASK_SLACK_MS - 1).toISOString()), false, "past the slack it is an older device");
  assert.ok(PUSH_RE_ASK_SLACK_MS <= 5 * 60_000, "the slack covers two requests seconds apart, not a person's earlier choice");
  //    A date nobody can read is never a reason to ask.
  assert.equal(pushWasDroppedSinceAnswer(dismissedAt, "not a date"), false);
  assert.equal(pushWasDroppedSinceAnswer("not a date", droppedAfter), false, "an unreadable answer is silence, never a card that will not go away");
  assert.equal(pushWasDroppedSinceAnswer(dismissedAt, undefined), false);

  // 8. Source lock on where the drop is read from. 🔴 `unsubscribed_at` is stamped again on EVERY page load
  //    of a browser that is not receiving push, so a rule that read it would bring the card back on every
  //    visit, for ever. `subscribed_at` stops moving when a device stops receiving.
  const settingsSource = stripComments(readFileSync(new URL("../src/lib/notifications/settings.ts", import.meta.url), "utf8"));
  assert.ok(settingsSource.includes('.select("device_type,status,subscribed_at")'), "the settings read asks for when each device was last receiving");
  const mapperAt = settingsSource.indexOf("function mapPushState(");
  assert.notEqual(mapperAt, -1);
  const mapper = settingsSource.slice(mapperAt, settingsSource.indexOf("\n}\n", mapperAt));
  assert.match(mapper, /row\.status !== "subscribed" && typeof row\.subscribed_at === "string"/, "the drop is read from the devices that no longer receive");
  assert.ok(!mapper.includes("unsubscribed_at"), "and never from unsubscribed_at, which every page load of an un-opted-in browser moves");
  assert.ok(mapper.includes("lastDroppedSubscribedAt: droppedLastReceiving[0] ?? null"), "the most recent one is what the card is told");
  const upsert = settingsSource.slice(settingsSource.indexOf("export async function upsertPushSubscription"));
  assert.match(upsert, /if \(input\.optedIn\) payload\.subscribed_at = now;\s*else payload\.unsubscribed_at = now;/, "subscribed_at moves only while a device IS receiving: the fact this rule stands on");
  const cardSource = stripComments(readFileSync(new URL("../src/components/notifications/push-opt-in-nudge.tsx", import.meta.url), "utf8"));
  assert.ok(cardSource.includes("lastDroppedSubscribedAt: settings.pushLastDroppedSubscribedAt"), "the card hands the rule the drop it was told");
}
