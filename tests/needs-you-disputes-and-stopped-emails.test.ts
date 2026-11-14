// Two queues that only a badge or a buried screen used to show now sit on the Needs You board
// (enterprise audit REC-031, 14 Nov 2026):
//
//   - DEDUCTION DISPUTES nobody has answered. The Deduction Disputes rail badge was the only place they
//     showed, and its route settles a failed read at 0, so a dispute could wait unseen.
//   - APPROVAL EMAILS THAT STOPPED after every outbox retry. They are not tried again until someone
//     presses "send again" on Email Notifications; the drain alarm sees them only for a week.
//
// The board links to the screen where each is handled and decides nothing itself. No database is
// touched: the admin client is pointed at a dummy URL and `fetch` is stubbed, then both are restored.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { systemAccessContext, type AccessContext } from "../src/lib/auth/permissions.ts";
import { countExhaustedDurableEmails } from "../src/lib/notifications/durable-email.ts";
import { notificationOutboxMaxAttempts } from "../src/lib/notifications/email.ts";
import { needsYouAdapters } from "../src/lib/needs-you/sources.ts";
import { needsYouDestinations, needsYouSourceIds, needsYouSourceLabels } from "../src/lib/needs-you/types.ts";
import { stripComments } from "./support/comment-strip.ts";

const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const HOST = "http://needs-you-rec031.invalid";

async function withStubbedDatabase(answer: (url: string) => Response, run: () => Promise<void>) {
  const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const savedFetch = globalThis.fetch;
  const asked: string[] = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = HOST;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
    asked.push(url);
    return answer(url);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
  assert.ok(asked.every((url) => url.startsWith(`${HOST}/`)), "the test never reaches a real database");
  return asked;
}

function json(body: unknown, init: { status?: number; total?: number } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.total !== undefined) headers["content-range"] = `0-0/${init.total}`;
  return new Response(JSON.stringify(body), { headers, status: init.status ?? 200 });
}

const refused = () => json({ code: "42501", details: null, hint: null, message: "permission denied" }, { status: 403 });

function adapter(id: string) {
  const found = needsYouAdapters.find((a) => a.id === id);
  assert.ok(found, `${id} has an adapter in the registry`);
  return found;
}

const NOW = new Date("2026-11-14T10:00:00Z");
const hrOperations: AccessContext = { hrId: "B-999", role: "HR Operations", scope: "company", source: "dev-header" };

async function testStoppedEmailCount() {
  // The count reads exactly the rows Email Notifications lists: failed, direct emails, out of retries.
  const asked = await withStubbedDatabase(
    () => json([{ created_at: "2026-11-02T08:00:00Z" }], { total: 3 }),
    async () => {
      assert.deepEqual(await countExhaustedDurableEmails(), { count: 3, oldestAt: "2026-11-02T08:00:00Z" });
    },
  );
  assert.equal(asked.length, 1, "one read: the exact count and the single oldest row together");
  const [url] = asked;
  assert.match(url, /\/notification_outbox\?/, "it reads the notification outbox");
  assert.match(url, /status=eq\.failed/, "only failed rows");
  assert.match(url, /payload->>kind=eq\.direct_email/, "only durable direct emails — the ones Send again re-queues");
  assert.match(url, new RegExp(`attempts=gte\\.${notificationOutboxMaxAttempts}`), "only rows that used every retry");
  assert.match(url, /order=created_at\.asc/, "the oldest first, so its age is the queue's age");

  // A failed read THROWS: the board shows the source amber, never a calm zero.
  await withStubbedDatabase(refused, async () => {
    await assert.rejects(countExhaustedDurableEmails(), "an unreadable outbox is an error, never a zero");
  });
}

