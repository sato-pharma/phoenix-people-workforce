/**
 * Mailbox offboarding — the Turbify leaver register.
 *
 * WHAT THIS FILE PROTECTS. One rule, and it is the reason the whole feature exists:
 *
 *   **A password reset is not a revocation.**
 *
 * Turbify Business Email runs on the Yahoo platform, and Yahoo's own documentation states that
 * third-party app passwords remain active after the account password is changed — they must be
 * deleted explicitly. So a leaver whose phone or Outlook was ever configured keeps sending and
 * receiving company mail after the reset that everyone believes closed the door, and the control
 * panel shows nothing wrong. There is no API to ask it, either: Turbify publishes none.
 *
 * That makes this the most dangerous possible defect in this module, because its failure mode is
 * SILENT AND REASSURING. A register that marked a mailbox `revoked` on a reset alone would not
 * merely be unhelpful — it would actively assert that a live mailbox is shut, and the alert that
 * would otherwise surface it would stop firing. It is worse than having no register at all.
 *
 * So the rule is pinned twice, at both levels it could regress:
 *
 *   1. The SQL, because the status is computed in plpgsql precisely so a page cannot bypass it.
 *      A test that only exercised TypeScript would pass while the gate itself was gone.
 *   2. `computeMailboxFlags`, which drives the "still reachable" count the page leads with and the
 *      daily sweep alerts on. It is the only thing in the system that can see this state.
 *
 * The SQL half reads the migration by REGEX, never by byte offset — a source-pinning test that
 * slices a fixed window false-fails the moment anything above it shifts.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildAppPasswordReport,
  computeMailboxFlags,
  leaverAppPasswordsMayBeLive,
} from "../src/lib/mailbox-offboarding/service.ts";
import { buildMailboxAlertSignature } from "../src/lib/mailbox-offboarding/sweep.ts";
import type { MailboxOffboardingTask } from "../src/lib/mailbox-offboarding/types.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** The register's own migration — the table, the RLS and the original function definitions. */
const MIGRATION = path.join(MIGRATIONS_DIR, "20260830001000_mailbox_offboarding_register.sql");

function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

/**
 * The migration that CURRENTLY defines a function, not the one that first did.
 *
 * A pin that hard-codes the original filename keeps passing after a later migration replaces the
 * function — it goes on happily asserting a definition production no longer runs, which is the
 * pinning test pinning the anti-pattern. Scanning in filename order and taking the LAST file that
 * defines it makes every assertion below follow the live definition instead.
 */
function definingMigration(fn: string): string {
  const marker = `create or replace function public.${fn}(`;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let latest: string | null = null;
  for (const name of files) {
    const body = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
    if (body.includes(marker)) latest = body;
  }
  assert.ok(latest !== null, `no migration defines ${fn}`);
  return latest as string;
}

/** Only the body of the status function, so a match cannot come from a comment elsewhere. */
function refreshStatusBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.phx_mailbox_offboarding_refresh_status");
  assert.ok(start > -1, "phx_mailbox_offboarding_refresh_status must exist in the migration");
  const end = sql.indexOf("\n$$;\n", start);
  assert.ok(end > start, "the status function must be terminated");
  return sql.slice(start, end);
}

/** Only the body of the record function, for the same reason. */
function recordBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.phx_mailbox_offboarding_record(");
  assert.ok(start > -1, "phx_mailbox_offboarding_record must exist in the migration");
  const end = sql.indexOf("\n$$;\n", start);
  assert.ok(end > start, "the record function must be terminated");
  return sql.slice(start, end);
}

/** Strips SQL comments, so a rule can never be "satisfied" by prose describing it. */
function withoutComments(sql: string): string {
  return stripSqlComments(sql);
}

