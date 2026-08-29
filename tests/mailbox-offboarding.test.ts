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
import { readFileSync } from "node:fs";
import path from "node:path";

import { computeMailboxFlags } from "../src/lib/mailbox-offboarding/service.ts";
import { buildMailboxAlertSignature } from "../src/lib/mailbox-offboarding/sweep.ts";
import type { MailboxOffboardingTask } from "../src/lib/mailbox-offboarding/types.ts";

const MIGRATION = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260830001000_mailbox_offboarding_register.sql",
);

function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

/** Only the body of the status function, so a match cannot come from a comment elsewhere. */
function refreshStatusBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.phx_mailbox_offboarding_refresh_status");
  assert.ok(start > -1, "phx_mailbox_offboarding_refresh_status must exist in the migration");
  const end = sql.indexOf("create or replace function public.phx_mailbox_offboarding_open", start);
  assert.ok(end > start, "the status function must be followed by the open function");
  return sql.slice(start, end);
}

/** Strips SQL line comments, so a rule can never be "satisfied" by prose describing it. */
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

export async function runMailboxOffboardingTests(): Promise<void> {
  // ── 1. THE RULE, IN THE DATABASE ──────────────────────────────────────────
  const body = withoutComments(refreshStatusBody(migrationSql()));

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
  assert.match(
    sql,
    /p_step\s*=\s*'reopen'/,
    "the record function must offer a reopen step — a mis-recorded revocation has to be correctable",
  );
  assert.match(
    sql,
    /v_row\.status = 'revoked' and p_step <> 'reopen'/,
    "a revoked row must be frozen against further steps but NOT against correction",
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
      new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`).test(sql),
      `${fn} must have EXECUTE revoked from public, anon and authenticated`,
    );
    assert.ok(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`).test(sql),
      `${fn} must have EXECUTE re-granted to service_role — revoking PUBLIC also strips it`,
    );
  }

  assert.match(
    sql,
    /alter table public\.mailbox_offboarding_tasks enable row level security/,
    "the register must have RLS enabled — it holds leavers' addresses and is admin-only",
  );
}
