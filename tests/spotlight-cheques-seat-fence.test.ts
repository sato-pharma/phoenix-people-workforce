import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DELETE, GET, PUT } from "../app/api/spotlight/cheques/signature/route.ts";
import { POST } from "../app/api/spotlight/cheques/route.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  assertPermission,
  clearPermissionMatrixCache,
  createAccessContext,
  permissionMatrix,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { fencedPageRedirect, isPageFencedForRole } from "../src/lib/auth/seat-page-fences.ts";
import { blankChequeInput } from "../src/lib/spotlight/cheque-request.ts";
import { CHEQUE_SIGNATURE_BUCKET, loadChequeSignatureUri } from "../src/lib/spotlight/cheque-signature.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Award Cheques is the Super Admin's and the CEO's alone, and the Talent Acquisition seat is refused
 * it on the server.
 *
 * She holds `spotlight:export` for a good reason: the owner gave her Spotlight on 2026-10-08, read and
 * print, through the `recognition` function in hr-functions.ts. That is the same key Award Cheques
 * asserts, so with only the sidebar row hiding it she could open the page by its address, build a
 * cheque, and read, replace or remove the CEO's stored signature. The seat fence closes that one page
 * and leaves her Spotlight as it was, and both halves are pinned below.
 *
 * This drives the routes themselves with real dev-header requests, against a stand-in database whose
 * address cannot resolve. The store is proven to go through the stand-in BEFORE any write verb is
 * sent, so even with the fence removed the DELETE below cannot reach the real signature.
 */

const STAND_IN_ORIGIN = "https://cheques-seat-fence.invalid";
const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: STAND_IN_ORIGIN,
  NODE_ENV: "development",
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};
const NOBODY = "PREVIEW-NOBODY";
const SEAT: PhoenixRole = "HR Resourcing";
const PAGE = "/spotlight/cheques";
const STORE_PATH = `/storage/v1/`;
const REFUSAL = "The cheque generator is available to the system administrator and the CEO only.";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/** Runs with the stand-in settings and a recording fetch, and puts the real ones back however it ends. */
async function withStandInDatabase(run: (asked: string[]) => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  Object.assign(env, STAND_IN_SETTINGS);
  clearPermissionMatrixCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = realFetch;
    clearPermissionMatrixCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

function headersFor(role: PhoenixRole): Record<string, string> {
  return {
    host: "localhost:3000",
    origin: "http://localhost:3000",
    "x-phoenix-hr-id": NOBODY,
    "x-phoenix-role": role,
  };
}

function chequeRequest(role: PhoenixRole): Request {
  return new Request("http://localhost:3000/api/spotlight/cheques", {
    body: JSON.stringify({
      cheques: [blankChequeInput({ amount: "1,000", recipientName: "Nobody At All", signed: false })],
      format: "html",
      index: 0,
    }),
    headers: { ...headersFor(role), "content-type": "application/json" },
    method: "POST",
  });
}

function signatureRequest(role: PhoenixRole, method: "GET" | "PUT" | "DELETE"): Request {
  return new Request("http://localhost:3000/api/spotlight/cheques/signature", {
    ...(method === "PUT" ? { body: PNG_BYTES } : {}),
    headers: headersFor(role),
    method,
  });
}

function everyVerb(role: PhoenixRole): ReadonlyArray<readonly [string, () => Promise<Response>]> {
  return [
    ["POST /api/spotlight/cheques", () => POST(chequeRequest(role))],
    ["GET /api/spotlight/cheques/signature", () => GET(signatureRequest(role, "GET"))],
    ["PUT /api/spotlight/cheques/signature", () => PUT(signatureRequest(role, "PUT"))],
    ["DELETE /api/spotlight/cheques/signature", () => DELETE(signatureRequest(role, "DELETE"))],
  ];
}

export async function runSpotlightChequesSeatFenceTests() {
  // ---- the page ----------------------------------------------------------------------------------
  const landing = resolveLandingPathForRole(SEAT);
  assert.equal(fencedPageRedirect(SEAT, PAGE, landing), landing, "HEADLINE: the seat is sent to her landing page from Award Cheques");
  assert.ok(isPageFencedForRole(SEAT, `/hr${PAGE}`), "the /hr address serves the same page and is shut the same way");
  for (const holder of ["Super Admin", "CEO"] as PhoenixRole[]) {
    assert.equal(isPageFencedForRole(holder, PAGE), false, `${holder} keeps Award Cheques`);
  }
  const page = stripComments(readFileSync("app/(admin)/spotlight/cheques/page.tsx", "utf8"));
  const guardAt = page.indexOf(`guardSeatPage(access, "${PAGE}");`);
  assert.ok(guardAt > -1, "the page checks the fence itself: the layout's check does not run on a link followed inside the app");
  assert.ok(guardAt < page.indexOf("loadChequePayees()"), "the check runs before the roster of payees is read");

  // ---- her Spotlight stays exactly as the owner gave it -------------------------------------------
  assert.deepEqual([...(permissionMatrix[SEAT].spotlight ?? [])], ["read", "export"], "the fence takes no grant away from her");
  assert.equal(isPageFencedForRole(SEAT, "/spotlight"), false, "Spotlight itself stays open to her");
  assert.equal(isPageFencedForRole(SEAT, "/hr/spotlight"), false, "and on its /hr address, which is the row her sidebar offers");
  for (const file of [
    "app/(admin)/spotlight/page.tsx",
    "app/api/spotlight/export/route.ts",
    "app/api/spotlight/options/route.ts",
    "app/api/spotlight/preview/route.ts",
  ]) {
    const text = stripComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(text, /assertPageOpenForRole|guardSeatPage/, `${file} is the Spotlight she was given and carries no fence`);
  }

  await withStandInDatabase(async (asked) => {
    // The safety check, and it must come first: the signature store answers through this fetch, at this
    // address. Were it to go anywhere else, the run stops here, before a single write verb is sent.
    await loadChequeSignatureUri();
    const storeReads = asked.filter((url) => url.includes(`${STORE_PATH}object/${CHEQUE_SIGNATURE_BUCKET}`));
    assert.ok(
      storeReads.length > 0 && storeReads.every((url) => url.startsWith(STAND_IN_ORIGIN)),
      `the signature store goes through the stand-in, so no verb below can reach the real one (asked: ${asked.join(", ") || "nothing"})`,
    );

    await assertPermission(createAccessContext({ hrId: NOBODY, role: SEAT, source: "dev-header" }), "spotlight", "export");

    // ---- the seat is refused on every verb, by the fence ------------------------------------------
    for (const [name, call] of everyVerb(SEAT)) {
      asked.length = 0;
      const response = await call();
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      assert.equal(response.status, 403, `HEADLINE: ${name} refuses the Talent Acquisition seat`);
      assert.equal(body?.error, REFUSAL, `${name} is refused by the route's own gate, not by the origin check`);
      assert.deepEqual(
        asked.filter((url) => url.includes(STORE_PATH)),
        [],
        `${name} never touches the signature store for her`,
      );
    }

    // ---- the two holders still pass, so the refusal above is the fence and not this test's setup ----
    for (const holder of ["CEO", "Super Admin"] as PhoenixRole[]) {
      for (const [name, call] of everyVerb(holder)) {
        const response = await call();
        assert.equal(response.status, 200, `${holder} still reaches ${name}`);
      }
    }
  });
}
