import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isEmployeeContext } from "../src/lib/action-center/employee-context.ts";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/**
 * Approvals Hub — an employee-context response the caller is not allowed to read must never reach
 * the component's state.
 *
 * Production, 2026-09-15: HR Operations approves leave company-wide, but her scope is "company",
 * not "system", so `/api/approvals-hub/employee-context` answers 403 for every employee outside
 * her own direct reports. The client cast that error body straight to the context type, and the
 * `.length` reads below it threw during render — the whole hub went to its error boundary, 22
 * times in 32 seconds, once per row she selected.
 *
 * The guard here is the shape check, so it holds whether or not the permission is widened later.
 */
export function runApprovalsHubEmployeeContextGuardTests() {
  // ── The bodies the endpoint really answers with ─────────────────────────────
  const route = source("../app/api/approvals-hub/employee-context/route.ts");
  assert.match(
    route,
    /\{\s*error:\s*"forbidden",\s*message:\s*"Forbidden\."\s*\}[\s\S]{0,60}status:\s*403/,
    "the endpoint must still answer 403 with the bare forbidden body this guard is written against",
  );

  assert.equal(
    isEmployeeContext({ error: "forbidden", message: "Forbidden." }),
    false,
    "the 403 forbidden body is not employee context",
  );
  assert.equal(
    isEmployeeContext({ error: "Context unavailable" }),
    false,
    "the 500 body is not employee context",
  );
  assert.equal(isEmployeeContext(null), false, "null is not employee context");
  assert.equal(isEmployeeContext("Forbidden."), false, "a bare string is not employee context");
  assert.equal(isEmployeeContext({}), false, "an empty object is not employee context");
  assert.equal(
    isEmployeeContext({ attendance: {}, recentLeave: [] }),
    false,
    "a body missing recentExcuses is not employee context",
  );
  assert.equal(
    isEmployeeContext({ attendance: {}, recentLeave: [], recentExcuses: [] }),
    true,
    "the real payload shape passes, including the empty-history case",
  );

  // ── The client must never put an unvalidated body into state ────────────────
  const hub = source("../src/components/action-center/action-center-hub.tsx");

  assert.doesNotMatch(
    hub,
    /await r\.json\(\)\) as ContextData/,
    "the employee-context response must not be cast blind to ContextData",
  );
  assert.match(
    hub,
    /const d = isEmployeeContext\(body\) \? body : null;/,
    "the fetched body must pass isEmployeeContext before it becomes context state",
  );
  assert.match(
    hub,
    /r\.ok \? await r\.json\(\) : null/,
    "a non-ok response must not even be parsed as context",
  );

  // ── And the reads that threw must survive a null/!partial context ───────────
  assert.match(
    hub,
    /contextData\?\.recentLeave\?\.length/,
    "the render-body leave hint must optional-chain recentLeave, not just contextData",
  );
  assert.doesNotMatch(
    hub,
    /data\.recentLeave\.length|data\.recentExcuses\.length|contextData\?\.recentLeave\.length/,
    "no unguarded .length read on the context arrays may come back",
  );
}