async function testStoppedEmailAdapter() {
  const source = adapter("stopped-approval-emails");
  await withStubbedDatabase(
    () => json([{ created_at: "2026-11-02T08:00:00Z" }], { total: 2 }),
    async () => {
      const state = await source.load(systemAccessContext, NOW);
      assert.equal(state.status, "ok");
      assert.ok(state.status === "ok");
      assert.equal(state.items.length, 1, "one row for the whole queue");
      const [item] = state.items;
      assert.equal(item.count, 2);
      assert.equal(item.lane, "yours");
      assert.equal(item.kind, "flag", "the person was told in-app; what is lost is the email, so it is a flag");
      assert.equal(item.href, "/admin/email-notifications", "it links to where Send again lives");
      assert.equal(item.oldestAt, "2026-11-02T08:00:00Z");
      assert.equal(item.ageDays, 12, "its age is the oldest stopped email's");
      assert.match(item.label, /^2 approval emails stopped after every retry/);
    },
  );
  await withStubbedDatabase(
    () => json([], { total: 0 }),
    async () => {
      assert.deepEqual(await source.load(systemAccessContext, NOW), { status: "ok", items: [] }, "nothing stopped, nothing shown");
    },
  );
  await withStubbedDatabase(refused, async () => {
    await assert.rejects(source.load(systemAccessContext, NOW), "a failed read reaches the board as amber");
  });

  // Gated on the same permission Send again needs — before the outbox is read.
  const code = stripComments(readFileSync("src/lib/needs-you/sources.ts", "utf8"));
  const body = code.slice(code.indexOf("const stoppedApprovalEmails"), code.indexOf("const vendorGithub"));
  assert.match(
    body,
    /await assertPermission\(access, "admin", "update"\);\s*const \{ count, oldestAt \} = await countExhaustedDurableEmails\(\);/,
    "only someone who can press Send again is shown the row, and the gate runs before the read",
  );
}

async function testDeductionDisputesAdapter() {
  const source = adapter("deduction-disputes");

  // Anyone but the Super Admin: not theirs to answer — and nothing is read.
  const asked = await withStubbedDatabase(refused, async () => {
    assert.deepEqual(await source.load(hrOperations, NOW), {
      status: "not-applicable",
      because: "A deduction dispute is answered by the Super Admin alone",
    });
  });
  assert.equal(asked.length, 0, "a viewer who cannot reply costs no read");

  // The Super Admin with no dispute history: a calm, true zero.
  await withStubbedDatabase(
    () => json([]),
    async () => {
      assert.deepEqual(await source.load(systemAccessContext, NOW), { status: "ok", items: [] });
    },
  );

  // A failed read is amber, never the badge route's silent 0.
  await withStubbedDatabase(refused, async () => {
    await assert.rejects(source.load(systemAccessContext, NOW), "an unreadable dispute history is an error, never a zero");
  });

  // One producer: the board counts through the function behind the rail badge, never a copy of it.
  const code = stripComments(readFileSync("src/lib/needs-you/sources.ts", "utf8"));
  const body = code.slice(code.indexOf("const deductionDisputes"), code.indexOf("const stoppedApprovalEmails"));
  assert.match(body, /count: await countOpenDeductionsDisputes\(\)/, "the board and the badge share one counter");
  assert.match(body, /if \(!isDeductionsDecisionActor\(access\)\)/, "the gate is the deductions decision actor");
}

function testWiring() {
  for (const id of ["deduction-disputes", "stopped-approval-emails"] as const) {
    assert.ok(needsYouSourceIds.includes(id), `${id} is a registered Needs You source`);
    assert.ok(needsYouSourceLabels[id], `${id} has a label`);
    assert.equal(adapter(id).cost, undefined, `${id} is a light source (one small read each)`);
  }
  assert.deepEqual(needsYouDestinations["deduction-disputes"], { href: "/admin/deductions?tab=disputes", screen: "Deduction Disputes" });
  assert.deepEqual(needsYouDestinations["stopped-approval-emails"], { href: "/admin/email-notifications", screen: "Email Notifications" });
}

export async function runNeedsYouDisputesAndStoppedEmailsTests() {
  testWiring();
  await testStoppedEmailCount();
  await testStoppedEmailAdapter();
  await testDeductionDisputesAdapter();
}
