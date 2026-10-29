import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// A refused request must stop claiming people still owe it a decision.
//
// Live in production: MKT-REQ-20260811-FF5B0719 was refused at sequence 1 on 2026-08-11 and still
// carried FOUR rows at status='pending' — SFE Validation, Marketing Review, CEO Approval, Finance
// Execution. Four of the nine approval-step rows in the entire database described work that will
// never happen, and every consumer that counts pending rungs (the nav badge, the approver inbox)
// read them as outstanding.
//
// Two defects, both in Branch A of phx_decide_marketing_request_step:
//   1. a reject left every later rung at `pending`
//   2. a reject NULLed `returned_at` / `returned_step_sequence`, erasing the fact that the request
//      had ever been returned
//
// What must NOT change is as important as what does:
//   · a RETURN must not terminalise — resubmission depends on the later rungs staying `pending`
//   · an already-decided rung must never be rewritten — that is the audit trail
//   · a CC rung is `skipped` from birth and is not evidence of anything here
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function migrationSource() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith("_marketing_reject_terminalises_chain.sql"));
  assert.ok(file, "the reject-terminalises migration must exist");
  return readFileSync(new URL(file, dir), "utf8");
}

/**
 * Strip `--` line comments, then collapse whitespace.
 *
 * Both halves matter. Collapsing whitespace makes an assertion about the SQL rather than about how
 * it is indented. Stripping comments makes it about the CODE: this migration's header quotes the
 * old, broken clauses verbatim to explain them, so an assertion run against the raw file matches
 * the documentation of the bug and reports the bug as still present. The first run of this test
 * failed on exactly that.
 *
 * `--` inside a string literal is left alone by counting the quotes to its left.
 */
