import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { userScreenSignature, userScreenWhere } from "../src/lib/system-audit/detectors/user-screens.ts";
import {
  appErrorCode,
  appErrorSignatureV1,
  firstServerAppFrame,
  guestActorKey,
  isAddress,
  maskScreenNames,
  messageTemplate,
  normaliseServerFrame,
  parseClientContext,
  pathOnly,
  routeFamily,
  screenMessageTemplate,
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

  runScreenNameMaskingTests();
}

/**
 * Owner, 17 Nov 2026: ONE refusal is ONE issue whatever place or customer it names. The block-screen
 * key hashed the words the person saw, so "This location is not at <Arabic place> on Google Maps"
 * filed 20 issues on production, one per place — his "no defect" on one never reached the other 19.
 * The messages below are the production shapes of that day.
 */
function runScreenNameMaskingTests() {
  const VALIDATE = "/api/phoenix-crm/list/validate";
  const notAt = (place: string) =>
    `This location is not at ${place} on Google Maps (it must be within 150 m). Stand at its entrance, then take the photo and press Capture location again.`;
  const refusal = (message: string | null, overrides: Partial<{ kind: "refused_request" | "failed_request" | "error_screen"; api_path: string | null; page_path: string | null; http_status: number | null }> = {}) => ({
    kind: "refused_request" as const,
    api_path: VALIDATE,
    page_path: "/employee-portals/field-crm",
    http_status: 400,
    message,
    ...overrides,
  });
  // The key exactly as it was computed before the masking: the same parts, the template unmasked.
  const keyBefore = (screen: ReturnType<typeof refusal>) =>
    `screen:v1:${createHash("sha1")
      .update(JSON.stringify([1, screen.kind, userScreenWhere(screen), screen.http_status ?? null, messageTemplate(screen.message)]))
      .digest("hex")
      .slice(0, 16)}`;

  // ── One refusal, many place names: ONE key ──────────────────────────────────────────────────────
  const places = ["مستشفي السلام", "تعاقد البريد بني سويف", "شركة", "دسوق العام  دسوق   العام", "مصانع سكر أبو قرقاص الجديدة"];
  const placeKeys = new Set(places.map((place) => userScreenSignature(refusal(notAt(place)))));
  assert.equal(placeKeys.size, 1, `one refusal naming ${places.length} different Arabic places must be ONE issue (got ${placeKeys.size} keys)`);
  assert.equal(
    screenMessageTemplate(notAt("مستشفي الجوي التخصصي")),
    "This location is not at <name> on Google Maps (it must be within <n> m). Stand at its entrance, then take the photo and press Capture location again.",
    "the name is masked as one run, however many words and spaces, and the English around it is kept",
  );
  const fullName = (name: string) => `${name} needs a full name first. Open this customer in your list, tap Change the details and write the first and last name.`;
  assert.equal(
    userScreenSignature(refusal(fullName("ابانوب عوض"), { api_path: "/api/phoenix-crm/plans" })),
    userScreenSignature(refusal(fullName("عبدالرحمن عبدالرازق"), { api_path: "/api/phoenix-crm/plans" })),
    "a customer's Arabic name at the start of a refusal does not split it either",
  );

  // ── Typographic quotes mask like straight ones ──────────────────────────────────────────────────
  assert.equal(
    maskScreenNames("Customer «Al Shifa» and “Dr Mona” and ‘Ali’ are archived"),
    "Customer <str> and <str> and <str> are archived",
    "guillemets and curly quotes mask to <str>, as straight quotes already do",
  );
  assert.equal(
    screenMessageTemplate("Customer “Dr Mona” is archived."),
    screenMessageTemplate('Customer "Dr Ahmed Ali" is archived.'),
    "a curly-quoted name and a straight-quoted one are the same refusal",
  );

  // ── What still keeps two issues apart ───────────────────────────────────────────────────────────
  assert.notEqual(
    userScreenSignature(refusal(notAt("مستشفي السلام"))),
    userScreenSignature(refusal(notAt("مستشفي السلام"), { http_status: 409 })),
    "a 400 and a 409 at the same place stay two issues — the status is its own part of the key",
  );
  assert.notEqual(
    userScreenSignature(refusal(notAt("مستشفي السلام"))),
    userScreenSignature(refusal(fullName("مستشفي السلام"))),
    "two different refusals naming the same place stay two issues",
  );

  // ── A message with no such name keeps the key it already has on production ─────────────────────
  // Three production issues of 17 Nov 2026, keys read from system_audit_issues: an em dash, an
  // apostrophe, and a request that carried no words. Masking may only ever re-key a message that
  // names something in a non-Latin script or in typographic quotes.
  const unchanged: Array<[string, ReturnType<typeof refusal>]> = [
    [
      "screen:v1:15f372e001bfa4da",
      refusal("A test account's login starts with TEST- and then letters or numbers — for example TEST-AYA.", { api_path: "/api/admin/test-accounts", page_path: "/admin/test-accounts" }),
    ],
    [
      "screen:v1:70890bb6ae9ad67a",
      refusal("The stored signature is the system administrator's — only a Super Admin can see or change it.", { api_path: "/api/hiring-pack/signature", page_path: "/hr/hiring-pack", http_status: 403 }),
    ],
    ["screen:v1:12e6746f5a3da33c", refusal(null, { kind: "failed_request", api_path: "/api/messages", page_path: "/employee-portals/field-crm/visits", http_status: null })],
  ];
  for (const [key, screen] of unchanged) {
    assert.equal(userScreenSignature(screen), key, `a message with no name to mask keeps its production key ${key}`);
  }
  // Every character a Latin-only message held on production that day (ASCII, "—", "→"), and the
  // Latin-adjacent letters a dose or a name may carry (µ, é, ª), pass through untouched.
  for (const text of ["Plan saved → 5 µg of Ondansétron, 1ª dose — 'twice' \"daily\" `now`", "Visit 3 of 4 was already validated."]) {
    assert.equal(maskScreenNames(text), text, `masking leaves a message with no non-Latin name as it was: ${text}`);
    assert.equal(userScreenSignature(refusal(text)), keyBefore(refusal(text)), `and its key is the key it had before: ${text}`);
  }

  // ── The crash signature is untouched ────────────────────────────────────────────────────────────
  assert.notEqual(
    appErrorSignatureV1(row({ message: `Error: ${notAt("مستشفي السلام")}` })).key,
    appErrorSignatureV1(row({ message: `Error: ${notAt("شركة")}` })).key,
    "app_error keys never mask names — no crash's signature moves with this change",
  );
  assert.ok(messageTemplate(notAt("شركة")).includes("شركة"), "messageTemplate without the option masks no name");
}