export async function runMailboxOffboardingTests(): Promise<void> {
  // ── 1. THE RULE, IN THE DATABASE ──────────────────────────────────────────
  const body = withoutComments(
    refreshStatusBody(definingMigration("phx_mailbox_offboarding_refresh_status")),
  );

  // Both timestamps, joined by AND. This is the clause that refuses to call a reset-only mailbox
  // revoked, and it is the single line this whole file exists to defend.
  assert.match(
    body,
    /password_reset_at is not null\s+and\s+v_row\.app_passwords_cleared_at is not null/,
    "revoked must require BOTH the password reset AND the app passwords cleared — a reset alone " +
      "leaves every phone and Outlook client the leaver configured still connected",
  );

  // Deleting or suspending the mailbox is the other route to revoked, and the only other one.
  assert.match(
    body,
    /v_row\.disposition in \('deleted', 'suspended'\)/,
    "deleting or suspending the mailbox must also earn revoked — nothing is left to authenticate",
  );

  // The inverse guard. 'forwarding' and 'retained' both describe a mailbox that is STILL ALIVE, so
  // neither may appear in the revoked condition. This is the assertion that catches the plausible
  // "tidy up the disposition list" edit — the one a reviewer would wave through.
  const revokedClause = body.slice(body.indexOf("if v_row.disposition"), body.indexOf("v_status := 'revoked'"));
  assert.ok(
    !revokedClause.includes("'forwarding'") && !revokedClause.includes("'retained'"),
    "forwarding and retained must NOT earn revoked — both leave the mailbox reachable",
  );

  // ── 2. THE SAME RULE, IN THE DERIVED FLAG ─────────────────────────────────
  const today = "2026-08-29";

  const resetOnly = computeMailboxFlags(
    {
      status: "in_progress",
      passwordResetAt: "2026-08-20T10:00:00Z",
      appPasswordsClearedAt: null,
      disposition: null,
      forwardingExpiresOn: null,
      lastWorkingDate: "2026-08-15",
    },
    today,
  );
  assert.equal(
    resetOnly.isHalfRevoked,
    true,
    "a mailbox whose password was reset with the app passwords left alive must read as still reachable",
  );
  assert.equal(resetOnly.isOverdue, true, "and as overdue, 14 days after the last working day");
  assert.equal(resetOnly.daysOverdue, 14, "days overdue is counted from the last working date");

  const bothDone = computeMailboxFlags(
    {
      status: "revoked",
      passwordResetAt: "2026-08-20T10:00:00Z",
      appPasswordsClearedAt: "2026-08-20T10:05:00Z",
      disposition: null,
      forwardingExpiresOn: null,
      lastWorkingDate: "2026-08-15",
    },
    today,
  );
  assert.equal(bothDone.isHalfRevoked, false, "both steps done is not half-revoked");
  assert.equal(bothDone.isOverdue, false, "a revoked mailbox is never overdue");
  assert.equal(bothDone.daysOverdue, 0, "and carries no overdue day count");
  // Step 3 stays offerable here, and this is the whole point of the flag. Recording steps 1 and 2
  // is what makes a row revoked, so a screen that hid step 3 on `revoked` hid it in the order it
  // numbers them: 57 of 60 closed mailboxes on production ended up with no record of what became
  // of them. This flag MUST mirror the guard in phx_mailbox_offboarding_record — a screen that
  // offers a button the database refuses is worse than one that hides it.
  assert.equal(
    bothDone.canRecordDisposition,
    true,
    "a row revoked by BOTH steps must still accept a disposition — it cannot change the status",
  );

  // Revoked BY the disposition, with neither step recorded: changing it would drop the row back to
  // in_progress, so it is a correction and goes through reopen. This is the negative half, and it
  // is the one a "just let disposition through" edit would quietly lose.
  const revokedByDisposition = computeMailboxFlags(
    {
      status: "revoked",
      passwordResetAt: null,
      appPasswordsClearedAt: null,
      disposition: "deleted",
      forwardingExpiresOn: null,
      lastWorkingDate: "2026-08-15",
    },
    today,
  );
  assert.equal(
    revokedByDisposition.canRecordDisposition,
    false,
    "a row revoked by its disposition alone must NOT take another one — that would un-revoke it",
  );

  // Nothing to describe: not_applicable means there was never a mailbox.
  const notApplicable = computeMailboxFlags(
    {
      status: "not_applicable",
      passwordResetAt: null,
      appPasswordsClearedAt: null,
      disposition: null,
      forwardingExpiresOn: null,
      lastWorkingDate: "2026-08-15",
    },
    today,
  );
  assert.equal(
    notApplicable.canRecordDisposition,
    false,
    "a not_applicable row has no mailbox for a disposition to describe",
  );

  assert.equal(
    resetOnly.canRecordDisposition,
    true,
    "an open row has always accepted a disposition, and still must",
  );

  // A mailbox nobody has touched is overdue but NOT half-revoked. The distinction matters: the
  // sweep's headline counts them separately because one is forgotten work and the other is work
  // somebody believes they finished.
  const untouched = computeMailboxFlags(
    {
      status: "pending",
      passwordResetAt: null,
      appPasswordsClearedAt: null,
      disposition: null,
      forwardingExpiresOn: null,
      lastWorkingDate: "2026-08-15",
    },
    today,
  );
  assert.equal(untouched.isHalfRevoked, false, "an untouched mailbox is not half-revoked");
  assert.equal(untouched.isOverdue, true, "but it is overdue");

  // Forwarding whose expiry has passed — set at an exit and never torn down.
  const lapsed = computeMailboxFlags(
    {
      status: "in_progress",
      passwordResetAt: null,
      appPasswordsClearedAt: null,
      disposition: "forwarding",
      forwardingExpiresOn: "2026-08-01",
      lastWorkingDate: "2026-07-31",
    },
    today,
  );
  assert.equal(lapsed.isForwardingExpired, true, "forwarding past its expiry must be flagged");

  const forwardingLive = computeMailboxFlags(
    {
      status: "in_progress",
      passwordResetAt: null,
      appPasswordsClearedAt: null,
      disposition: "forwarding",
      forwardingExpiresOn: "2026-12-31",
      lastWorkingDate: "2026-07-31",
    },
    today,
  );
  assert.equal(forwardingLive.isForwardingExpired, false, "forwarding inside its window is not flagged");

  // A future last working day is not overdue, and must not produce a negative day count.
  const notYetGone = computeMailboxFlags(
    {
      status: "pending",
      passwordResetAt: null,
      appPasswordsClearedAt: null,
      disposition: null,
      forwardingExpiresOn: null,
      lastWorkingDate: "2026-09-30",
    },
    today,
  );
  assert.equal(notYetGone.isOverdue, false, "someone who has not left yet is not overdue");
  assert.equal(notYetGone.daysOverdue, 0, "and never carries a negative day count");

  // ── 2b. THE APP-PASSWORD REPORT ───────────────────────────────────────────
  // Every leaver whose app passwords may still work. A reset changes nothing here (an app password
  // survives it); only a recorded clear or a deleted mailbox ends one. The step that removes app
  // passwords is accepted when this report reads zero, so a row wrongly left off it is the defect.
  const live = (overrides: Partial<Parameters<typeof leaverAppPasswordsMayBeLive>[0]>) =>
    leaverAppPasswordsMayBeLive(
      { status: "pending", appPasswordsClearedAt: null, disposition: null, lastWorkingDate: "2026-08-15", ...overrides },
      today,
    );
  assert.equal(live({}), true, "an untouched leaver mailbox has live app passwords — no reset is needed to be on the report");
  assert.equal(live({ status: "in_progress" }), true, "a reset-only mailbox is on the report");
  assert.equal(live({ appPasswordsClearedAt: "2026-08-20T10:05:00Z", status: "revoked" }), false, "a recorded clear ends it");
  assert.equal(live({ disposition: "deleted", status: "revoked" }), false, "a deleted mailbox has no app passwords left");
  assert.equal(live({ status: "not_applicable" }), false, "no mailbox, nothing to report");
  assert.equal(live({ disposition: "retained", status: "revoked" }), true, "a retained mailbox revoked without a clear is still reachable");
  assert.equal(live({ lastWorkingDate: "2026-09-30" }), false, "a colleague still at work is not a leaver");
  assert.equal(live({ lastWorkingDate: today }), false, "the last working day itself is still a working day");
  assert.equal(live({ lastWorkingDate: null }), true, "an unknown last working day is reported, never hidden");

  const reportTask = (id: string, mayBeLive: boolean, lastWorkingDate: string): MailboxOffboardingTask =>
    ({
      id,
      employeeHrId: `HR-${id}`,
      employeeName: `Leaver ${id}`,
      workEmail: `${id}@satopharma.com`,
      lastWorkingDate,
      passwordResetAt: null,
      appPasswordsMayBeLive: mayBeLive,
    }) as MailboxOffboardingTask;
  const report = buildAppPasswordReport(
    [reportTask("b", true, "2026-08-10"), reportTask("c", false, "2026-08-01")],
    [
      { employeeHrId: "HR-a", employeeName: "Leaver a", workEmail: "a@satopharma.com", jobTitle: null, lastWorkingDate: "2026-08-01", employmentStatus: "resigned" },
      { employeeHrId: "HR-d", employeeName: "Leaver d", workEmail: "d@satopharma.com", jobTitle: null, lastWorkingDate: "2026-09-30", employmentStatus: "resigned" },
    ],
    today,
  );
  assert.deepEqual(
    report.map((row) => [row.employeeHrId, row.hasRecord]),
    [["HR-a", false], ["HR-b", true]],
    "the report carries tasked leavers not cleared AND leavers with no record, oldest last day first — and never someone still at work",
  );
  assert.deepEqual(buildAppPasswordReport([reportTask("c", false, "2026-08-01")], [], today), [], "zero rows when every leaver is cleared");

  // ── 3. THE ALERT SIGNATURE ────────────────────────────────────────────────
  // The signature decides whether a day's alert is suppressed as a repeat. Two properties matter:
  // it must be ORDER-INDEPENDENT (PostgREST row order is not a contract, and alerting on a
  // reordering that changed nothing trains the reader to ignore it), and it must CHANGE when a
  // newly overdue mailbox appears, or a growing backlog would stay silent behind the first alert.
  const task = (id: string, half: boolean): MailboxOffboardingTask =>
    ({
      id,
      status: "in_progress",
      isHalfRevoked: half,
    }) as MailboxOffboardingTask;

  assert.equal(
    buildMailboxAlertSignature([task("a", true), task("b", false)]),
    buildMailboxAlertSignature([task("b", false), task("a", true)]),
    "the alert signature must not depend on row order",
  );
  assert.notEqual(
    buildMailboxAlertSignature([task("a", true)]),
    buildMailboxAlertSignature([task("a", true), task("b", false)]),
    "a newly flagged mailbox must change the signature, or the day's alert would be suppressed",
  );
  assert.notEqual(
    buildMailboxAlertSignature([task("a", false)]),
    buildMailboxAlertSignature([task("a", true)]),
    "a mailbox becoming half-revoked must change the signature — it is a new fact about the same row",
  );

  // ── 4. THE CORRECTION PATH ────────────────────────────────────────────────
  // A register with no way to fix a wrong entry is a defect this repository has already paid for
  // once: the marketing licence verdict is write-once at approval and not even a Super Admin can
  // correct it. The same shape here would permanently assert that a live mailbox is shut.
  const sql = migrationSql();
  const record = withoutComments(recordBody(definingMigration("phx_mailbox_offboarding_record")));
  assert.match(
    record,
    /p_step\s*=\s*'reopen'/,
    "the record function must offer a reopen step — a mis-recorded revocation has to be correctable",
  );
  assert.match(
    record,
    /v_row\.status = 'revoked'\s*\n?\s*and p_step <> 'reopen'/,
    "a revoked row must be frozen against further steps but NOT against correction",
  );

  // ── 4b. THE ONE EXEMPTION TO THE FREEZE ───────────────────────────────────
  // Recording steps 1 and 2 is what makes a row revoked, so a freeze with no exemption made the
  // workspace's own step 3 unreachable in the order it numbers them. Measured on production
  // 2026-09-03: of 60 rows, 57 had both steps recorded and NO disposition, and every disposition
  // that did exist had been recorded INSTEAD of the two steps, never after them.
  //
  // The exemption is narrow on purpose, and both halves are pinned. A disposition on a row revoked
  // by BOTH timestamps cannot change the status — the second arm of refresh_status stays true — so
  // it records a fact without weakening the assertion the freeze exists to protect.
  assert.match(
    record,
    /p_step = 'disposition'\s*\n\s*and v_row\.password_reset_at is not null\s*\n\s*and v_row\.app_passwords_cleared_at is not null/,
    "a disposition must be recordable on a row revoked by BOTH steps — otherwise step 3 is unreachable",
  );
  // The other half, and the one that has to be counted rather than pattern-matched: a SECOND way
  // in must not be bolted on beside the first. A row revoked BY its disposition (deleted or
  // suspended, neither step recorded) would drop back to in_progress if that disposition were
  // changed, so it is a correction and goes through reopen with a written reason. Any additional
  // `or p_step = 'disposition'` alternative would reopen exactly that hole while leaving the
  // timestamp clause above still present and still matching — so the guarantee is that the step
  // is named ONCE in the whole condition, on the timestamp-conditioned path.
  const guardCondition = record.slice(
    record.indexOf("if v_row.status = 'revoked'"),
    record.indexOf(" then", record.indexOf("if v_row.status = 'revoked'")),
  );
  assert.ok(guardCondition.length > 0, "the revoked freeze must exist in the record function");
  assert.equal(
    guardCondition.split("'disposition'").length - 1,
    1,
    "the disposition step must be named exactly once in the freeze condition — a second alternative " +
      "would let a row revoked by its disposition be changed, and silently un-revoked",
  );
  assert.ok(
    guardCondition.includes("password_reset_at is not null") &&
      guardCondition.includes("app_passwords_cleared_at is not null"),
    "the exemption must be conditioned on BOTH timestamps, never on the step name alone",
  );

  // ── 5. THE SECURITY DEFINER ACLS ──────────────────────────────────────────
  // A SECURITY DEFINER function runs as its owner and bypasses RLS by design, so the default ACL
  // granting EXECUTE to PUBLIC is a hole straight through an admin-only register.
  for (const fn of [
    "phx_mailbox_offboarding_refresh_status",
    "phx_mailbox_offboarding_open",
    "phx_mailbox_offboarding_record",
  ]) {
    assert.ok(
      // The DEFINING migration, not the original: a later `create or replace` keeps the existing
      // ACL on this database, but creates the function with EXECUTE to PUBLIC on a fresh replay, so
      // the grants have to be restated wherever the definition now lives.
      new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`).test(definingMigration(fn)),
      `${fn} must have EXECUTE revoked from public, anon and authenticated`,
    );
    assert.ok(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`).test(definingMigration(fn)),
      `${fn} must have EXECUTE re-granted to service_role — revoking PUBLIC also strips it`,
    );
  }

  assert.match(
    sql,
    /alter table public\.mailbox_offboarding_tasks enable row level security/,
    "the register must have RLS enabled — it holds leavers' addresses and is admin-only",
  );
}
