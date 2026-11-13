import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TELEGRAM_HOME_CARD_ANSWERED_KEY,
  isTelegramHomeCardAnswered,
  shouldShowTelegramHomeCard,
  withTelegramHomeCardAnswered,
} from "../src/lib/notifications/telegram-home-card-rules.ts";
import { PUSH_OPT_IN_NUDGE_DISMISSED_KEY } from "../src/lib/notifications/push-opt-in-nudge-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// The home page's "Connect Telegram" card (owner, 13 Nov 2026: "Every home page, once"). Measured on
// production that day: 55 people connected, 34 started and 32 of those never finished.
//
//   1  who is asked: everybody not connected, never a test account
//   2  ONCE: an answer (closed, or connected through the card) is permanent, and additive in module_preferences
//   3  the SERVER decides, in the settings read, and the card draws what it said
//   4  the answer is written by its own route, with the permission of whoever is shown the card
//   5  the card is on all six home pages, directly under the push card, and the two share one settings read
//   6  its one button goes into the existing connect flow: there is no second way to connect

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const HOME_PAGES = [
  "src/components/admin/ceo-command-center.tsx",
  "src/components/admin/finance-command-center.tsx",
  "src/components/employee-portal/portal-command-center.tsx",
  "src/components/hr/hr-command-center.tsx",
  "src/components/hr/hr-operations-overview.tsx",
  "src/components/hr/talent-acquisition-overview.tsx",
];

