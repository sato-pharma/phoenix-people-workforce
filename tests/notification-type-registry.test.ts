// REC-084 — one registry of notification types. This test reads every send in `src/` and `app/`
// (comments stripped, tests and the frozen mobile app left out) and holds
// src/lib/notifications/notification-types.ts to it, both ways:
//
//   - every (module, eventType) a send can produce is registered, under the file that sends it;
//   - every registered type is actually sent, from exactly the files its `sentFrom` names, and by the
//     road its `delivery` says (the engine, a direct email, or both);
//   - every key of the notification policy table names a registered type (or module, for a `.*`
//     wildcard) — or is listed below as a row nothing sends today;
//   - every file that sends with NO type is listed in UNTYPED_SENDS.
//
// What the reader cannot resolve on its own (a helper that forwards its caller's event, or an event
// built from a run-time value) is acknowledged below with the values it can take.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isRegisteredNotificationType,
  listNotificationTypes,
  NOTIFICATION_TYPES,
  UNTYPED_SENDS,
} from "../src/lib/notifications/notification-types.ts";
import { stripComments } from "./support/comment-strip.ts";
import { scanNotificationSendSites, scanUnkeyedSendFiles, type NotificationSendSite } from "./support/notification-send-scan.ts";

/**
 * Sends whose module or event is an expression the reader cannot follow. `forwards` = a helper that
 * passes on what its caller names — the callers are read as sends in their own right. `values` = the
 * documented set the expression takes, each of which must be registered.
 */
const ACKNOWLEDGED: ReadonlyArray<{ file: string; text: string } & ({ forwards: true } | { values: readonly string[] })> = [
  { file: "src/lib/automated-payroll/notify.ts", text: "input.eventType", forwards: true },
  { file: "src/lib/conversations/notify.ts", text: "input.module", forwards: true },
  { file: "src/lib/conversations/notify.ts", text: "input.eventType", forwards: true },
  { file: "src/lib/direct-orders/service.ts", text: "input.eventType", forwards: true },
  { file: "src/lib/direct-orders/service.ts", text: "opts.eventType", forwards: true },
  // decideDirectOrder announces the decision itself: DirectOrderDecision.
  { file: "src/lib/direct-orders/service.ts", text: "input.decision", values: ["approve", "reject", "return"] },
  { file: "src/lib/excuses/service.ts", text: "input.eventType", forwards: true },
  { file: "src/lib/hr-ops-reports/notify.ts", text: "input.eventType", forwards: true },
  { file: "src/lib/marketing-functions/notify.ts", text: "input.eventType", forwards: true },
  { file: "src/lib/marketing-requests/service.ts", text: "params.eventType", forwards: true },
  // The daily SLA pass: mostUrgentMarketingSla picks one of the two reminders.
  { file: "src/lib/marketing-requests/service.ts", text: "eventType", values: ["due_date_reminder", "overdue_reminder"] },
  { file: "src/lib/phoenix-crm/server/notifications.ts", text: "delivery.eventType", forwards: true },
  { file: "src/lib/vacation/service.ts", text: "input.type", forwards: true },
  { file: "src/lib/weekly-planning/service.ts", text: "input.eventType", forwards: true },
  // decideWeeklyPlan tells the employee of a return or a rejection with the action as the event.
  { file: "src/lib/weekly-planning/service.ts", text: "action", values: ["manager_reject", "manager_return", "ceo_reject", "ceo_return"] },
];

/** Events built from a template literal: the documented values, each of which must match it. */
const PATTERN_VALUES: ReadonlyArray<{ file: string; values: readonly string[] }> = [
  {
    file: "src/lib/dispute-center/notify.ts",
    values: ["dispute_center_opened", "dispute_center_message", "dispute_center_decided", "dispute_center_reopen_requested", "dispute_center_reopened", "dispute_center_reopen_declined"],
  },
  { file: "src/lib/notifications/background-jobs-digest.ts", values: ["background_jobs_run_success", "background_jobs_run_failed"] },
  { file: "src/lib/observability/db-host-alert.ts", values: ["database_host_low_memory", "database_host_low_root_disk"] },
  { file: "src/lib/probation/intelligence/milestone-emails.ts", values: ["milestone_day30", "milestone_day60", "milestone_day75"] },
  { file: "src/lib/vacation/service.ts", values: ["manager_review:approve", "manager_review:reject", "decision:approve", "decision:reject", "sla:manager", "sla:hr"] },
];

