import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  assertCallbackUrl,
  createEnterprise,
} from "../src/lib/devices/android-enterprise-signup.ts";
import {
  assertParentFrameUrl,
  buildManagedPlayIframeUrl,
  createManagedPlayWebToken,
  MANAGED_PLAY_IFRAME_URL,
  PHOENIX_IFRAME_FEATURES,
  redactWebToken,
} from "../src/lib/devices/managed-play-iframe.ts";

/**
 * The managed Google Play iframe — the door the Phoenix app reaches the fleet through.
 *
 * WHAT THIS FILE PROVES, and why each of them rather than something else:
 *
 *  1. THE CSP ACTUALLY ALLOWS THE IFRAME. This is the one failure in the whole feature that no
 *     typecheck, no lint and no other test can see: a response header meets a browser, the frame is
 *     refused, and the page renders an empty box with nothing in the repository to point at. The
 *     base policy has NO `frame-src` at all, so framing falls back to `default-src 'self'` and
 *     Google's child frame is blocked outright — the exact shape of the hiring-pack preview bug this
 *     repo has already paid for once. So the config is parsed and the directives asserted, and both
 *     URL spellings are checked because proxy.ts rewrites `/hr` AFTER headers are matched.
 *
 *  2. A WEB TOKEN IS NEVER MINTED FOR AN UNCHECKED PARENT. Google matches the parent frame to stop
 *     the iframe being hosted elsewhere, so a value carrying a query string — which is what an
 *     address copied out of a browser bar looks like — must raise here rather than produce a frame
 *     that silently refuses to render.
 *
 *  3. THE HOMEPAGE CANNOT OUTRUN THE TOKEN. A token minted without `PRIVATE_APPS` but opened on the
 *     private apps page renders blank, with no error anywhere. The cross-check turns the single most
 *     likely misconfiguration into a message instead of an empty rectangle.
 *
 *  4. A 200 WITH NO TOKEN IS A FAILURE. Left alone it becomes `token=undefined` in the iframe URL,
 *     which loads, renders nothing, and sends the reader looking at Google's status page.
 *
 *  5. THE TOKEN NEVER SURVIVES REDACTION. It is a bearer credential for the whole enterprise; any
 *     path that writes the URL into a log or an error goes through `redactWebToken` first.
 *
 *  6. THE SIGNUP'S TWO HALVES ARE BOTH REQUIRED. `enterprises.create` needs the signup URL's name
 *     AND the single-use token from Google's redirect. The name arrives only via a short-lived
 *     cookie, so losing it is the realistic failure — and it must say so, because by then the owner
 *     has already completed an enrolment he cannot repeat without starting over.
 *
 * WHY `fetch` IS INJECTED. There is no network in this suite and there must not be: a real call
 * would need the owner's enterprise binding, and the API's quota is 2 Cloud projects for the whole
 * company.
 */

const nextConfigSource = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

type RecordedCall = { body: unknown; method: string; url: string };

function recordingFetch(
  response: { body: unknown; ok?: boolean; status?: number },
  calls: RecordedCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      url: String(input),
    });
    const text = JSON.stringify(response.body);
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
}

async function rejects(run: () => Promise<unknown>, needle: string, why: string) {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof Error && error.message.includes(needle),
      `${why} — expected a message containing '${needle}', got '${error instanceof Error ? error.message : String(error)}'`,
    );
    return;
  }
  assert.fail(`${why} — it resolved instead of raising.`);
}

