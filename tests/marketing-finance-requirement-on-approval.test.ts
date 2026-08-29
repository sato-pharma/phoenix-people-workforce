import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Approving a marketing request never recorded the invoice obligation it creates.
//
// `phx_decide_marketing_request_step` is the one transaction that decides a marketing approval
// rung, and its final-approval branch stamped `approved_at`, set the terminal status, and returned.
// It never wrote `marketing_request_finance_requirements`. The only code anywhere that created that
// row was the finance-EVIDENCE upload — so the obligation only came into existence once it had
// already been discharged, and nothing ever recorded that an invoice was OWED. Measured in
// production 2026-08-29: 4 approved requests, 1 finance row between them, that one created three
// days after the approval by an upload and carrying no deadline at all.
//
// `marketing_control_settings.finance_invoice_deadline_days` had held {"days": 7} since it was
// seeded on 2026-05-21 and is offered as an editable field in the Marketing Control workspace. No
// code had ever read it, so editing it changed nothing.
//
// This pins the shape of the fix, and — just as important — the two ways it could be "tidied" into
// a data-loss bug: an ON CONFLICT that UPDATES would rewrite a delivered invoice back to 'pending',
// and an insert hoisted above the branch split would bill a request nobody approved.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Strip block and line comments so an assertion can never match the migration's own prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

/** Collapse whitespace so an assertion survives reformatting but not a change of meaning. */
function flat(source: string): string {
  return source.replace(/\s+/g, " ").toLowerCase();
}

export function runMarketingFinanceRequirementOnApprovalTests() {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes("marketing_finance_requirement_on_approval"));
  assert.ok(file, "the marketing finance-requirement-on-approval migration must exist");

  const sql = code(readFileSync(join(MIGRATIONS, file!), "utf8"));
  const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.phx_decide_marketing_request_step");
  assert.ok(fnStart >= 0, "the migration must replace the decision RPC itself, not patch around it");
  const fnEnd = sql.indexOf("$function$;", fnStart);
  assert.ok(fnEnd > fnStart, "the decision function body must be terminated");
  const fn = flat(sql.slice(fnStart, fnEnd));
  const backfill = flat(sql.slice(fnEnd));

  // ── The obligation is written inside the approval, not alongside it ──────────
  // This function exists precisely so a decision cannot half-apply. An approval that commits
  // without its obligation is exactly the half-state it was written to prevent, so the insert
  // belongs in the same transaction — not in a trigger, a follow-up statement, or TypeScript.
  assert.ok(
    fn.includes("insert into marketing_request_finance_requirements"),
    "the decision RPC must create the finance requirement itself — a second round trip can half-apply",
  );

  // ── Only the FINAL approval owes an invoice ─────────────────────────────────
  // Branch A (reject/return) and Branch B (another approver still ahead) both RETURN before this
  // point. Anchoring on the first statement of Branch C proves the insert is unreachable from
  // either: nothing is owed on a request nobody approved, and nothing is owed twice on a chain
  // that is still climbing.
  const branchCStart = fn.indexOf("v_terminal_status := coalesce(v_step.terminal_status");
  assert.ok(branchCStart > 0, "the final-approval branch must still open by resolving the terminal status");
  const beforeFinalApproval = fn.slice(0, branchCStart);
  assert.ok(
    !beforeFinalApproval.includes("marketing_request_finance_requirements"),
    "reject, return and intermediate rungs must never create a finance requirement — only final approval does",
  );
  assert.ok(
    fn.indexOf("insert into marketing_request_finance_requirements") > branchCStart,
    "the finance insert must sit inside the final-approval branch",
  );

  // ── An approval may CREATE an obligation; it may never rewrite one ──────────
  // The evidence upload can legitimately land before the last rung is decided, leaving the row at
  // invoice_status 'submitted' with its storage paths set. DO UPDATE would rewrite a delivered
  // invoice back to 'pending' and erase it.
  assert.ok(
    fn.includes("on conflict (request_id) do nothing"),
    "the insert must be ON CONFLICT (request_id) DO NOTHING, or an approval erases a delivered invoice",
  );
  assert.ok(
    !flat(sql).includes("on conflict (request_id) do update"),
    "nothing in this migration may DO UPDATE on request_id — that overwrites an already-submitted invoice",
  );
  assert.ok(fn.includes("'pending'"), "a newly created obligation starts unpaid, at invoice_status 'pending'");

  // ── The deadline comes from the setting that was always editable and never read ──
  assert.ok(
    fn.includes("finance_invoice_deadline_days") && fn.includes("from marketing_control_settings"),
    "the deadline must read finance_invoice_deadline_days — the Marketing Control field that changed nothing",
  );
  assert.ok(
    fn.includes("coalesce(v_invoice_days, 7)"),
    "a missing settings row must fall back to 7, never raise — a deleted setting cannot be allowed to fail an approval",
  );

  // ── Cairo, not UTC ──────────────────────────────────────────────────────────
  // An approval at 01:30 Cairo is the 29th here and the 28th in UTC. The date a human is held to
  // has to be the local one, and AGENTS.md §4 requires Africa/Cairo everywhere.
  assert.ok(
    fn.includes("(p_decided_at at time zone 'africa/cairo')::date"),
    "the deadline must be measured from the Cairo calendar date of the approval, not the UTC one",
  );

  // ── The backfill covers approvals already made, and only those ──────────────
  assert.ok(
    backfill.includes("insert into public.marketing_request_finance_requirements"),
    "the migration must backfill the obligations already approved without one",
  );
  assert.ok(
    backfill.includes("where r.approved_at is not null"),
    "the backfill must be scoped to genuinely approved requests — a rejected request owes no invoice",
  );
  assert.ok(
    backfill.includes("on conflict (request_id) do nothing"),
    "the backfill must be idempotent and must not touch the one row an invoice upload already created",
  );
  assert.ok(
    backfill.includes("(r.approved_at at time zone 'africa/cairo')::date"),
    "each backfilled deadline runs from that request's own approval date, so a weeks-late invoice reads as late",
  );

  // ── A full-body CREATE OR REPLACE must not quietly drop what was already there ──
  // The whole function is restated to add six lines, which is the moment an existing guard goes
  // missing without anything failing.
  assert.ok(
    fn.includes("marketing_self_approval_refused"),
    "the self-approval refusal must survive the function rewrite",
  );
  assert.ok(
    fn.includes("marketing_step_already_decided"),
    "the optimistic lock on the current step must survive the function rewrite",
  );
  assert.ok(
    flat(sql).includes("revoke execute on function public.phx_decide_marketing_request_step") &&
      flat(sql).includes("to service_role"),
    "a replaced SECURITY DEFINER function must be re-revoked from public/anon/authenticated and granted to service_role only",
  );
}
