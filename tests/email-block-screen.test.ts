import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildEmailBlockView } from "../src/lib/email/suppression-admin.ts";
import { LIFT_WARNING_TEXT } from "../src/lib/email/suppression-words.ts";
import { emailBlockNotice, newlyBlockedPeople } from "../src/lib/email/suppression-watch.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const block = (address: string, reason: string, hoursAgo: number, expires_at: string | null = null) => ({
  address,
  bounce_subtype: reason === "hard_bounce" ? "552 mailbox not found" : null,
  created_at: ago(hoursAgo),
  expires_at,
  reason,
});

const person = (hr_id: string, work_email: string | null, employment_status: string | null = "active") => ({
  employment_status,
  full_name: `Person ${hr_id}`,
  hr_id,
  job_title: "Rep",
  work_email,
});

export function runEmailBlockScreenTests() {
  const view = buildEmailBlockView(
    [
      block("old@sato.com", "hard_bounce", 500),
      block("recent@sato.com", "hard_bounce", 1),
      block("spam@gmail.com", "complaint", 2),
      block("left@sato.com", "hard_bounce", 3),
      block("stranger@x.com", "unsubscribe", 4),
      block("manual@sato.com", "manual", 600),
      block("expired@sato.com", "hard_bounce", 700, ago(1)),
    ],
    [
      person("A", "OLD@sato.com "),
      person("B", "recent@sato.com"),
      person("C", "left@sato.com", "resigned"),
      person("D", "manual@sato.com", "on_leave"),
      person("E", "expired@sato.com"),
      person("F", null),
      person("G", "  "),
      person("H", null, "historical_payroll_record"),
      person("I", null, "system_placeholder"),
      person("J", null, null),
    ],
    NOW,
  );

  assert.deepEqual(
    view.blocked.map((row) => row.address),
    ["recent@sato.com", "old@sato.com", "manual@sato.com", "spam@gmail.com", "left@sato.com", "stranger@x.com"],
    "active employees first, then newest first; an expired row is not a block",
  );
  const byAddress = new Map(view.blocked.map((row) => [row.address, row]));
  assert.equal(byAddress.get("old@sato.com")?.personName, "Person A", "an address matches whatever its case and spaces");
  assert.equal(byAddress.get("manual@sato.com")?.personActive, true, "on leave is still an active person");
  assert.equal(byAddress.get("left@sato.com")?.personActive, false, "a leaver is named, and not counted as active");
  assert.equal(byAddress.get("stranger@x.com")?.personName, null);
  assert.equal(byAddress.get("recent@sato.com")?.providerWords, "552 mailbox not found", "the provider's words are shown");

  // A complaint or an unsubscribe is the person's own word.
  assert.equal(byAddress.get("recent@sato.com")?.liftable, true);
  assert.equal(byAddress.get("manual@sato.com")?.liftable, true);
  assert.equal(byAddress.get("spam@gmail.com")?.liftable, false, "a complaint is never lifted here");
  assert.equal(byAddress.get("stranger@x.com")?.liftable, false, "an unsubscribe is never lifted here");

  assert.deepEqual(
    view.noWorkEmail.map((row) => row.name),
    ["Person F", "Person G"],
    "active people with no work email, not payroll history or placeholders",
  );

  // The words say the thing that bites.
  assert.match(LIFT_WARNING_TEXT, /sends nothing/);
  assert.match(LIFT_WARNING_TEXT, /create the mailbox first/);

  // The alert: only rows inside 48 hours, only active employees. The old blocks page nobody on deploy.
  const fresh = newlyBlockedPeople(
    [block("recent@sato.com", "hard_bounce", 47), block("old@sato.com", "hard_bounce", 49), block("left@sato.com", "hard_bounce", 1), block("x@x.com", "complaint", 1)],
    [person("B", "recent@sato.com"), person("A", "old@sato.com"), person("C", "left@sato.com", "terminated")],
    NOW,
  );
  assert.deepEqual(fresh.map((row) => row.hrId), ["B"]);

  const one = emailBlockNotice([{ address: "a@b", hrId: "A", name: "A" }]);
  const two = emailBlockNotice([{ address: "a@b", hrId: "A", name: "A" }, { address: "c@d", hrId: "C", name: "C" }]);
  assert.notEqual(one.idempotencyKey, two.idempotencyKey, "a new person gets through");
  assert.equal(one.idempotencyKey, emailBlockNotice([{ address: "a@b", hrId: "A", name: "A" }]).idempotencyKey, "the same set says it once");

  // Never email, and the sweep carries it.
  const watch = readFileSync("src/lib/email/suppression-watch.ts", "utf8");
  assert.match(watch, /channels: \["in_app", "telegram", "push"\]/, "an address email cannot reach is not told by email");
  assert.match(watch, /hrIdsForRoles\(\["Super Admin"\]\)/);
  assert.match(readFileSync("app/api/cron/job-heartbeat-sweep/route.ts", "utf8"), /const emailBlocks = await runEmailBlockWatch\(\);/);

  // Super Admin only, at the server, and the lift sends nothing.
  const admin = readFileSync("src/lib/email/suppression-admin.ts", "utf8");
  assert.match(admin, /access\.role !== "Super Admin"/);
  assert.match(admin, /assertRealSessionForDecision\(access, "lift a blocked email"\)/, "a preview session decides nothing");
  assert.match(admin, /await writeRequiredAuditLog\(/, "a lift with no audit is a failed lift");
  assert.doesNotMatch(admin, /sendPhoenixEmail|send-phoenix-email|resend\.|Resend\b/, "a lift sends nothing and touches no provider setting");
  const route = readFileSync("app/api/admin/email-suppressions/route.ts", "utf8");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);/);
  const entry = findAccessRegistryEntry("/api/admin/email-suppressions", "POST");
  assert.equal(entry?.audit.required, true);
  assert.equal(entry?.csrf.required, true);
  assert.match(
    readFileSync("app/(admin)/admin/notifications/email/page.tsx", "utf8"),
    /access\.role === "Super Admin" \? <EmailSuppressionPanel \/> : null/,
    "the panel is mounted for the Super Admin only",
  );
}
