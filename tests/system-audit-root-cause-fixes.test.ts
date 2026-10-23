import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { canUseAdminCrmWorkspace } from "../src/lib/crm/admin-access.ts";

/**
 * The confirmed defects the System Audit root-cause report (23 Oct 2026) found still in the code.
 * Each pin is a function returning what is MISSING from the source, so the test below also hands it
 * a broken copy and requires it to fire — never a one-off break by hand. Comments are stripped
 * first: every fix is explained in prose beside it, and prose satisfies a substring check.
 */
function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

/** APP-20D39617 — the heartbeat's request-counting step answers a database outage with 503, not a crash. */
export function heartbeatRateLimitOutageMissing(source: string): string[] {
  const catchBlock = source.match(/catch \(error\) \{\n\s*if \(!isApiRateLimitError\(error\)\) \{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  return /if \(isSessionServiceOutage\(error\)\) return sessionServiceUnavailable\(\);/.test(catchBlock)
    ? []
    : ["the rate-limit catch must answer a database outage with sessionServiceUnavailable() before rethrowing"];
}

/** APP-564C1D30 — the Double Visit integrity report opens for the same roles as its page. */
export function doubleVisitGateMissing(source: string): string[] {
  const missing: string[] = [];
  if (/role !== "Super Admin"\) \{\n\s*throw new Error\("Forbidden: only Super Admin can view the Double Visit Data Integrity/.test(source)) {
    missing.push("the integrity report must use the admin CRM workspace door, not a Super-Admin-only check");
  }
  if (!/export async function getDoubleVisitDataIntegrityReport[\s\S]{0,800}if \(!canUseAdminCrmWorkspace\(access\)\)/.test(source)) {
    missing.push("getDoubleVisitDataIntegrityReport must check canUseAdminCrmWorkspace");
  }
  if (!/export async function getDoubleVisitRecoveredChains[\s\S]{0,800}if \(!canUseAdminCrmWorkspace\(input\.access\)\)/.test(source)) {
    missing.push("getDoubleVisitRecoveredChains must check canUseAdminCrmWorkspace");
  }
  return missing;
}

/** APP-B05C8CA4 — losing the open-conversation race is "already open", never "send failed". */
export function whatsappRaceMissing(source: string): string[] {
  const start = source.slice(source.indexOf("export async function startClassification"));
  const body = start.slice(0, start.indexOf("\n}\n"));
  const raceAnswer = body.search(/if \(error && \(error as \{ code\?: string \}\)\.code === "23505"\) return "already_open";/);
  const rethrow = body.indexOf("if (error) throw error;");
  if (raceAnswer < 0) return ["a 23505 on the session insert must answer already_open"];
  if (rethrow >= 0 && raceAnswer > rethrow) return ["the 23505 answer must come before the rethrow"];
  return [];
}

/** APP-518F5E21 / APP-39BE50BC — an address that is not an order id is "no such order", never a 22P02. */
export function directOrderUuidMissing(source: string): string[] {
  const start = source.slice(source.indexOf("export async function getDirectOrderRequest("));
  const body = start.slice(0, start.indexOf("\n}\n"));
  const guard = body.indexOf("if (!isUuid(requestId)) return null;");
  const read = body.indexOf('.from("direct_order_requests")');
  if (guard < 0) return ["getDirectOrderRequest must answer null for an id that is not a uuid"];
  if (read >= 0 && guard > read) return ["the uuid check must run before the database read"];
  return [];
}

/** APP-C2E4684A — the Touch Trail day read has an index in its own order. */
export function touchTrailIndexMissing(migration: string): string[] {
  return /create index if not exists phoenix_crm_touch_trail_day_id_idx\s+on public\.phoenix_crm_touch_trail \(visit_day, id\);/.test(migration)
    ? []
    : ["the (visit_day, id) index must exist for the day read's visit_day = $1 AND id > $cursor ORDER BY id"];
}

function firesOnBreak(name: string, check: (source: string) => string[], source: string, broken: string) {
  assert.notEqual(broken, source, `${name}: the broken copy must actually differ`);
  assert.ok(check(broken).length > 0, `${name}: the pin fires when the fix is removed`);
}

export async function runSystemAuditRootCauseFixesTests() {
  const heartbeat = code("app/api/auth/heartbeat/route.ts");
  assert.deepEqual(heartbeatRateLimitOutageMissing(heartbeat), [], "the heartbeat never crashes on a database restart");
  firesOnBreak(
    "heartbeat",
    heartbeatRateLimitOutageMissing,
    heartbeat,
    heartbeat.replace(/\n\s*if \(isSessionServiceOutage\(error\)\) return sessionServiceUnavailable\(\);\n(\s*throw error;\n\s*\})/, "\n$1"),
  );

  const doubleVisit = code("src/lib/double-visit-analytics/service.ts");
  assert.deepEqual(doubleVisitGateMissing(doubleVisit), [], "the SFE Manager the page admits can read the report");
  firesOnBreak(
    "double visit",
    doubleVisitGateMissing,
    doubleVisit,
    doubleVisit.replace("if (!canUseAdminCrmWorkspace(access)) {", 'if (access.role !== "Super Admin") {'),
  );
  // The door the service now shares is the page's: Super Admin and SFE Manager, nobody else.
  assert.equal(canUseAdminCrmWorkspace({ role: "SFE Manager", scope: "team" } as never), true, "the SFE Manager holds the workspace");
  assert.equal(canUseAdminCrmWorkspace({ role: "Medical Rep", scope: "own" } as never), false, "a rep does not");

  const whatsapp = code("src/lib/recruitment/inbound/whatsapp-classify-session.ts");
  assert.deepEqual(whatsappRaceMissing(whatsapp), [], "two CVs at once never read as a failed start");
  firesOnBreak(
    "whatsapp",
    whatsappRaceMissing,
    whatsapp,
    whatsapp.replace(/\n\s*if \(error && \(error as \{ code\?: string \}\)\.code === "23505"\) return "already_open";/, ""),
  );

  const directOrders = code("src/lib/direct-orders/service.ts");
  assert.deepEqual(directOrderUuidMissing(directOrders), [], "a mistyped order address is not found, never a crash");
  firesOnBreak("direct orders", directOrderUuidMissing, directOrders, directOrders.replace("if (!isUuid(requestId)) return null;", ""));

  const migration = readFileSync(
    new URL("../supabase/migrations/20261023210000_phoenix_crm_touch_trail_day_id_index.sql", import.meta.url),
    "utf8",
  );
  assert.deepEqual(touchTrailIndexMissing(migration), [], "the Touch Trail day read is indexed in its own order");
  firesOnBreak("touch trail", touchTrailIndexMissing, migration, migration.replace("on public.phoenix_crm_touch_trail (visit_day, id);", "on public.phoenix_crm_touch_trail (visit_day, seat_id);"));
}
