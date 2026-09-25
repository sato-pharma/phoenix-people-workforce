import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The RLS policies on employee_documents and employee_history are pinned, by REPLAYING every
 * migration in order and asserting the state they leave behind.
 *
 * WHY THIS EXISTS (2026-09-06). `20260906230000_drop_the_legacy_users_table.sql` dropped
 * public.users. Eight policies on these two LIVE tables referenced that table, and a dependency
 * sweep over views, functions, triggers and foreign keys does not see an RLS policy at all — a
 * policy's expression is a surface of its own (pg_policy.polqual / polwithcheck), so such a sweep
 * comes back clean and reads as "nothing depends on this". `DROP TABLE ... CASCADE` — which
 * Postgres's own HINT tells you to use when the drop fails — would then have stripped the RLS off
 * both tables silently, with no error and nothing in the diff to review.
 *
 * That drop was survivable only because the migration refused `cascade` and rewrote the eight
 * policies by hand first. This test is the standing guard on that outcome: it does not care how a
 * later migration is written, only that the policy set these two tables END UP with is still
 * exactly this one. A migration that alters, drops, or widens any of the ten goes red here.
 *
 * READ THE EXPRESSIONS BEFORE CHANGING THEM. The four `_own` policies on each table are the
 * entire authenticated-role predicate: a row is visible to the user whose id is stamped on it.
 * Replacing `uploaded_by_user_id = auth.uid()` with anything broader hands one employee another
 * employee's HR documents, and the service_role pair below is what the app itself reads through —
 * so a change there is a change to every server-side read of these tables.
 *
 * This reads the migration FILES, never the database: CI must not depend on production.
 */

const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const PINNED_TABLES = ["employee_documents", "employee_history"];

/** Strip block and line comments so commented-out DDL is never parsed as real. */
function code(source: string): string {
  return stripSqlComments(source).replace(/(^|[^:])--[^\n]*/g, "$1");
}

/**
 * Collapse Postgres's rendering differences so a hand-written migration and a pg_dump baseline
 * compare equal: case, whitespace, the `AS uid` / `AS role` aliases pg_get_expr prints, the
 * `::text` casts, and one layer of redundant wrapping parens.
 */
function norm(expr: string): string {
  let out = expr
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/asuid/g, "")
    .replace(/asrole/g, "")
    .replace(/::text/g, "");
  // Strip outer parens only when the FIRST one actually closes at the END — never blindly.
  for (;;) {
    if (!out.startsWith("(") || !out.endsWith(")")) break;
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === "(") depth += 1;
      else if (out[i] === ")") {
        depth -= 1;
        if (depth === 0 && i !== out.length - 1) {
          closesAtEnd = false;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    out = out.slice(1, -1);
  }
  return out;
}