export function runTelegramHomeCardTests() {
  // 1. Who is asked.
  const fresh = { isTestAccount: false, modulePreferences: {} };
  for (const status of ["not_connected", "pending", "failed", "disabled", null, undefined]) {
    assert.equal(
      shouldShowTelegramHomeCard({ ...fresh, telegramStatus: status }),
      true,
      `a person whose Telegram reads ${String(status)} is asked: a link never finished reaches nobody, the same as no link`,
    );
  }
  assert.equal(shouldShowTelegramHomeCard({ ...fresh, telegramStatus: "connected" }), false, "a connected person is never asked");
  assert.equal(
    shouldShowTelegramHomeCard({ isTestAccount: true, modulePreferences: {}, telegramStatus: "not_connected" }),
    false,
    "a test account is never asked: its messages go nowhere real",
  );
  assert.equal(
    shouldShowTelegramHomeCard({ isTestAccount: false, modulePreferences: null, telegramStatus: "not_connected" }),
    true,
    "a person with no notification_preferences row at all is still asked",
  );

  // 2. Once.
  const answeredAt = "2026-11-13T18:00:00.000Z";
  const answered = withTelegramHomeCardAnswered({ someOtherFeatureFlag: true, [PUSH_OPT_IN_NUDGE_DISMISSED_KEY]: "2026-09-06T10:00:00.000Z" }, answeredAt);
  assert.equal(answered[TELEGRAM_HOME_CARD_ANSWERED_KEY], answeredAt, "the answer is recorded under its own key");
  assert.equal(answered.someOtherFeatureFlag, true, "and erases nothing else stored in module_preferences");
  assert.equal(answered[PUSH_OPT_IN_NUDGE_DISMISSED_KEY], "2026-09-06T10:00:00.000Z", "the push card's own answer least of all");
  assert.equal(isTelegramHomeCardAnswered(answered), true);
  for (const status of ["not_connected", "pending", "failed", "disabled"]) {
    assert.equal(
      shouldShowTelegramHomeCard({ isTestAccount: false, modulePreferences: answered, telegramStatus: status }),
      false,
      `once answered, the card never returns, whatever Telegram reads later (${status}): a card asked twice becomes wallpaper`,
    );
  }
  assert.equal(isTelegramHomeCardAnswered({ [TELEGRAM_HOME_CARD_ANSWERED_KEY]: true }), false, "only a real timestamp is an answer");
  assert.equal(
    isTelegramHomeCardAnswered({ [PUSH_OPT_IN_NUDGE_DISMISSED_KEY]: answeredAt }),
    false,
    "answering the push card is not answering this one: two cards, two keys",
  );
  assert.notEqual(TELEGRAM_HOME_CARD_ANSWERED_KEY, PUSH_OPT_IN_NUDGE_DISMISSED_KEY);

  // 3. The server decides.
  const settingsRoute = stripComments(read("app/api/notifications/settings/route.ts"));
  assert.match(
    settingsRoute,
    /shouldShowTelegramHomeCard\(\{\s*isTestAccount: Boolean\(access\.testPersona\),\s*modulePreferences: data\.preferences\.modulePreferences,\s*telegramStatus: data\.telegram\.status,\s*\}\)/,
    "the settings read asks the rule with the server's own facts: the test account, the stored answer, the stored connection",
  );
  assert.match(settingsRoute, /NextResponse\.json\(\{ data, homeCards, success: true \}\)/, "and hands the card its answer beside the settings");
  const shared = stripComments(read("src/components/notifications/home-notification-settings.ts"));
  assert.ok(shared.includes("telegramCard: payload.homeCards?.telegram === true"), "the card is drawn only on the server's plain yes");
  const card = stripComments(read("src/components/notifications/telegram-home-card.tsx"));
  assert.ok(card.includes('setState(settings?.telegramCard ? "ask" : "hidden")'), "settings that cannot be read draw nothing");
  assert.ok(!card.includes("telegram-home-card-rules"), "the card does not decide for itself who is asked");

  // 4. The answer's own route.
  const answerRoute = stripComments(read("app/api/notifications/telegram/home-card/route.ts"));
  assert.match(answerRoute, /export async function POST\(/);
  assert.match(answerRoute, /await assertPermission\(access, "employee_profile", "read"\);\s*await recordTelegramHomeCardAnswered\(access\);/, "whoever is shown the card can answer it, and the permission is asserted before the write");
  const settings = read("src/lib/notifications/settings.ts");
  const writerAt = settings.indexOf("export async function recordTelegramHomeCardAnswered");
  assert.notEqual(writerAt, -1);
  const writer = settings.slice(writerAt, settings.indexOf("\n}\n", writerAt));
  assert.ok(writer.includes("mergeIntoModulePreferences(") && writer.includes("withTelegramHomeCardAnswered("), "the answer is merged into module_preferences, never written over it");
  assert.ok(
    read("src/lib/security/access-registry.ts").includes('pattern: "/api/notifications/telegram/home-card", permission: { resource: "employee_profile", action: "read" }'),
    "the route is in the access registry with the permission it asserts",
  );
  assert.equal((card.match(/recordAnswer\(\)/g) ?? []).length, 4, "the answer is written when the card is closed and at both places it learns of a connection (plus its own definition)");
  assert.match(card, /function close\(\) \{\s*setState\("hidden"\);\s*recordAnswer\(\);/, "closing the card is an answer");

  // 5. Every home page, under the push card, one read between them.
  for (const page of HOME_PAGES) {
    const code = stripComments(read(page));
    assert.match(code, /<PushOptInNudge \/>\s*<TelegramHomeCard \/>/, `${page} draws the Telegram card directly under the push card`);
    assert.equal((code.match(/<TelegramHomeCard \/>/g) ?? []).length, 1, `${page} draws it once`);
  }
  const pushCard = stripComments(read("src/components/notifications/push-opt-in-nudge.tsx"));
  for (const [name, code] of [["the push card", pushCard], ["the Telegram card", card]] as const) {
    assert.ok(code.includes("readHomeNotificationSettings()"), `${name} reads the settings through the shared read`);
    assert.ok(!code.includes('fetch("/api/notifications/settings"'), `${name} never asks for the settings on its own`);
  }
  assert.match(shared, /if \(inFlight\) return inFlight;/, "a read in flight is shared by every card on the page");
  assert.match(shared, /\.finally\(\(\) => \{\s*if \(inFlight === read\) inFlight = null;/, "and forgotten when it answers, so the next page reads afresh");

  // 6. One connect flow.
  assert.ok(card.includes("requestTelegramConnectLink()") && card.includes("readTelegramConnectionStatus()"), "the card connects through the one client helper");
  assert.ok(!card.includes("/api/integrations/telegram"), "and never calls a Telegram route of its own");
  assert.ok(!/rounded-(?!none)/.test(card), "square edges, like the push card beside it");
}
