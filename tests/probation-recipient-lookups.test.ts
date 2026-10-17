import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createProbationRecipientLookups, resolveFeedbackExtraRecipients } from "../src/lib/probation/service.ts";
import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The notifications cron's probation step read the same role lists once per employee on probation —
 * two to four identical `app_auth_users` selects each — so one request carried 30 of them. Sentry
 * flags it as the "N+1 API Call" on GET /api/notifications/process (PHOENIX-WORKFORCE-4); the spans
 * read "GET [Filtered]" because Sentry hides any URL that names "auth".
 *
 * The run now makes ONE read of each list and shares it between its employees. A shared read must not
 * widen a blip: a failed role read is never kept (the next employee asks again), and an empty approver
 * list — impossible while a Super Admin exists, so a failed read — is re-read rather than shared.
 */
export async function runProbationRecipientLookupsTests() {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const realFetch = globalThis.fetch;
  let clientSeq = 0;

  const rolesBody = JSON.stringify([
    { hr_id: "NSM-1", role: "National Sales Manager" },
    { hr_id: "TM-1", role: "Training Manager" },
  ]);
  const ok = () => new Response(rolesBody, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  const pgError = () =>
    new Response(JSON.stringify({ code: "42P01", message: "relation does not exist" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  /** A fresh client each time, so this test never leans on one built elsewhere. Each reply in order; the last repeats. */
  function stub(replies: Array<() => Response>) {
    clientSeq += 1;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://probation-lookups-${clientSeq}.example.supabase.co`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-probation-lookups";
    getSupabaseAdmin();
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return replies[Math.min(urls.length - 1, replies.length - 1)]!();
    }) as typeof globalThis.fetch;
    return {
      get authReads() {
        return urls.filter((url) => url.includes("/rest/v1/app_auth_users")).length;
      },
    };
  }

  // A CNS employee with no manager chain: the answer is just the Training Manager list, so a shared read can be told from an empty one.
  const employee = { lineName: "CNS", lineId: null } as unknown as Parameters<typeof resolveFeedbackExtraRecipients>[0];

  try {
    // ── The headline: ten employees in one run make ONE read ─────────────────────────────────────
    {
      const reads = stub([ok]);
      const lookups = createProbationRecipientLookups(["B-10"]);
      const answers = await Promise.all(
        Array.from({ length: 10 }, () => resolveFeedbackExtraRecipients(employee, [], lookups)),
      );
      assert.equal(
        reads.authReads,
        1,
        "ten employees resolved in one run must read app_auth_users ONCE — one identical select per "
          + "employee is the N+1 Sentry reported on /api/notifications/process",
      );
      for (const answer of answers) {
        assert.deepEqual(answer.tmHrIds, ["tm-1"], "every employee still gets the role list the shared read returned");
      }
    }

    // Without a run's lookups nothing is shared, so every other caller still reads fresh.
    {
      const reads = stub([ok]);
      await Promise.all(Array.from({ length: 10 }, () => resolveFeedbackExtraRecipients(employee, [])));
      assert.equal(reads.authReads, 10, "outside a run (the single-employee callers) every call still reads the table");
    }

    // A failed role read is not kept: the next employee asks again and gets the real answer.
    {
      const reads = stub([pgError, ok]);
      const lookups = createProbationRecipientLookups(["B-10"]);
      const first = await resolveFeedbackExtraRecipients(employee, [], lookups);
      assert.deepEqual(first.tmHrIds, [], "a failed read still answers nobody, exactly as before");
      const second = await resolveFeedbackExtraRecipients(employee, [], lookups);
      assert.equal(
        reads.authReads,
        2,
        "a failed role read must NOT be shared — otherwise one blip leaves every later employee in the run "
          + "without its Training Manager and National Sales Manager, and the reminder row keeps those recipients for good",
      );
      assert.deepEqual(second.tmHrIds, ["tm-1"], "the employee after the failure gets the real list");
    }

    // The HR approver list: shared when present, re-read when empty.
    {
      const reads = stub([ok]);
      const lookups = createProbationRecipientLookups(["B-10"]);
      assert.deepEqual(await lookups.hrApproverHrIds(), ["B-10"]);
      assert.deepEqual(await lookups.hrApproverHrIds(), ["B-10"]);
      assert.equal(reads.authReads, 0, "the approvers the run already read at its start are reused, not re-read per employee");

      const emptyReads = stub([ok]);
      const emptyLookups = createProbationRecipientLookups([]);
      await emptyLookups.hrApproverHrIds();
      await emptyLookups.hrApproverHrIds();
      assert.equal(emptyReads.authReads, 2, "an empty approver list means the read failed, so it is asked again, never shared");
    }
  } finally {
    globalThis.fetch = realFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }

  // ── The wiring, read from the code (comments stripped, so an explaining comment cannot satisfy it) ──
  {
    const source = stripComments(readFileSync(new URL("../src/lib/probation/service.ts", import.meta.url), "utf8"));
    const bodyOf = (start: string) => {
      const from = source.indexOf(start);
      assert.ok(from >= 0, `${start} must exist in service.ts`);
      return source.slice(from, source.indexOf("\n}\n", from));
    };
    const run = bodyOf("export async function processDueProbationReminderEvents(");
    assert.match(run, /createProbationRecipientLookups\(hrApproverHrIds\)/, "the run builds ONE set of shared lookups from the approvers it already read");
    assert.match(run, /ensureProbationReminderEvents\(employee, employees, lookups\)/, "the scheduled reminders get the run's lookups");
    assert.match(run, /ensureOverdueProbationReminderEvents\(employee, row, employees, lookups\)/, "the overdue escalation gets the run's lookups");
    for (const name of ["async function ensureProbationReminderEvents(", "async function ensureOverdueProbationReminderEvents("]) {
      assert.ok(!bodyOf(name).includes("app_auth_users"), `${name} must not read app_auth_users itself — that is the per-employee read`);
    }
  }
}
