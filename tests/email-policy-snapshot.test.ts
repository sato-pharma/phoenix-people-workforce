import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveNotificationDelivery, type EmailNotificationPolicy } from "../src/lib/notifications/email.ts";
import {
  EMAIL_POLICY_SNAPSHOT_MAX_AGE_MS,
  readEmailPolicies,
  withEmailPolicySnapshot,
} from "../src/lib/notifications/email-policy-snapshot.ts";
import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The outbox drain used to read the whole email-policy table once per email. Sentry named it the
 * "N+1 API Call" on GET /api/notifications/process (PHOENIX-WORKFORCE-4): ten emails, ten identical
 * selects. `resolveNotificationDelivery` needs ONE type's policy and the only read available was the
 * whole table's.
 *
 * The fix shares one read across a drain run (`withEmailPolicySnapshot`, an AsyncLocalStorage scope
 * opened by `runScheduledNotificationProcessing`) and nothing else:
 *   - outside a run every read is still fresh — an admin screen and a save never see a held copy;
 *   - inside a run the copy is at most 10 seconds old, so a policy switched off mid-run is noticed;
 *   - a FAILED read is never remembered, or one blip would refuse every email left in the run;
 *   - two runs never see each other's copy, and a finished run leaves nothing behind.
 */
export async function runEmailPolicySnapshotTests() {
  const policy = (label: string): EmailNotificationPolicy[] => [{ label } as unknown as EmailNotificationPolicy];

  // ── 1. THE MODULE ──────────────────────────────────────────────────────────────────────────────
  {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return policy(`read ${loads}`);
    };

    await readEmailPolicies(load);
    await readEmailPolicies(load);
    assert.equal(loads, 2, "outside a snapshot scope every read is a fresh read — nothing is cached between runs");

    loads = 0;
    await withEmailPolicySnapshot(async () => {
      await readEmailPolicies(load);
      await readEmailPolicies(load);
      await readEmailPolicies(load);
    });
    assert.equal(loads, 1, "inside a run, three sequential reads cost ONE load of the table");

    loads = 0;
    await withEmailPolicySnapshot(async () => {
      await Promise.all([1, 2, 3, 4, 5].map(() => readEmailPolicies(load)));
    });
    assert.equal(loads, 1, "five CONCURRENT reads in a run share the one in-flight load, not five");

    loads = 0;
    await withEmailPolicySnapshot(async () => {
      await readEmailPolicies(load);
    });
    await readEmailPolicies(load);
    assert.equal(loads, 2, "a finished run leaves nothing behind — the read after it loads again");
  }

  // A failed read is not remembered.
  {
    let loads = 0;
    const flaky = async () => {
      loads += 1;
      if (loads === 1) throw new Error("table read failed");
      return policy("recovered");
    };
    const second = await withEmailPolicySnapshot(async () => {
      await assert.rejects(readEmailPolicies(flaky), /table read failed/);
      return readEmailPolicies(flaky).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    });
    assert.ok(
      "value" in second,
      "a failed read must NOT be remembered — the next caller of the run was handed the same failure, "
        + "which would refuse every email left in the run over one blip",
    );
    assert.equal(loads, 2, "after a failed read the next caller asks the table again");
    assert.equal(second.value[0]?.label, "recovered", "…and gets the real answer, not the remembered failure");
  }

  // A held copy expires, so a long run still notices a policy switched off while it was working.
  {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return policy(`read ${loads}`);
    };
    assert.equal(EMAIL_POLICY_SNAPSHOT_MAX_AGE_MS, 10_000, "the snapshot is at most ten seconds old");
    await withEmailPolicySnapshot(async () => {
      await readEmailPolicies(load, 1_000_000);
      await readEmailPolicies(load, 1_000_000 + EMAIL_POLICY_SNAPSHOT_MAX_AGE_MS - 1);
      assert.equal(loads, 1, "a copy one millisecond short of the limit is still reused");
      await readEmailPolicies(load, 1_000_000 + EMAIL_POLICY_SNAPSHOT_MAX_AGE_MS);
      assert.equal(loads, 2, "a copy at the limit is read again");
    });
  }

  // Two runs never see each other's copy.
  {
    const seenBy: Record<string, string | undefined> = {};
    const run = (name: string) =>
      withEmailPolicySnapshot(async () => {
        const first = await readEmailPolicies(async () => policy(`${name} loaded`));
        await new Promise((resolve) => setTimeout(resolve, 5));
        const again = await readEmailPolicies(async () => policy(`${name} loaded AGAIN`));
        seenBy[name] = `${first[0]?.label} / ${again[0]?.label}`;
      });
    await Promise.all([run("alpha"), run("beta")]);
    assert.equal(seenBy.alpha, "alpha loaded / alpha loaded", "run alpha only ever sees its own copy");
    assert.equal(seenBy.beta, "beta loaded / beta loaded", "run beta only ever sees its own copy");
  }

  // ── 2. END TO END: count the real requests the delivery path makes ───────────────────────────────
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const realFetch = globalThis.fetch;
  let clientSeq = 0;

  function stubPolicyTable(enabled: boolean) {
    clientSeq += 1;
    // A new URL rebuilds the memoized admin client, so this test never leans on one built elsewhere.
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://email-policy-snapshot-${clientSeq}.example.supabase.co`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-email-policy-snapshot";
    getSupabaseAdmin();
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(
        JSON.stringify([{ notification_type: "birthday", enabled, label: "Birthday" }]),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }) as typeof globalThis.fetch;
    return {
      get policyReads() {
        return urls.filter((url) => url.includes("/rest/v1/email_notification_policies")).length;
      },
      get requests() {
        return urls.length;
      },
    };
  }

  const birthdayEmail = {
    notificationType: "birthday" as const,
    subject: "Happy birthday",
    summary: "Many happy returns.",
    title: "Happy birthday",
  };

  try {
    // The headline: five emails in one run read the table once.
    const inRun = stubPolicyTable(false);
    const results = await withEmailPolicySnapshot(async () => {
      const out = [];
      for (let i = 0; i < 5; i += 1) out.push(await resolveNotificationDelivery(birthdayEmail));
      return out;
    });
    assert.equal(
      inRun.policyReads,
      1,
      "five emails resolved inside one drain run must read email_notification_policies ONCE — "
        + "one identical select per email is the N+1 Sentry reported on /api/notifications/process",
    );
    assert.equal(inRun.requests, 1, "and nothing else is requested while a disabled type is refused");

    // Sharing the read must never loosen the gate: a disabled policy still blocks every one of them.
    for (const result of results) {
      assert.equal(result.skipped, true, "a disabled policy still blocks the email");
      assert.match(String((result as { reason?: string }).reason), /disabled/i);
    }

    // Outside a run nothing is shared, so an admin's change is seen by the very next email.
    const outsideRun = stubPolicyTable(false);
    for (let i = 0; i < 5; i += 1) await resolveNotificationDelivery(birthdayEmail);
    assert.equal(outsideRun.policyReads, 5, "outside a run every delivery still reads the table fresh");

    // A second run starts from the table as it is now.
    const twoRuns = stubPolicyTable(false);
    await withEmailPolicySnapshot(() => resolveNotificationDelivery(birthdayEmail));
    await withEmailPolicySnapshot(() => resolveNotificationDelivery(birthdayEmail));
    assert.equal(twoRuns.policyReads, 2, "each drain run reads the table once for itself");
  } finally {
    globalThis.fetch = realFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  // ── 3. THE WIRING, READ FROM THE CODE (comments stripped, so an explaining comment cannot satisfy it)
  {
    const scheduled = stripComments(readFileSync(new URL("../src/lib/notifications/scheduled-processing.ts", import.meta.url), "utf8"));
    assert.match(
      scheduled,
      /export function runScheduledNotificationProcessing\(limit = 10\) \{\s*return withEmailPolicySnapshot\(\(\) => runNotificationProcessingSteps\(limit\)\);/,
      "the cron's whole run must execute inside withEmailPolicySnapshot, or every email re-reads the policy table",
    );

    const email = stripComments(readFileSync(new URL("../src/lib/notifications/email.ts", import.meta.url), "utf8"));
    const bodyOf = (start: string) => {
      const from = email.indexOf(start);
      assert.ok(from >= 0, `${start} must exist in email.ts`);
      return email.slice(from, email.indexOf("\n}\n", from));
    };
    assert.match(
      bodyOf("async function getEmailNotificationPolicy("),
      /await readEmailPolicies\(getEmailNotificationPolicies\)/,
      "the delivery path's single-type read must go through the run's snapshot",
    );
    assert.ok(
      !bodyOf("export async function getEmailNotificationPolicies(").includes("readEmailPolicies"),
      "the whole-table read stays unwrapped — the admin screens must always see the table as it is",
    );
    assert.ok(
      !bodyOf("export async function saveEmailNotificationPolicy(").includes("getEmailNotificationPolicy("),
      "a save compares against a fresh read of the table, never a run's snapshot",
    );
  }
}
