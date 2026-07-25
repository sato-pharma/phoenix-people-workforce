import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/**
 * Phase 3D coverage for the disabled Workflow Control API routes.
 *
 * These tests do NOT execute the route handlers (no Next request lifecycle in
 * unit tests). They assert the routes' source/contract — every required file
 * exists, every guarded route resolves access + gates to Super Admin, none of
 * them import Supabase / call fetch / query a DB table, no UI is wired to a
 * live mutation, and runtime workflow services do not depend on these routes.
 */
export function runWorkflowControlApiRoutesTests() {
  const apiRoot = new URL("../app/api/admin/workflow-control/", import.meta.url);

  // ---------------------------------------------------------------------------
  // 1. All API route files exist.
  // ---------------------------------------------------------------------------
  const routes: Array<{ relPath: string; methods: readonly string[]; note?: string }> = [
    { relPath: "definitions/route.ts",                          methods: ["GET"] },
    { relPath: "drafts/[domainKey]/[subflowKey]/route.ts",      methods: ["GET", "PUT"] },
    {
      relPath: "drafts/by-id/[draftId]/route.ts",
      methods: ["DELETE"],
      note: "DELETE uses a static /by-id/ segment to avoid a Next.js dynamic-segment collision with the GET/PUT route.",
    },
    { relPath: "versions/[domainKey]/[subflowKey]/route.ts",    methods: ["GET"] },
    { relPath: "publish/[draftId]/route.ts",                    methods: ["POST"] },
    { relPath: "rollback/route.ts",                             methods: ["POST"] },
    { relPath: "compare/route.ts",                              methods: ["POST"] },
  ];

  for (const r of routes) {
    const fileUrl = new URL(r.relPath, apiRoot);
    assert.ok(existsSync(fileUrl), `route file exists: ${r.relPath}`);
    const src = readFileSync(fileUrl, "utf8");

    // 2. Every route calls resolveAccessContext (via the shared guard helper).
    assert.match(src, /requireWorkflowControlAdmin\s*\(\s*request\s*\)/, `${r.relPath} resolves access via requireWorkflowControlAdmin(request)`);

    // 3. Every route returns the guard's 401/403 NextResponse when the gate fails.
    assert.match(src, /if\s*\(\s*!\s*guard\.ok\s*\)\s*return\s+guard\.response/, `${r.relPath} returns the guard's response on failure`);

    // 9. API routes do NOT import Supabase directly.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    assert.equal(/from\s+["']@\/lib\/supabase\b/.test(stripped), false, `${r.relPath} must not import @/lib/supabase`);
    assert.equal(/from\s+["']@supabase\/supabase-js["']/.test(stripped), false, `${r.relPath} must not import @supabase/supabase-js`);
    assert.equal(/\bgetSupabaseAdmin\s*\(/.test(stripped), false, `${r.relPath} must not call getSupabaseAdmin()`);
    assert.equal(/\bgetSupabaseUserClient\s*\(/.test(stripped), false, `${r.relPath} must not call getSupabaseUserClient()`);

    // 10. API routes do NOT call fetch external APIs.
    assert.equal(/\bfetch\s*\(/.test(stripped), false, `${r.relPath} must not call fetch()`);
    assert.equal(/\bXMLHttpRequest\b/.test(stripped), false, `${r.relPath} must not use XMLHttpRequest`);

    // 11. No route writes to DB while disabled.
    assert.equal(/\.from\s*\(\s*["'`]/.test(stripped), false, `${r.relPath} must not query a DB table`);

    // Each route declares the documented HTTP methods.
    for (const method of r.methods) {
      const handler = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`);
      assert.match(src, handler, `${r.relPath} exports the ${method} handler`);
    }
  }

  // ---------------------------------------------------------------------------
  // 3 + 4. All mutation routes enforce Super Admin via canUseWorkflowDraftEditor.
  //   (The shared guard delegates to canUseWorkflowDraftEditor, which is
  //   Super-Admin-only — proven in tests/workflow-control.test.ts.)
  // ---------------------------------------------------------------------------
  const helpersSrc = readFileSync(new URL("../src/lib/workflow-control/api-helpers.ts", import.meta.url), "utf8");
  assert.match(helpersSrc, /canUseWorkflowDraftEditor/, "guard helper uses Super-Admin gate");
  assert.match(helpersSrc, /resolveAccessContext\s*\(\s*request\s*\)/, "guard helper calls resolveAccessContext(request)");
  // Helper itself is also Supabase-free.
  const helpersStripped = helpersSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  assert.equal(/from\s+["']@\/lib\/supabase\b/.test(helpersStripped), false, "api-helpers must not import @/lib/supabase");
  assert.equal(/\bgetSupabaseAdmin\s*\(/.test(helpersStripped), false, "api-helpers must not call getSupabaseAdmin()");
  assert.equal(/\bfetch\s*\(/.test(helpersStripped), false, "api-helpers must not call fetch()");

  // ---------------------------------------------------------------------------
  // 5-7. Disabled response wiring: every mutation route returns the service
  //   Result via serviceResultToResponse, which maps the disabled codes to 503.
  // ---------------------------------------------------------------------------
  const mutationRoutes = [
    "drafts/[domainKey]/[subflowKey]/route.ts",          // PUT save
    "drafts/by-id/[draftId]/route.ts",                   // DELETE
    "publish/[draftId]/route.ts",                        // POST publish
    "rollback/route.ts",                                 // POST rollback
  ];
  for (const rel of mutationRoutes) {
    const src = readFileSync(new URL(rel, apiRoot), "utf8");
    assert.match(src, /serviceResultToResponse\s*\(/, `${rel} returns via serviceResultToResponse`);
  }
  // Result map sends disabled codes as 503.
  assert.match(helpersSrc, /persistence_disabled:\s*503/, "persistence_disabled maps to HTTP 503");
  assert.match(helpersSrc, /publish_disabled:\s*503/, "publish_disabled maps to HTTP 503");
  assert.match(helpersSrc, /rollback_disabled:\s*503/, "rollback_disabled maps to HTTP 503");
  assert.match(helpersSrc, /forbidden:\s*403/, "forbidden maps to HTTP 403");

  // ---------------------------------------------------------------------------
  // 8. Definitions route is read-only and does not mutate.
  // ---------------------------------------------------------------------------
  const defSrc = readFileSync(new URL("definitions/route.ts", apiRoot), "utf8");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`).test(defSrc), false, `definitions route must not export ${method}`);
  }

  // ---------------------------------------------------------------------------
  // 12. No runtime workflow services import these API routes / services.
  // ---------------------------------------------------------------------------
  const runtimeServices = [
    "src/lib/vacation/service.ts",
    "src/lib/outstation/service.ts",
    "src/lib/probation/service.ts",
    "src/lib/contracts/service.ts",
    "src/lib/resignations/service.ts",
    "src/lib/marketing-requests/service.ts",
    "src/lib/coaching/service.ts",
    "src/lib/payroll/service.ts",
  ];
  for (const rel of runtimeServices) {
    let src = "";
    try { src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"); } catch { continue; }
    assert.equal(/@\/lib\/workflow-control\/services\b/.test(src), false, `${rel} must not import workflow-control services in Phase 3D`);
    assert.equal(/@\/lib\/workflow-control\/api-helpers\b/.test(src), false, `${rel} must not import workflow-control api-helpers in Phase 3D`);
    assert.equal(/\/api\/admin\/workflow-control\//.test(src), false, `${rel} must not call any workflow-control API route in Phase 3D`);
  }

  // The UI Draft Editor must NOT be wired to these routes yet (Save/Publish stay client-only).
  const editorSrc = readFileSync(new URL("../src/components/workflow-control/workflow-draft-editor.tsx", import.meta.url), "utf8");
  assert.equal(/\/api\/admin\/workflow-control\//.test(editorSrc), false, "draft editor must not call the Phase 3D API routes yet");
  assert.equal(/\bfetch\s*\(/.test(editorSrc), false, "draft editor must not call fetch() yet");

  // The migration is still draft-only (single file).
  const migrationsDir = new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url);
  const wc = readdirSync(migrationsDir).filter((n) => /workflow_control_phase3/.test(n));
  assert.equal(wc.length, 1, "exactly one workflow_control_phase3 migration draft on disk");
}
