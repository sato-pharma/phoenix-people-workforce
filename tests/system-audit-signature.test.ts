import assert from "node:assert/strict";

import {
  appErrorCode,
  appErrorSignatureV1,
  firstServerAppFrame,
  guestActorKey,
  isAddress,
  messageTemplate,
  normaliseServerFrame,
  parseClientContext,
  pathOnly,
  routeFamily,
  type AppErrorEventRow,
} from "../src/lib/system-audit/signature.ts";

/**
 * The System Audit's signature — what one failure IS, whatever browser, person, page load or
 * deploy it reached. Each assertion below is a way the old Error Monitor split one bug into many
 * issues (or merged many into one), measured on production rows on 2026-10-23.
 */

function row(overrides: Partial<AppErrorEventRow>): AppErrorEventRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-10-20T10:00:00.000Z",
    source: "client",
    hr_id: "B-10",
    login_id: "B-10",
    role: "Super Admin",
    route: "/employee-portals/field-crm",
    route_type: "page",
    message: "Error: something broke",
    stack: null,
    environment: "production",
    user_agent: "Mozilla/5.0",
    ...overrides,
  };
}

export function runSystemAuditSignatureTests() {
  // ── The three engines' wording of one failure is one template, and one key ─────────────────────
  const chrome = "TypeError: Cannot read properties of undefined (reading 'items')";
  const safari = "TypeError: undefined is not an object (evaluating 'e.data.items')";
  const firefox = `TypeError: can't access property "items", t.data is undefined`;
  assert.equal(messageTemplate(chrome), "null-access:items", "Chrome's null read must template to null-access:items");
  assert.equal(messageTemplate(safari), "null-access:items", "Safari's null read must template to null-access:items");
  assert.equal(messageTemplate(firefox), "null-access:items", "Firefox's null read must template to null-access:items");
  const engineKeys = new Set([chrome, safari, firefox].map((message) => appErrorSignatureV1(row({ message })).key));
  assert.equal(engineKeys.size, 1, "Chrome, Safari and Firefox spelling one null read must share ONE signature key");

  // ── React's arguments name the element, not the failure ────────────────────────────────────────
  const reactDiv = "Minified React error #418; visit https://react.dev/errors/418?args[]=div&args[]=span for the full message";
  const reactP = "Minified React error #418; visit https://react.dev/errors/418?args[]=p&args[]=%0A for the full message";
  assert.equal(messageTemplate(reactDiv), "react:418");
  assert.equal(
    appErrorSignatureV1(row({ message: reactDiv })).key,
    appErrorSignatureV1(row({ message: reactP })).key,
    "two React #418 rows differing only in their args[] must share one signature key",
  );
  // The server-render fallback names its cause on a LATER line; the cause is still the template.
  assert.equal(
    messageTemplate("Switched to client rendering because the server rendering errored:\n\nMinified React error #419; visit https://react.dev/errors/419"),
    "react-switched:419",
    "a multi-line server-render fallback must keep its React code",
  );
  assert.equal(
    messageTemplate("Switched to client rendering because the server rendering errored:\n\nCannot read properties of null (reading 'name')"),
    "react-switched:null-access:name",
  );

  // ── Masked text: ids, numbers, emails and quoted values never enter the key ────────────────────
  assert.equal(
    messageTemplate("Failed to save visit 3f2b8c1a-1111-4222-8333-444455556666 for B-10 (attempt 3)"),
    "Failed to save visit <uuid> for <hr> (attempt <n>)",
  );
  assert.equal(messageTemplate('Unknown customer "Dr Ahmed" at a.b@sato.com'), "Unknown customer <str> at <email>");
  assert.equal(messageTemplate("Script error."), "masked-script-error");
  assert.equal(messageTemplate("TypeError: Failed to fetch"), "network:fetch-failed");
  assert.equal(messageTemplate("Loading chunk 812 failed."), "stale-chunk");
  assert.equal(messageTemplate("t.items.map is not a function"), "not-a-function:map");
  assert.equal(messageTemplate("e.items.map is not a function"), "not-a-function:map", "minified local names must not split one failure");
  assert.equal(messageTemplate("ReferenceError: google is not defined"), "not-defined:google");
  assert.equal(messageTemplate('{"message":"permission denied for table x","details":"…"}'), "permission denied for table x");
  assert.equal(messageTemplate(""), "empty-message");

  // ── Where: a component, a server frame, a third-party host, a job, the route ───────────────────
  const component = appErrorSignatureV1(row({ stack: "boom\n\n— Component stack —\n    in VisitForm\n    in Page" }));
  assert.equal(component.parts.where, "component:VisitForm");
  const otherComponent = appErrorSignatureV1(row({ stack: "boom\n\n— Component stack —\n    in PlanForm\n    in Page" }));
  assert.notEqual(component.key, otherComponent.key, "one message thrown by two components is two issues");

  const thirdParty = appErrorSignatureV1(row({ stack: "TypeError: x\n    at Ab (https://maps.googleapis.com/maps-api-v3/api/js/58/1/main.js:120:33)" }));
  assert.equal(thirdParty.parts.where, "third-party:maps.googleapis.com");

  const serverStack = "Error: x\n    at handler (/app/.next/server/chunks/ssr/src_lib_auth_1t8c37a1e2azj._.js:12:30)";
  assert.equal(normaliseServerFrame("/app/.next/server/chunks/ssr/src_lib_auth_1t8c37a1e2azj._.js"), "ssr/src_lib_auth");
  assert.equal(normaliseServerFrame("/app/.next/server/chunks/ssr/_0f7t6cvfg1ymw._.js"), null, "a hash-only chunk names nothing");
  assert.equal(normaliseServerFrame("/app/node_modules/next/dist/server/base-server.js"), null);
  assert.equal(firstServerAppFrame(serverStack), "ssr/src_lib_auth");
  const server = appErrorSignatureV1(row({ source: "server", stack: serverStack }));
  assert.equal(server.parts.where, "frame:ssr/src_lib_auth");
  // A redeploy changes the chunk hash; the issue must not change with it.
  const redeployed = appErrorSignatureV1(row({ source: "server", stack: serverStack.replace("1t8c37a1e2azj", "9zz8yy7xx6ww5") }));
  assert.equal(server.key, redeployed.key, "a new build hash must not make a new issue");

  const job = appErrorSignatureV1(row({ source: "server", route: "cron.notify-daily", route_type: "structured-log" }));
  assert.equal(job.parts.where, "job:cron.notify-daily");
  assert.equal(job.parts.routeFamily, null);

  const byRoute = appErrorSignatureV1(row({ route: "/employee-portals/employee-360/a-12?tab=visits" }));
  assert.equal(byRoute.parts.where, "route:/employee-portals/employee-360/[id]");

  // ── Route families ─────────────────────────────────────────────────────────────────────────────
  assert.equal(routeFamily("/employee-portals/employee-360/a-12"), "/employee-portals/employee-360/[id]");
  assert.equal(routeFamily("/admin/visits/3f2b8c1a-1111-4222-8333-444455556666/edit"), "/admin/visits/[id]/edit");
  assert.equal(routeFamily("/hr/probation"), routeFamily("/probation"), "the proxy's /hr spelling and the bare one are one family");
  assert.equal(routeFamily("/page?_rsc=abc"), "/page");
  assert.equal(pathOnly("/a/b/?x=1#y"), "/a/b");
  assert.equal(isAddress("cron.notify-daily"), false);
  assert.equal(isAddress("/api/x"), true);

  // ── The client context ─────────────────────────────────────────────────────────────────────────
  const context = parseClientContext("— Client context —\nsinceNavMs=1834 seq=2 readyState=complete navType=navigate domRewriter=translate\n\nError: x");
  assert.equal(context.sinceNavMs, 1834);
  assert.equal(context.readyState, "complete");
  assert.equal(context.domRewriter, "translate");
  assert.equal(parseClientContext("Error: x").sinceNavMs, null);

  // ── Keys, codes and guests ─────────────────────────────────────────────────────────────────────
  assert.match(server.key, /^app:v1:[0-9a-f]{16}$/);
  assert.equal(appErrorCode("app:v1:1a2b3c4d5e6f7a8b"), "APP-1A2B3C4D");
  assert.equal(guestActorKey("Mozilla/5.0 A"), guestActorKey("Mozilla/5.0 A"));
  assert.notEqual(guestActorKey("Mozilla/5.0 A"), guestActorKey("Mozilla/5.0 B"), "two guests' browsers never merge");
  assert.equal(guestActorKey(null), "guest:unknown");
  // The person is not part of WHAT failed.
  assert.equal(appErrorSignatureV1(row({ hr_id: "A-1" })).key, appErrorSignatureV1(row({ hr_id: "B-2" })).key);
  assert.notEqual(appErrorSignatureV1(row({ source: "server" })).key, appErrorSignatureV1(row({ source: "client" })).key);
}
