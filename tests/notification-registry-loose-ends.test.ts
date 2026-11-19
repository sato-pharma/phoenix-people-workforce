import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  defaultNotificationCategory,
  NOTIFICATION_BELL_CATEGORIES,
  NOTIFICATION_TYPES,
  OFF_THE_BELL_CATEGORIES,
} from "../src/lib/notifications/notification-types.ts";
import {
  DEFAULT_POLICY_ACKNOWLEDGED,
  isAcknowledgedDefaultPolicy,
  notificationPolicySource,
  resolveNotificationPolicy,
} from "../src/lib/notifications/policy.ts";
import { PERSONAL_BELL_CATEGORIES } from "../src/lib/notifications/recipients.ts";
import { stripComments } from "./support/comment-strip.ts";
import { scanNotificationSendSites } from "./support/notification-send-scan.ts";

// THE NOTIFICATION REGISTRY'S LOOSE ENDS (REC-084 phase 2, 19 Nov 2026).
//
// 1. The personal bell's category allowlist was a hand-kept list in recipients.ts beside the registry.
//    It is now DERIVED from the registry's bell half, and this test holds that half to the code: every
//    category a notice is written under is registered (or deliberately off the bell), and every
//    registered category is still written (or kept only so old notices still open).
// 2. A type with no policy row fell silently to `defaultPolicy`. The fallback now logs a warning, and
//    every registered type has a row or an acknowledged default.
// Neither changes who is told anything: the bell lists the same categories in the same order, and no
// policy value moved.

const key = (moduleName: string, eventType: string) => `${moduleName.toLowerCase()}.${eventType.toLowerCase()}`;

/** The allowlist the bell passed on 19 Nov 2026, before it was derived. A change here is a decision about who sees what. */
const BELL_ON_19_NOV_2026 = [
  "vacation_request",
  "probation",
  "coaching_report",
  "general",
  "internal_message",
  "excuse",
  "recruitment",
  "direct_order_request",
  "early_bird_recommendation",
  "attendance_digest",
  "phoenix_crm",
  "weekly_plan",
  "crm",
  "security",
  "system",
  "market_awareness",
  "outstation",
];

/** A category passed through from the caller: the documented values its callers pass. */
const CATEGORY_FORWARDS: ReadonlyArray<{ file: string; text: string; values: readonly string[] }> = [
  // notifyInterviewParticipants takes its caller's category; both callers pass "recruitment".
  { file: "src/lib/recruitment/interview-notifications.ts", text: "input.category", values: ["recruitment"] },
];

