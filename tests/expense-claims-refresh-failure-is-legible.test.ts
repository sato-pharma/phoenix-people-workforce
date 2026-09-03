import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeThrown } from "../src/lib/error-monitor/describe-thrown";

// -----------------------------------------------------------------------------
// A failed expense-claims refresh must say WHAT failed.
//
// 2026-09-03: phoenix-expense-claims-refresh went red at 02:51 Cairo and stayed red every
// hour. job_heartbeats.last_detail recorded the literal string "[object Object]" and the
// Railway log line said the same, so the job reported a failure with no cause attached.
//
// The mechanism is one this codebase already documents, verbatim, on
// src/lib/error-monitor/describe-thrown.ts: Supabase hands back a PLAIN OBJECT
// ({ message, details, hint, code }), not an Error. claims-refresh.ts rethrew it as-is, so
// every recorder downstream took its non-Error branch and called String() on an object.
//
// It disarmed the documented diagnosis path too. The cron route's own docstring names
// "railway logs | grep expense_claims_refresh" as the detection that actually works here --
// and log.ts serializeError was stringifying the same object the same way.
//
// The real cause, once legible, was 23514: the rebuilt row for OUTSTATION-52 violated
// expense_claims_approved_total_range. That is a data question, and a separate one. THIS
// test is only about the job being able to say so.
//
// Three points are pinned, because fixing one still leaves the other two blind.
// -----------------------------------------------------------------------------

const ROUTE = fileURLToPath(
  new URL("../app/api/cron/expense-claims-refresh/route.ts", import.meta.url),
);
const REFRESH = fileURLToPath(new URL("../src/lib/outstation/claims-refresh.ts", import.meta.url));
const LOG = fileURLToPath(new URL("../src/lib/observability/log.ts", import.meta.url));

// The exact rethrows that produced the blank detail. Substring, not regex: see the note above.
const BARE_THROWS = ["throw error;", "throw totalResult.error;", "throw driftResult.error;"];

export async function runExpenseClaimsRefreshTraceTests() {
  // 1. BEHAVIOUR -- the shape Supabase actually throws must not describe itself as a shrug.
  const postgrestError = { message: "violates check constraint", details: null, hint: null, code: "23514" };
  const described = describeThrown(postgrestError);
  assert.notEqual(
    described,
    "[object Object]",
    "describeThrown must not render a PostgREST error as [object Object] -- that is the whole bug",
  );
  assert.ok(
    described.includes("23514"),
    "the error code is the part that decides what to do, so it must survive; got: " + described,
  );

  // 2. SOURCE -- claims-refresh must not rethrow the raw Supabase object.
  const refresh = readFileSync(REFRESH, "utf8");
  const stillBare = BARE_THROWS.filter((snippet) => refresh.includes(snippet));
  assert.deepEqual(
    stillBare,
    [],
    "claims-refresh.ts must wrap a Supabase error before throwing it, or every recorder " +
      "downstream writes [object Object]. Still bare: " + stillBare.join(", "),
  );
  assert.ok(
    refresh.includes("function asError("),
    "claims-refresh.ts must keep the asError wrapper -- it is what makes the failure legible at source",
  );

  // 3. SOURCE -- neither recorder may fall back to String() on a thrown value.
  const route = readFileSync(ROUTE, "utf8");
  assert.ok(
    !route.includes("String(error)"),
    "the cron route must not String() a thrown value into the dead-man's-switch detail",
  );
  assert.ok(
    route.includes("describeThrown(error)"),
    "the cron route must record the described cause, so job_heartbeats.last_detail names the failure",
  );

  const log = readFileSync(LOG, "utf8");
  assert.ok(
    !log.includes("return { message: String(error) };"),
    "serializeError must not String() a non-Error -- that is what blanked the Railway log line",
  );
  assert.ok(
    log.includes("describeThrown(error)"),
    "serializeError must describe a non-Error throw, or railway logs | grep stays useless",
  );
}
