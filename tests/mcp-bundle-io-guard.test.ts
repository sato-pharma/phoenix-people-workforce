// The MCP reader's bundle may not carry administrative Phoenix IO, and the assertion that proves it
// must run on every pull request.
//
// WHY THIS EXISTS. `infra/phoenix-mcp/build.mjs` ends with one assertion — "Administrative Phoenix
// IO survived bundling" — over the emitted `dist/main.mjs`. It is what keeps the service-role key,
// the PostgREST base URL and `supabase.co` out of a process that is supposed to reach the database
// through a read-only role and nothing else. esbuild's tree-shaking is the only thing enforcing it:
// `build.mjs`'s deny plugin stubs `@/lib/supabase/server`, `@/lib/supabase-rest` and
// `@/lib/observability/log` BY MODULE NAME, and five files under `src/lib/` carry their own PRIVATE
// `supabaseRest` that no module-name stub can reach.
//
// On 23 Oct 2026 that assertion was RED on `origin/main` and had been for days. Two independent
// defects, one each:
//
//   1. `src/lib/email/recipient-assurance.ts` constructed its production directory reader at MODULE
//      level. A top-level CALL is a side effect esbuild may not drop, so the statement was retained,
//      and with it its default argument `loadAssuranceDirectoryFresh` ->
//      `getEmployeeDirectoryRows` -> the private `supabaseRest` inside
//      `src/lib/employees/employee-directory.ts`, which spells both `/rest/v1/` and
//      `getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY")`. The reader is now built on first use.
//   2. `.github/workflows/phoenix-mcp.yml` triggers on nine paths, and the bundle's real import
//      graph is most of `src/lib/` — so the change that broke it (#6297, background-job findings)
//      touched none of the nine, that workflow never ran, and `mcp-security` is not one of `main`'s
//      required checks either. The assertion is now also a step in `ci.yml`'s `static` job, which
//      has no `paths:` filter and which the required `checks` status stands behind.
//
// So this test pins the two halves of that repair: the defect shape in the source, and the gate that
// would have caught it. It deliberately does NOT re-run esbuild — CI does that, in `static`, in
// seconds; a test that bundled here would need `infra/phoenix-mcp/node_modules`, which the repo's
// own install never creates.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** The one Phoenix file whose eager construction retained the admin chain. */
const ASSURANCE = "src/lib/email/recipient-assurance.ts";

export function runMcpBundleIoGuardTests() {
  // ── 1. the defect shape: nothing calls the reader factory at module level ────────────────────────
  const assurance = readFileSync(ASSURANCE, "utf8");

  assert.match(
    assurance,
    /export function createAssuranceDirectoryReader\(/,
    `${ASSURANCE} must still expose the reader factory the tests inject into`,
  );

  // A top-level `const x = createAssuranceDirectoryReader()` is exactly what retained
  // loadAssuranceDirectoryFresh -> getEmployeeDirectoryRows -> the private supabaseRest.
  // Matched at column 0 only: a call INSIDE a function is the fix, not the defect.
  assert.doesNotMatch(
    assurance,
    /^(?:const|let|var)\s+\w+\s*(?::[^=\n]+)?=\s*createAssuranceDirectoryReader\s*\(/m,
    "the production assurance reader must be constructed on first use, never at import: a " +
      "module-level call is a side effect esbuild cannot drop, and it retains the employee " +
      "directory's private supabaseRest in the MCP bundle (infra/phoenix-mcp/build.mjs then throws " +
      "'Administrative Phoenix IO survived bundling')",
  );

  // And the guard it protects still fails closed rather than returning an empty directory.
  assert.match(
    assurance,
    /throw new RecipientAssuranceUnavailableError\(error\);/,
    "a directory read with no recent copy still REFUSES — the email is held, never sent unguarded",
  );
  assert.match(
    assurance,
    /export const ASSURANCE_DIRECTORY_MAX_STALE_MS = 24 \* 60 \* 60 \* 1000;/,
    "the last-good copy still stands in for at most 24 hours",
  );

  // ── 2. the gate: the bundle assertion runs on every pull request, not on nine paths ──────────────
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const staticJob = ci.slice(ci.indexOf("\n  static:"), ci.indexOf("\n  unit:"));
  assert.ok(staticJob.length > 0, "ci.yml must still have a `static` job ahead of `unit`");

  assert.match(
    staticJob,
    /working-directory: infra\/phoenix-mcp/,
    "`static` must run the MCP bundle in infra/phoenix-mcp",
  );
  assert.match(
    staticJob,
    /node build\.mjs/,
    "`static` must run `node build.mjs`, which is where the 'Administrative Phoenix IO survived " +
      "bundling' assertion lives — without it the assertion is gated only by phoenix-mcp.yml's " +
      "nine paths, which is how a red `main` went unnoticed for days on 23 Oct 2026",
  );

  // `static` has no paths filter of its own, and `checks` is what makes its result count.
  assert.doesNotMatch(staticJob, /^\s{4}paths:/m, "`static` must stay unconditional on the diff");
  const checksJob = ci.slice(ci.indexOf("\n  checks:"));
  assert.match(
    checksJob.slice(0, 400),
    /needs: \[static, unit\]/,
    "the required `checks` status must still stand behind `static`",
  );

  // The assertion itself must still be in build.mjs — the step above is worthless without it.
  const build = readFileSync("infra/phoenix-mcp/build.mjs", "utf8");
  assert.match(
    build,
    /Administrative Phoenix IO survived bundling/,
    "infra/phoenix-mcp/build.mjs must still assert over the emitted bundle",
  );
  // Spelled as they appear INSIDE build.mjs's regex literal, escapes included.
  for (const pattern of ["serviceRoleKey", "\\/rest\\/v1\\/", 'getRequiredEnv\\("SUPABASE', "supabase\\.co"]) {
    assert.ok(
      build.includes(pattern),
      `build.mjs's assertion must still look for ${pattern} in the emitted bundle`,
    );
  }

  // And phoenix-mcp.yml keeps its narrower, deeper pass — it is not the gate, but it is not dead.
  const mcpWorkflow = readFileSync(".github/workflows/phoenix-mcp.yml", "utf8");
  assert.match(mcpWorkflow, /npm test/, "phoenix-mcp.yml still runs the MCP's own test suite");
  assert.match(
    mcpWorkflow,
    /THIS LIST IS NOT THE COVERAGE OF THE BUNDLE'S SECURITY ASSERTION/,
    "phoenix-mcp.yml must keep saying why its nine paths are not the coverage",
  );
}
