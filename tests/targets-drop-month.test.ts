import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

// "Drop this month" on the Targets screen (owner, 2026-10-04): a Super Admin can remove ONE line's
// targets for ONE month. au.monthly_targets keeps no history, so the RPC archives before it deletes,
// and the route — not the button — is what keeps everyone else out.

const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

export function runTargetsDropMonthTests() {
  const route = stripComments(read("app/api/sales/targets/drop/route.ts"));
  const lib = stripComments(read("src/lib/sales/monthly-targets-drop.ts"));
  const ui = stripComments(read("src/components/sales/targets-authoring.tsx"));
  const page = stripComments(read("app/(admin)/sales/targets/page.tsx"));
  const sql = read("supabase/migrations/20261004141055_drop_line_month_targets_with_archive.sql");

  // ── The route is the boundary: sales:import AND Super Admin, checked server-side ──
  assert.match(route, /assertPermission\(access, "sales", "import"\)/, "the drop route must stay on sales:import");
  assert.match(route, /access\.role !== "Super Admin"/, "the drop route must refuse every role but Super Admin");
  assert.ok(
    route.indexOf('access.role !== "Super Admin"') < route.indexOf("dropMonthlyTargets("),
    "the role check must run BEFORE the drop",
  );

  // ── A published or locked closing is never touched ──
  assert.match(lib, /isClosingPublished\(/);
  assert.match(lib, /isClosingLocked\(/);
  assert.ok(
    lib.indexOf("isClosingPublished(") < lib.indexOf('rpc("phx_drop_monthly_targets"'),
    "the closing guard must run BEFORE the RPC",
  );

  // ── The button only renders for the Super Admin the page computed, and the page computes it from the role ──
  assert.match(page, /canDrop=\{canEdit && access\.role === "Super Admin"\}/);
  assert.match(ui, /props\.canDrop === true/, "canDrop must be opt-in, never defaulted on");
  assert.match(ui, /canDrop \? \(/, "the button must sit behind canDrop");
  assert.match(ui, /window\.confirm\(\s*`Drop ALL \$\{lineLabel\} targets for/, "the drop must ask first, naming line and month");
  assert.match(ui, /"\/api\/sales\/targets\/drop"/);

  // ── The SQL archives before deleting, and is service-role only ──
  const insertAt = sql.indexOf("insert into au.monthly_targets_dropped");
  const deleteAt = sql.indexOf("delete from au.monthly_targets t");
  assert.ok(insertAt > 0 && deleteAt > insertAt, "the RPC must archive the rows BEFORE it deletes them");
  assert.match(sql, /where t\.period = p_period and t\.line_code = p_line_code/, "the drop must be scoped to one line AND one month");
  assert.match(sql, /revoke execute on function public\.phx_drop_monthly_targets\(text, text, text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.phx_drop_monthly_targets\(text, text, text\) to service_role/);
  assert.match(sql, /alter table au\.monthly_targets_dropped enable row level security/);
}