export async function runManagedPlayIframeTests() {
  // ── 1. The CSP, which is the only part a browser can veto ───────────────────────────────────
  const managedPlayCspMatch = /const managedPlayCsp = contentSecurityPolicy([\s\S]*?);\n/.exec(
    nextConfigSource,
  );
  assert.ok(
    managedPlayCspMatch,
    "next.config.ts must declare managedPlayCsp — without a widened policy the managed Play iframe is blocked and the page renders an empty box.",
  );
  const managedPlayCsp = managedPlayCspMatch[1];

  assert.ok(
    managedPlayCsp.includes("script-src 'self' https://apis.google.com"),
    "managedPlayCsp must add https://apis.google.com to script-src, or gapi never loads and the iframe is never opened.",
  );
  // The frame-src directive is appended as a double-quoted string, so everything up to the closing
  // quote IS the directive. Matching that whole run rather than a window after `frame-src` matters:
  // the directive opens with `'self'`, and a character class that excluded quotes would never reach
  // the hosts — which is exactly the false failure this assertion produced when it was first written.
  const frameSrcMatch = /frame-src[^"]*/.exec(managedPlayCsp);
  assert.ok(
    frameSrcMatch,
    "managedPlayCsp must declare a frame-src directive — the base policy has none, so framing falls back to default-src 'self' and Google's child frame is refused outright.",
  );
  for (const host of ["https://play.google.com", "https://apis.google.com"]) {
    assert.ok(
      frameSrcMatch[0].includes(host),
      `managedPlayCsp's frame-src must allow ${host} — got '${frameSrcMatch[0]}'. gapi opens a relay frame on apis.google.com as well as the store frame on play.google.com, so both are required.`,
    );
  }
  assert.ok(
    !managedPlayCsp.includes("frame-ancestors"),
    "managedPlayCsp must NOT touch frame-ancestors — this page embeds Google, it does not let anyone embed Phoenix.",
  );

  // Both spellings, because proxy.ts rewrites /hr onto the admin pages after headers are matched.
  for (const source of ["/devices/managed-play", "/hr/devices/managed-play"]) {
    assert.ok(
      nextConfigSource.includes(`source: "${source}"`),
      `next.config.ts must attach managedPlayCsp to ${source}; the /hr spelling is the one the HR seats actually browse.`,
    );
  }

  // ── 2. The parent frame is checked before a credential is minted ────────────────────────────
  assert.equal(
    assertParentFrameUrl("https://phoenix-hr.satopharma.com"),
    "https://phoenix-hr.satopharma.com",
  );
  assert.equal(assertParentFrameUrl("http://localhost:3000"), "http://localhost:3000");
  assert.throws(
    () => assertParentFrameUrl("http://phoenix-hr.satopharma.com"),
    /must be https/,
    "Plain http for a real host must be refused — Google will not frame it and the failure is silent.",
  );
  assert.throws(
    () => assertParentFrameUrl("https://phoenix-hr.satopharma.com/devices?view=managed-play"),
    /no query string or fragment/,
    "A URL copied from the address bar brings a query along, and Google matches the hosting URL exactly.",
  );
  assert.throws(() => assertParentFrameUrl("   "), /required/);

  // ── 3. Minting the token ────────────────────────────────────────────────────────────────────
  const calls: RecordedCall[] = [];
  const token = await createManagedPlayWebToken(
    {
      enterpriseName: "enterprises/LC0123456789",
      parentFrameUrl: "https://phoenix-hr.satopharma.com",
      token: "ya29.test",
    },
    recordingFetch({ body: { name: "enterprises/LC0123456789/webTokens/abc", value: "WT-123" } }, calls),
  );
  assert.equal(token.value, "WT-123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(
    calls[0].url,
    "https://androidmanagement.googleapis.com/v1/enterprises/LC0123456789/webTokens",
  );
  const sent = calls[0].body as { enabledFeatures: string[]; parentFrameUrl: string };
  assert.equal(sent.parentFrameUrl, "https://phoenix-hr.satopharma.com");
  assert.ok(
    sent.enabledFeatures.includes("PRIVATE_APPS"),
    "PRIVATE_APPS is the feature this whole module exists for — it must always be requested.",
  );

  await rejects(
    () =>
      createManagedPlayWebToken(
        {
          enabledFeatures: ["NOT_A_FEATURE" as never],
          enterpriseName: "enterprises/LC0123456789",
          parentFrameUrl: "https://phoenix-hr.satopharma.com",
          token: "ya29.test",
        },
        recordingFetch({ body: {} }, []),
      ),
    "is not a managed Play iframe feature",
    "An unknown feature must be caught here rather than sent for Google to 400",
  );

  await rejects(
    () =>
      createManagedPlayWebToken(
        {
          enterpriseName: "LC0123456789",
          parentFrameUrl: "https://phoenix-hr.satopharma.com",
          token: "ya29.test",
        },
        recordingFetch({ body: {} }, []),
      ),
    "must start 'enterprises/'",
    "A bare enterprise id would build a nonsense path",
  );

  // A 200 carrying no token is the shape that otherwise reaches the browser as token=undefined.
  await rejects(
    () =>
      createManagedPlayWebToken(
        {
          enterpriseName: "enterprises/LC0123456789",
          parentFrameUrl: "https://phoenix-hr.satopharma.com",
          token: "ya29.test",
        },
        recordingFetch({ body: { name: "enterprises/LC0123456789/webTokens/abc" } }, []),
      ),
    "returned no token value",
    "A 200 with no value must fail loudly",
  );

  // ── 4. Building the URL ─────────────────────────────────────────────────────────────────────
  const iframeUrl = new URL(
    buildManagedPlayIframeUrl({
      enabledFeatures: PHOENIX_IFRAME_FEATURES,
      webToken: "WT-123",
    }),
  );
  assert.equal(`${iframeUrl.origin}${iframeUrl.pathname}`, MANAGED_PLAY_IFRAME_URL);
  assert.equal(iframeUrl.searchParams.get("token"), "WT-123");
  assert.equal(
    iframeUrl.searchParams.get("iframehomepage"),
    "PRIVATE_APPS",
    "The default landing page is the private apps page — that is the reason this feature exists.",
  );
  assert.equal(
    iframeUrl.searchParams.get("mode"),
    "SELECT",
    "mode is stated rather than defaulted; the alternative, APPROVE, is deprecated.",
  );
  assert.equal(iframeUrl.searchParams.get("showsearchbox"), null);
  assert.equal(
    new URL(
      buildManagedPlayIframeUrl({ showSearchBox: false, webToken: "WT-123" }),
    ).searchParams.get("showsearchbox"),
    "FALSE",
  );

  assert.throws(
    () =>
      buildManagedPlayIframeUrl({
        enabledFeatures: ["PLAY_SEARCH"],
        homepage: "PRIVATE_APPS",
        webToken: "WT-123",
      }),
    /does not enable it/,
    "Opening on a page the token never enabled renders a blank frame with no error — it must raise here.",
  );
  assert.throws(
    () =>
      buildManagedPlayIframeUrl({ homepage: "MANAGED_CONFIGURATIONS" as never, webToken: "WT-1" }),
    /not a valid iframe homepage/,
    "MANAGED_CONFIGURATIONS is a feature but not a landing page; as a homepage it produces an empty frame.",
  );
  assert.throws(() => buildManagedPlayIframeUrl({ webToken: "  " }), /needs a web token/);

  // ── 5. The token never survives being written down ──────────────────────────────────────────
  const redacted = redactWebToken(iframeUrl.toString());
  assert.ok(
    !redacted.includes("WT-123"),
    "redactWebToken must remove the token — it is a bearer credential for the whole enterprise.",
  );
  assert.ok(redacted.includes("REDACTED"));
  assert.ok(
    redacted.includes("iframehomepage=PRIVATE_APPS"),
    "Redaction must keep everything that makes the URL diagnosable; only the credential goes.",
  );
  assert.equal(redactWebToken("not a url"), "[unparseable managed Play iframe URL]");

  // ── 6. The signup's two halves ──────────────────────────────────────────────────────────────
  assert.equal(
    assertCallbackUrl("https://phoenix-hr.satopharma.com/api/devices/managed-play/callback"),
    "https://phoenix-hr.satopharma.com/api/devices/managed-play/callback",
  );
  assert.throws(
    () => assertCallbackUrl("https://phoenix-hr.satopharma.com/cb?already=here"),
    /no query string or fragment/,
    "Google appends enterpriseToken itself; an existing query makes the result ambiguous.",
  );

  await rejects(
    () =>
      createEnterprise(
        {
          enterpriseToken: "ET-1",
          env: { ANDROID_MANAGEMENT_PROJECT_ID: "phoenix" },
          signupUrlName: "",
          token: "ya29.test",
        },
        recordingFetch({ body: {} }, []),
      ),
    "signup URL name is missing",
    "The name lives in a ten-minute cookie, so losing it is the realistic failure and must say so",
  );

  await rejects(
    () =>
      createEnterprise(
        {
          enterpriseToken: "   ",
          env: { ANDROID_MANAGEMENT_PROJECT_ID: "phoenix" },
          signupUrlName: "signupUrls/C123",
          token: "ya29.test",
        },
        recordingFetch({ body: {} }, []),
      ),
    "carried no enterpriseToken",
    "An enrolment that did not complete must not look like a server fault",
  );

  const signupCalls: RecordedCall[] = [];
  const created = await createEnterprise(
    {
      enterpriseToken: "ET-1",
      env: { ANDROID_MANAGEMENT_PROJECT_ID: "phoenix-cloud" },
      signupUrlName: "signupUrls/C123",
      token: "ya29.test",
    },
    recordingFetch({ body: { name: "enterprises/LC9876543210" } }, signupCalls),
  );
  assert.equal(created.enterpriseName, "enterprises/LC9876543210");
  const createUrl = new URL(signupCalls[0].url);
  assert.equal(createUrl.searchParams.get("projectId"), "phoenix-cloud");
  assert.equal(
    createUrl.searchParams.get("signupUrlName"),
    "signupUrls/C123",
    "enterprises.create needs the signup URL's name as well as the token — that pairing is the whole reason for the cookie.",
  );
  assert.equal(createUrl.searchParams.get("enterpriseToken"), "ET-1");

  await rejects(
    () =>
      createEnterprise(
        {
          enterpriseToken: "ET-1",
          env: { ANDROID_MANAGEMENT_PROJECT_ID: "phoenix" },
          signupUrlName: "signupUrls/C123",
          token: "ya29.test",
        },
        recordingFetch({ body: { name: "something-else" } }, []),
      ),
    "rather than an 'enterprises/",
    "A name that is not a binding cannot configure anything",
  );
}