/** Policy rows no code sends today. Kept, not deleted — the policy is not this test's to change. */
const POLICY_KEYS_NOTHING_SENDS: ReadonlyArray<{ key: string; why: string }> = [
  { key: "expenses.*", why: "no expense notice is sent through the engine" },
  { key: "field_workforce_compliance.*", why: "only a Telegram template and its governance row exist" },
  { key: "marketing_requests.request_completed", why: "in the event union, never sent" },
  { key: "system.announcement", why: "the engine recognises the event, nothing sends it" },
  { key: "telegram.daily_hr_digest", why: "the digest is sent as system.daily_hr_digest" },
  { key: "telegram.delivery_escalation", why: "no sender" },
];

const key = (moduleName: string, eventType: string) => `${moduleName}.${eventType}`;

function policyTableKeys(): string[] {
  const code = stripComments(readFileSync("src/lib/notifications/policy.ts", "utf8"));
  const start = code.indexOf("const policyTable");
  assert.ok(start !== -1, "policy.ts no longer declares `const policyTable` — point this test at where the policy rows now live");
  const end = code.indexOf("\n};", start);
  const body = code.slice(start, end);
  return Array.from(body.matchAll(/^\s*"([^"]+)"\s*:/gm), (m) => m[1]);
}

export function runNotificationTypeRegistryTests() {
  const { sites } = scanNotificationSendSites();
  assert.ok(sites.length > 200, `the send reader found only ${sites.length} sends — it has stopped reading the code`);

  const registered = new Map(NOTIFICATION_TYPES.map((entry) => [key(entry.module, entry.eventType), entry]));
  assert.equal(registered.size, NOTIFICATION_TYPES.length, "a notification type is registered twice");

  // (module.eventType) → the files that send it, and by which road.
  const sent = new Map<string, { direct: boolean; engine: boolean; files: Set<string> }>();
  const record = (site: NotificationSendSite, moduleName: string, eventType: string) => {
    const k = key(moduleName, eventType);
    assert.ok(
      registered.has(k),
      `${site.file}:${site.line} sends module "${moduleName}" eventType "${eventType}", which is not in src/lib/notifications/notification-types.ts`,
    );
    const row = sent.get(k) ?? { direct: false, engine: false, files: new Set<string>() };
    row.files.add(site.file);
    if (site.shape === "direct-email") row.direct = true;
    else row.engine = true;
    sent.set(k, row);
  };

  const usedAcks = new Set<string>();
  const usedPatterns = new Set<string>();
  const valuesOf = (site: NotificationSendSite, which: "module" | "eventType"): string[] | null => {
    const value = site[which];
    if (value.kind === "values") return value.values;
    if (value.kind === "pattern") {
      const documented = PATTERN_VALUES.find((p) => p.file === site.file);
      assert.ok(documented, `${site.file}:${site.line} builds its ${which} as ${value.text} — list the values it can take in PATTERN_VALUES`);
      // A file may build several events from templates: each takes the documented values it can produce.
      const own = documented.values.filter((v) => value.regex.test(v));
      assert.ok(own.length > 0, `${site.file}:${site.line} builds its ${which} as ${value.text}, and none of its PATTERN_VALUES can come out of it`);
      for (const v of own) usedPatterns.add(`${site.file}::${v}`);
      return own;
    }
    const ack = ACKNOWLEDGED.find((a) => a.file === site.file && a.text === value.text);
    assert.ok(ack, `${site.file}:${site.line} sends a ${which} the reader cannot follow (${value.text}) — register its values and acknowledge it in ACKNOWLEDGED`);
    usedAcks.add(`${ack.file}::${ack.text}`);
    return "values" in ack ? [...ack.values] : null;
  };

  for (const site of sites) {
    const modules = valuesOf(site, "module");
    const events = valuesOf(site, "eventType");
    if (!modules || !events) continue; // a forwarder: its callers are the sends
    if (site.file === "src/lib/dispute-center/notify.ts") {
      // Each kind sends only the steps its own file raises — the registry lists them per module; check
      // only that each registered dispute type here is one the template can produce.
      for (const entry of NOTIFICATION_TYPES.filter((e) => e.sentFrom.includes(site.file))) {
        assert.ok(modules.includes(entry.module) && events.includes(entry.eventType), `${entry.module}.${entry.eventType} is registered from ${site.file} but it cannot send it`);
        record(site, entry.module, entry.eventType);
      }
      continue;
    }
    for (const moduleName of modules) for (const eventType of events) record(site, moduleName, eventType);
  }

  for (const ack of ACKNOWLEDGED) assert.ok(usedAcks.has(`${ack.file}::${ack.text}`), `ACKNOWLEDGED names ${ack.file} "${ack.text}", which no longer sends — drop it`);
  for (const p of PATTERN_VALUES) {
    for (const v of p.values) assert.ok(usedPatterns.has(`${p.file}::${v}`), `PATTERN_VALUES gives ${p.file} the value "${v}", which no template in it can produce — drop it`);
  }

  // Every registered type is sent, from the files it says, by the road it says.
  for (const entry of NOTIFICATION_TYPES) {
    const k = key(entry.module, entry.eventType);
    const row = sent.get(k);
    assert.ok(row, `the registry lists ${k} (sentFrom ${entry.sentFrom.join(", ")}) but no code sends it — remove the entry`);
    assert.deepEqual(
      [...entry.sentFrom].sort(),
      [...row.files].sort(),
      `${k}: sentFrom says ${JSON.stringify(entry.sentFrom)}, the code sends it from ${JSON.stringify([...row.files].sort())}`,
    );
    const road = row.direct && row.engine ? "both" : row.direct ? "direct_email" : undefined;
    assert.equal(entry.delivery, road, `${k}: delivery is ${entry.delivery ?? "the engine"}, the code sends it ${road ?? "through the engine"}`);
    assert.ok(entry.label.trim().length > 0, `${k} has no label`);
    assert.ok(isRegisteredNotificationType(entry.module, entry.eventType), `isRegisteredNotificationType misses ${k}`);
  }
  assert.equal(isRegisteredNotificationType("payroll", "no_such_event"), false, "an unknown type must not read as registered");

  // Every policy row names a registered type, or is a row nothing sends.
  const modules = new Set(NOTIFICATION_TYPES.map((entry) => entry.module));
  const policyKeys = policyTableKeys();
  assert.ok(policyKeys.length > 50, `read only ${policyKeys.length} policy rows from policy.ts`);
  for (const policyKey of policyKeys) {
    const stale = POLICY_KEYS_NOTHING_SENDS.some((s) => s.key === policyKey);
    const known = policyKey.endsWith(".*") ? modules.has(policyKey.slice(0, -2)) : registered.has(policyKey);
    if (stale) assert.ok(!known, `${policyKey} is listed as sent by nothing, but the registry now has it — drop it from POLICY_KEYS_NOTHING_SENDS`);
    else assert.ok(known, `src/lib/notifications/policy.ts has a row for "${policyKey}", which the registry does not list`);
  }
  for (const s of POLICY_KEYS_NOTHING_SENDS) assert.ok(policyKeys.includes(s.key), `POLICY_KEYS_NOTHING_SENDS names "${s.key}", which policy.ts no longer has`);

  // Every untyped send is listed, and every listed one still sends.
  const untyped = scanUnkeyedSendFiles();
  const listed = new Set(UNTYPED_SENDS.map((s) => s.file));
  for (const [file, callees] of untyped) {
    assert.ok(listed.has(file), `${file} sends with no notification type (${callees.join(", ")}) — list it in UNTYPED_SENDS`);
  }
  for (const s of UNTYPED_SENDS) assert.ok(untyped.has(s.file), `UNTYPED_SENDS lists ${s.file}, which no longer sends without a type`);

  // The screen's rows: every type resolved through the policy, with readable names only.
  const listedTypes = listNotificationTypes();
  assert.equal(listedTypes.length, NOTIFICATION_TYPES.length);
  for (const row of listedTypes) {
    assert.ok(row.channelLabels.length > 0, `${key(row.module, row.eventType)} resolves to no channel`);
    assert.ok(row.recipientLabels.every(Boolean), `${key(row.module, row.eventType)} has a recipient strategy with no readable name`);
    assert.ok(row.moduleLabel !== row.module || !/[_.]/.test(row.module), `module "${row.module}" has no readable name`);
  }
}