function testTheBellListIsDerivedFromTheRegistry() {
  assert.deepEqual([...PERSONAL_BELL_CATEGORIES], NOTIFICATION_BELL_CATEGORIES.map((entry) => entry.category), "the bell reads the registry");
  assert.deepEqual([...PERSONAL_BELL_CATEGORIES], BELL_ON_19_NOV_2026, "deriving the list changed nothing the bell shows, in the order it always passed");
  assert.equal(new Set(PERSONAL_BELL_CATEGORIES).size, PERSONAL_BELL_CATEGORIES.length, "a category is registered twice");
  for (const entry of NOTIFICATION_BELL_CATEGORIES) {
    assert.equal(entry.category, entry.category.trim().toLowerCase(), `"${entry.category}" must be stored as the engine writes it: trimmed, lower case`);
    assert.ok(entry.why.trim().length > 20, `"${entry.category}" says why it is on the bell`);
  }
  // No hand-kept copy survives in recipients.ts: it names no category of its own.
  const recipients = stripComments(readFileSync(new URL("../src/lib/notifications/recipients.ts", import.meta.url), "utf8"));
  for (const category of PERSONAL_BELL_CATEGORIES) {
    assert.ok(!recipients.includes(`"${category}"`), `recipients.ts names "${category}" by hand again — the bell list lives in the registry`);
  }
  assert.match(recipients, /PERSONAL_BELL_CATEGORIES: readonly string\[\] = NOTIFICATION_BELL_CATEGORIES\.map\(/);
  // The engine's own default comes from the registry too, so the two can never disagree.
  const system = stripComments(readFileSync(new URL("../src/lib/notifications/system.ts", import.meta.url), "utf8"));
  assert.match(system, /return defaultNotificationCategory\(input\.module\);/, "categoryFor asks the registry's default");
  for (const [moduleName, expected] of [
    ["vacation", "vacation_request"],
    ["Leave", "vacation_request"],
    ["excuses", "excuse"],
    ["coaching", "coaching_report"],
    ["internal_messages", "internal_message"],
    ["probation", "probation"],
    ["recruitment", "recruitment"],
    ["marketing_requests", "general"],
    ["phoenix_crm", "general"],
    ["", "general"],
  ] as const) {
    assert.equal(defaultNotificationCategory(moduleName), expected, `a ${moduleName || "module-less"} notice with no category defaults to ${expected}`);
  }
}

function testEveryWrittenCategoryIsRegisteredAndEveryRegisteredOneIsWritten() {
  const { sites } = scanNotificationSendSites();
  const onBell = new Set(NOTIFICATION_BELL_CATEGORIES.map((entry) => entry.category));
  const offBell = new Set(OFF_THE_BELL_CATEGORIES.map((entry) => entry.category));
  const written = new Map<string, Set<string>>();
  const usedForwards = new Set<string>();
  let read = 0;

  for (const site of sites) {
    if (site.category === undefined) continue; // a wrapper or a direct email: no bell category of its own
    let categories: readonly string[] = [];
    if (site.category === null) {
      if (site.module.kind !== "values") continue; // a forwarder: its callers are the sends
      categories = site.module.values.map((moduleName) => defaultNotificationCategory(moduleName));
    } else if (site.category.kind === "values") {
      categories = site.category.values.map((value) => value.trim().toLowerCase());
    } else {
      const text = site.category.text;
      const forward = CATEGORY_FORWARDS.find((f) => f.file === site.file && f.text === text);
      assert.ok(forward, `${site.file}:${site.line} writes its category as ${text}, which the reader cannot follow — list the values it takes in CATEGORY_FORWARDS`);
      usedForwards.add(`${forward.file}::${forward.text}`);
      categories = forward.values;
    }
    for (const category of categories) {
      read += 1;
      assert.ok(
        onBell.has(category) || offBell.has(category),
        `${site.file}:${site.line} writes notices under "${category}", which the registry's bell half does not list — register it in NOTIFICATION_BELL_CATEGORIES (it then shows on its recipients' bells) or in OFF_THE_BELL_CATEGORIES with the reason`,
      );
      const files = written.get(category) ?? new Set<string>();
      files.add(site.file);
      written.set(category, files);
    }
  }
  assert.ok(read > 150, `the reader resolved only ${read} categories — it has stopped reading the sends`);
  for (const forward of CATEGORY_FORWARDS) assert.ok(usedForwards.has(`${forward.file}::${forward.text}`), `CATEGORY_FORWARDS names ${forward.file} "${forward.text}", which no longer writes a category — drop it`);

  for (const entry of NOTIFICATION_BELL_CATEGORIES) {
    if (entry.keptForHistory) {
      assert.ok(!written.has(entry.category), `"${entry.category}" is marked kept for history, but ${[...(written.get(entry.category) ?? [])].join(", ")} writes it again — drop the mark`);
    } else {
      assert.ok(written.has(entry.category), `"${entry.category}" is on the bell but no sender writes it — mark it keptForHistory (so old notices still open) or remove it`);
    }
  }
  for (const entry of OFF_THE_BELL_CATEGORIES) {
    assert.ok(!onBell.has(entry.category), `"${entry.category}" is both on and off the bell`);
    assert.ok(written.has(entry.category), `"${entry.category}" is listed off the bell but nothing writes it — drop it`);
  }
}

function testEveryRegisteredTypeHasAPolicyRowOrAnAcknowledgedDefault() {
  const registered = new Set(NOTIFICATION_TYPES.map((entry) => key(entry.module, entry.eventType)));
  let defaults = 0;
  for (const entry of NOTIFICATION_TYPES) {
    const source = notificationPolicySource(entry);
    if (source !== "default") continue;
    defaults += 1;
    assert.ok(
      isAcknowledgedDefaultPolicy(entry.module, entry.eventType),
      `${key(entry.module, entry.eventType)} has no policy row and is not in DEFAULT_POLICY_ACKNOWLEDGED — give it a row in policy.ts (a decision about who is told) or acknowledge its default with the reason`,
    );
  }
  assert.ok(defaults > 0, "the census found no defaulted type at all — it is not reading the policy");

  const seen = new Set<string>();
  for (const entry of DEFAULT_POLICY_ACKNOWLEDGED) {
    assert.ok(entry.why.trim().length > 10, `the acknowledgement for ${entry.module} gives no reason`);
    for (const eventType of entry.eventTypes) {
      const k = key(entry.module, eventType);
      assert.ok(!seen.has(k), `${k} is acknowledged twice`);
      seen.add(k);
      assert.ok(registered.has(k), `DEFAULT_POLICY_ACKNOWLEDGED names ${k}, which the registry does not list — drop it`);
      assert.equal(notificationPolicySource({ eventType, module: entry.module }), "default", `${k} has a policy row now — drop it from DEFAULT_POLICY_ACKNOWLEDGED`);
    }
  }
}

function testTheDefaultFallbackIsLoggedNotSilent() {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let unknown: ReturnType<typeof resolveNotificationPolicy>;
  try {
    unknown = resolveNotificationPolicy({ eventType: "nothing_sends_this", module: "loose_ends_probe" });
    resolveNotificationPolicy({ eventType: "nothing_sends_this", module: "loose_ends_probe" });
    const acknowledged = DEFAULT_POLICY_ACKNOWLEDGED[0];
    resolveNotificationPolicy({ eventType: acknowledged.eventTypes[0], module: acknowledged.module });
    const withRow = NOTIFICATION_TYPES.find((entry) => notificationPolicySource(entry) === "exact");
    assert.ok(withRow, "some registered type has its own row");
    resolveNotificationPolicy(withRow);
  } finally {
    console.log = realLog;
  }
  const warnings = lines.filter((line) => line.includes("notification_policy_default_used"));
  assert.equal(warnings.length, 1, "an unknown type's fallback is logged — once per process, not on every notice");
  const entry = JSON.parse(warnings[0]) as { labels?: Record<string, string>; severity?: string };
  assert.equal(entry.severity, "WARNING");
  assert.equal(entry.labels?.policy_key, "loose_ends_probe.nothing_sends_this", "the warning names the type");
  // Visible, not changed: the fallback still resolves to exactly what it always did.
  assert.deepEqual(unknown.channels, ["in_app", "email", "push"]);
  assert.deepEqual(unknown.recipientStrategy, ["employee"]);
  assert.equal(unknown.strictRecipients, true);
  assert.equal(unknown.telegramAllowed, false);
}

export function runNotificationRegistryLooseEndsTests() {
  testTheBellListIsDerivedFromTheRegistry();
  testEveryWrittenCategoryIsRegisteredAndEveryRegisteredOneIsWritten();
  testEveryRegisteredTypeHasAPolicyRowOrAnAcknowledgedDefault();
  testTheDefaultFallbackIsLoggedNotSilent();
}