/** Read the balanced-paren group beginning at or after `from`; returns inner text and end index. */
function balanced(sql: string, from: number): { inner: string; end: number } | null {
  const open = sql.indexOf("(", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: sql.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** End of the statement starting at `from` — the first semicolon at paren depth 0. */
function statementEnd(sql: string, from: number): number {
  let depth = 0;
  for (let i = from; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") depth -= 1;
    else if (sql[i] === ";" && depth === 0) return i;
  }
  return sql.length;
}

type Policy = { cmd: string; roles: string; using: string; check: string };

/** Replay one file's policy DDL onto the running state. */
function applyFile(sql: string, state: Map<string, Policy>): void {
  const lower = sql.toLowerCase();

  const re = /\b(create|drop|alter)\s+policy\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const start = m.index;
    const end = statementEnd(sql, start);
    const stmt = sql.slice(start, end);
    const lstmt = stmt.toLowerCase();

    const onMatch = /\bon\s+(?:public\.)?"?([a-z_]+)"?/.exec(lstmt);
    if (!onMatch || !PINNED_TABLES.includes(onMatch[1])) continue;
    const table = onMatch[1];

    const nameMatch = /\b(?:create|drop|alter)\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?/.exec(lstmt);
    assert.ok(nameMatch, `could not read a policy name out of: ${stmt.slice(0, 120)}`);
    const key = `${table}.${nameMatch[1]}`;

    if (m[1] === "drop") {
      state.delete(key);
      continue;
    }

    assert.notEqual(
      m[1],
      "alter",
      `ALTER POLICY on ${key} is not supported by this guard — express the change as DROP + CREATE so the pinned expression stays reviewable`,
    );

    const cmdMatch = /\bfor\s+(all|select|insert|update|delete)\b/.exec(lstmt);
    const rolesMatch = /\bto\s+([a-z_,\s]+?)(?=\s+(?:using|with\s+check)\b|\s*$)/.exec(lstmt);

    const usingIdx = lstmt.search(/\busing\s*\(/);
    const checkIdx = lstmt.search(/\bwith\s+check\s*\(/);
    const usingExpr = usingIdx === -1 ? "" : (balanced(stmt, usingIdx)?.inner ?? "");
    const checkExpr = checkIdx === -1 ? "" : (balanced(stmt, checkIdx)?.inner ?? "");

    state.set(key, {
      cmd: cmdMatch ? cmdMatch[1] : "all",
      roles: rolesMatch ? rolesMatch[1].replace(/\s+/g, "") : "",
      using: norm(usingExpr),
      check: norm(checkExpr),
    });
  }
}

const OWN_DOC = "uploaded_by_user_id=(selectauth.uid())";
const OWN_HIST = "changed_by_user_id=(selectauth.uid())";
const SERVICE = "(selectauth.role())='service_role'";

const EXPECTED: Record<string, Policy> = {
  // The four authenticated predicates per table: a row is yours if your id is stamped on it.
  "employee_documents.emp_docs_select_own": { cmd: "select", roles: "authenticated", using: OWN_DOC, check: "" },
  "employee_documents.emp_docs_insert_own": { cmd: "insert", roles: "authenticated", using: "", check: OWN_DOC },
  "employee_documents.emp_docs_update_own": { cmd: "update", roles: "authenticated", using: OWN_DOC, check: OWN_DOC },
  "employee_documents.emp_docs_delete_own": { cmd: "delete", roles: "authenticated", using: OWN_DOC, check: "" },
  "employee_history.emp_hist_select_own": { cmd: "select", roles: "authenticated", using: OWN_HIST, check: "" },
  "employee_history.emp_hist_insert_own": { cmd: "insert", roles: "authenticated", using: "", check: OWN_HIST },
  "employee_history.emp_hist_update_own": { cmd: "update", roles: "authenticated", using: OWN_HIST, check: OWN_HIST },
  "employee_history.emp_hist_delete_own": { cmd: "delete", roles: "authenticated", using: OWN_HIST, check: "" },
  // The pair the application itself reads through — untouched by the users drop, by design.
  "employee_documents.phx_employee_documents_service_role": { cmd: "all", roles: "service_role", using: SERVICE, check: SERVICE },
  "employee_history.phx_employee_history_service_role": { cmd: "all", roles: "service_role", using: SERVICE, check: SERVICE },
};

export function runEmployeeRlsPolicyLockTests() {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migrations found — the replay would vacuously pass");

  const state = new Map<string, Policy>();
  for (const file of files) {
    applyFile(code(readFileSync(join(MIGRATIONS, file), "utf8")), state);
  }

  // POSITIVE CONTROL: an empty replay would satisfy every "is absent" check below, so prove the
  // parser actually saw policy DDL before trusting any verdict it produces.
  assert.equal(
    state.size,
    Object.keys(EXPECTED).length,
    `replaying the migrations left ${state.size} policies on ${PINNED_TABLES.join(" / ")}, expected ` +
      `${Object.keys(EXPECTED).length}. Found: ${[...state.keys()].sort().join(", ") || "(none)"}`,
  );

  for (const [key, want] of Object.entries(EXPECTED)) {
    const got = state.get(key);
    assert.ok(got, `${key} is gone — a migration dropped it without recreating it, so RLS on that table is now weaker`);
    assert.equal(got.cmd, want.cmd, `${key} must stay a ${want.cmd.toUpperCase()} policy`);
    assert.equal(got.roles, want.roles, `${key} must stay scoped to ${want.roles}`);
    assert.equal(
      got.using,
      want.using,
      `${key} USING expression changed — this is the predicate deciding who can see the row, never widen it silently`,
    );
    assert.equal(
      got.check,
      want.check,
      `${key} WITH CHECK expression changed — this is the predicate deciding what a user may write`,
    );
  }

  // The dead table must not come back through a policy expression.
  for (const [key, got] of state) {
    assert.ok(
      !/\busers\b/.test(got.using) && !/\busers\b/.test(got.check),
      `${key} references public.users, which was dropped on 2026-09-06 — the policy cannot evaluate`,
    );
  }
}
