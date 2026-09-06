import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PUSH_OPT_IN_NUDGE_DISMISSED_KEY,
  isPushOptInNudgeDismissed,
  shouldShowPushOptInNudge,
  withPushOptInNudgeDismissed,
} from "../src/lib/notifications/push-opt-in-nudge-rules.ts";

// The push opt-in nudge exists because 71 of 107 active employees (measured 2026-09-06) have
// never enabled push on any device — the only control for it lived inside Profile, and nothing
// ever pointed anyone at it. This suite pins the two rules that keep the nudge from becoming the
// exact wallpaper it was designed to avoid:
//
//   (a) never shown to someone who already has an ACTIVE push subscription;
//   (b) a dismissal is permanent — once recorded, the nudge never asks that person again.
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
}