function code(sql: string) {
  const stripped = sql
    .split("\n")
    .map((line) => {
      let quotes = 0;
      for (let i = 0; i < line.length - 1; i += 1) {
        if (line[i] === "'") quotes += 1;
        if (line[i] === "-" && line[i + 1] === "-" && quotes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
  return stripped.toLowerCase().replace(/\s+/g, " ");
}

export async function runMarketingRejectTerminalisesTests() {
  const rawSql = migrationSource();
  const sql = code(rawSql);

  // The stripper itself is load-bearing, so prove it works before trusting anything below it.
  assert.ok(
    rawSql.includes("ELSE NULL END` writes NULL on"),
    "expected the migration header to still explain the old clause — if it was removed, the guard below is no longer testing anything",
  );
  assert.ok(
    !sql.includes("writes null on"),
    "the comment stripper must remove header prose, or every assertion below can match documentation instead of code",
  );

  /* ---------------------------------------------------------------------- */
  /* 1. A reject closes out the rungs still waiting                          */
  /* ---------------------------------------------------------------------- */

  // The whole point: the status is written in the DATA, not painted on by a view. The scoping of
  // this statement is asserted separately in §3, so widening it fails there rather than here — two
  // assertions covering one clause means the second can never fire and proves nothing.
  //
  // `public.` is deliberately absent from the needle: the backfill at the foot of the migration is
  // the schema-qualified one, and matching it here would silently test the wrong statement.
  const terminaliseAt = sql.indexOf("update marketing_request_approval_steps set status = 'skipped'");
  assert.ok(
    terminaliseAt > -1,
    "a reject must mark the rungs still waiting 'skipped' in the data, not leave them reading as pending work",
  );

  // It must be gated on reject. Terminalising on a RETURN would strand the request: the later rungs
  // are genuinely still ahead of it and resubmitReturnedMarketingRequest walks them.
  const rejectGuardAt = sql.indexOf("if p_decision = 'reject' then");
  assert.ok(rejectGuardAt > -1, "the terminalise must sit inside an `IF p_decision = 'reject'` guard");
  assert.ok(
    rejectGuardAt < terminaliseAt,
    "the terminalise must run ONLY on a reject — a return leaves the chain alone so resubmission still works",
  );

  // The count is returned rather than inferred, so the caller can log what actually happened.
  assert.match(
    sql,
    /get diagnostics v_terminalised = row_count;/,
    "the RPC must capture how many rungs it closed out",
  );
  assert.match(
    sql,
    /'terminalised', v_terminalised/,
    "the closed-out count must be returned to the caller, not left to be guessed",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. A reject stops erasing the return                                    */
  /* ---------------------------------------------------------------------- */

  // The old body wrote `ELSE NULL` on both columns, so a request that was returned, resubmitted and
  // then refused kept no evidence the return ever happened.
  assert.match(
    sql,
    /returned_at = case when p_decision = 'return' then p_decided_at else returned_at end/,
    "a reject must preserve returned_at, not NULL it",
  );
  assert.match(
    sql,
    /returned_step_sequence = case when p_decision = 'return' then v_step\.sequence else returned_step_sequence end/,
    "a reject must preserve returned_step_sequence, not NULL it",
  );
  // Belt and braces: the exact erasing clauses must be gone, in either column.
  assert.ok(
    !/returned_at = case when p_decision = 'return' then p_decided_at else null end/.test(sql),
    "the clause that NULLed returned_at on every reject must be gone",
  );
  assert.ok(
    !/returned_step_sequence = case when p_decision = 'return' then v_step\.sequence else null end/.test(sql),
    "the clause that NULLed returned_step_sequence on every reject must be gone",
  );

  /* ---------------------------------------------------------------------- */
  /* 3. Nothing already decided is rewritten                                 */
  /* ---------------------------------------------------------------------- */

  // A rung that was approved/rejected/returned carries who decided it and when. Widening the
  // terminalise beyond `status = 'pending'` would overwrite that — the audit trail is the reason
  // this table exists.
  const terminaliseStatement = sql.slice(terminaliseAt, sql.indexOf(";", terminaliseAt));
  assert.match(
    terminaliseStatement,
    /where request_id = p_request_id/,
    "the terminalise must be scoped to this request — an unscoped one would close out the whole table",
  );
  assert.match(
    terminaliseStatement,
    /and status = 'pending'/,
    "the terminalise must filter on status = 'pending' so a decided rung is never rewritten",
  );
  assert.match(
    terminaliseStatement,
    /and is_cc = false/,
    "the terminalise must leave CC rows alone — they are skipped from birth and mean something different",
  );
  assert.ok(
    !/decision_at/.test(terminaliseStatement) && !/decision_by_hr_id/.test(terminaliseStatement),
    "the terminalise must not touch decision_at or decision_by_hr_id — past approval information stays exactly as it was",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. The backfill closes out the rows already stranded, and only those    */
  /* ---------------------------------------------------------------------- */

  // Live rows predate the fix; a function change alone leaves them stranded forever.
  assert.match(
    sql,
    /update public\.marketing_request_approval_steps s set status = 'skipped'/,
    "the migration must backfill the rungs already stranded on refused requests",
  );
  const backfillAt = sql.indexOf("update public.marketing_request_approval_steps s");
  const backfill = sql.slice(backfillAt);
  assert.match(
    backfill,
    /r\.status = 'rejected'/,
    "the backfill must be scoped to rejected requests — a live request's pending rungs are real work",
  );
  assert.match(
    backfill,
    /s\.status = 'pending'/,
    "the backfill must only touch pending rungs, so a decided rung is never rewritten",
  );
  assert.match(
    backfill,
    /s\.is_cc = false/,
    "the backfill must leave CC rows alone",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. The RPC's own grants survive the replace                             */
  /* ---------------------------------------------------------------------- */

  // CREATE OR REPLACE keeps the ACL, but this repo has shipped a bug where a REVOKE on a default
  // ACL stripped service_role. Restating both makes the migration self-describing.
  assert.match(
    sql,
    /revoke execute on function public\.phx_decide_marketing_request_step\(uuid, uuid, text, text, text, timestamptz\) from public, anon, authenticated;/,
    "the decision RPC must stay unreachable from the browser roles",
  );
  assert.match(
    sql,
    /grant execute on function public\.phx_decide_marketing_request_step\(uuid, uuid, text, text, text, timestamptz\) to service_role;/,
    "revoking PUBLIC on a default ACL also strips service_role, so the grant must be restated",
  );

  // This migration replaces the whole function body, so the self-approval guard shipped in
  // 20260813170000 has to be carried forward — dropping it would silently un-fix that.
  assert.match(
    sql,
    /marketing_self_approval_refused/,
    "the replacement body must carry the self-approval guard forward, or this migration reopens it",
  );

  /* ---------------------------------------------------------------------- */
  /* 6. The service reports what happened                                    */
  /* ---------------------------------------------------------------------- */

  const serviceSource = source("src/lib/marketing-requests/service.ts");
  assert.match(
    serviceSource,
    /terminalised\?: number;/,
    "the service must read the closed-out count off the RPC result",
  );
  assert.match(
    serviceSource,
    /later approval step\$\{rpcData\.terminalised === 1 \? "" : "s"\} closed out\./,
    "the audit summary must say how many rungs the refusal closed out, so the log is not silent about a bulk status change",
  );

  /* ---------------------------------------------------------------------- */
  /* 7. The detail page reads the data instead of compensating for it        */
  /* ---------------------------------------------------------------------- */

  const caseFileView = source("src/components/marketing-requests/marketing-request-case-file.tsx");

  // "not reached" must be decided by the ROW, not by the request status alone. A CC rung and a
  // self-approval skip are both `skipped` for entirely different reasons and neither was
  // "not reached"; a bare `status === "rejected"` check would mislabel both.
  assert.match(
    caseFileView,
    /const neverReached = \(rung: MarketingCaseFileChain\["rungs"\]\[number\]\) =>\s*\n?\s*status === "rejected" &&\s*\n?\s*!rung\.isCc &&\s*\n?\s*\(rung\.status === "pending" \|\| \(rung\.status === "skipped" && !rung\.decisionNote\)\)/,
    "the badge must distinguish a rung the refusal closed out from a CC row and from a self-approval skip",
  );
  assert.match(
    caseFileView,
    /\{neverReached\(rung\) \? "not reached" : requestStatusLabel\(rung\.status\)\}/,
    "the rung badge must render 'not reached' rather than the bare status word",
  );
}
