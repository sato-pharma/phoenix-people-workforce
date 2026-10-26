import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isDevPreviewReplay } from "../src/lib/auth/dev-preview.ts";
import { devRelativeRedirect } from "../src/lib/auth/dev-redirect.ts";
import { stripComments } from "./support/comment-strip.ts";

// Regression guard for "Launch preview on /admin/dev-preview landed on a raw {"error":"forbidden"}".
//
// On 2026-09-21 the Super Admin launched a Medical Rep preview twice and got the 403 both times. The
// dev-server log showed the same trace in both runs: preview 307, dev-auth 307, "Compiling
// /employee-portals" (30 to 60 seconds here), then the SAME preview address again, answered 403. The
// launch's first two hops replace the caller — the preview route deletes the real session and
// dev-auth sets the preview cookie — so a second click or a reload during the slow first compile
// reached the Super Admin gate as the Medical Rep it had just minted. Two fixes, both pinned here:
//   1. /api/dev-auth/preview answers a replay of the preview the caller is already in with that
//      preview's landing page, and it mints nothing to do so.
//   2. The picker locks its Launch button after the first click.
//
// And the switch is a same-origin POST (audit point 17, owner-approved 2026-10-26). As a GET it
// revoked the Super Admin's real session and wrote an audit row on any request that reached it — a
// link, a prefetch, an `<img src>` on another local page. Now the picker submits a
// `<form method="post">`, the route exports POST only, refuses a cross-site request before it reads
// anything, and answers every hop with a 303 so the browser's next request is a plain GET.
export async function runDevPreviewLaunchReplayTests() {
  const rep = { hrId: "CN-0006", role: "Medical Rep" as const };

  assert.equal(isDevPreviewReplay(rep, rep), true, "the launch the preview came from is a replay");
  assert.equal(
    isDevPreviewReplay({ hrId: "cn-0006", role: "Medical Rep" }, { hrId: "CN0006", role: "Medical Rep" }),
    true,
    "the person key ignores case and punctuation, as the role guard's does",
  );
  assert.equal(
    isDevPreviewReplay(rep, { hrId: "CN-0007", role: "Medical Rep" }),
    false,
    "a different person is not a replay — switching previews still needs the Super Admin",
  );
  assert.equal(
    isDevPreviewReplay(rep, { hrId: "CN-0006", role: "District Manager" }),
    false,
    "the same person under another role is not a replay",
  );
  assert.equal(
    isDevPreviewReplay({ hrId: null, role: "Medical Rep" }, { hrId: "CN-0006", role: "Medical Rep" }),
    false,
    "a role-only preview never matches a named person",
  );
  assert.equal(
    isDevPreviewReplay({ hrId: "", role: "Medical Rep" }, { hrId: " ", role: "Medical Rep" }),
    false,
    "two blank ids are not the same person",
  );

  const route = readFileSync("app/api/dev-auth/preview/route.ts", "utf8");
  const gateAt = route.indexOf('if (access.role !== "Super Admin") {');
  const replayAt = route.indexOf("const replay = await replayLandingUrl(access,");
  const forbiddenAt = route.indexOf('return NextResponse.json({ error: "forbidden" }, { status: 403 });', gateAt);
  assert.ok(gateAt > 0, "the Super Admin gate is still the route's gate");
  assert.ok(replayAt > gateAt && replayAt < forbiddenAt, "a refused caller is checked for a replay before the 403");

  const helperAt = route.indexOf("async function replayLandingUrl(");
  const helper = route.slice(helperAt, route.indexOf("\n}\n", helperAt) + 2);
  assert.ok(helperAt > 0 && helper.trimEnd().endsWith("}"), "the replay helper's body is found whole");
  assert.match(helper, /if \(!isPreviewSession\(access\)\) return null;/, "only a preview session can replay");
  assert.match(helper, /if \(role !== access\.role\) return null;/, "a replay asks for the role the preview already wears");
  assert.match(helper, /isDevPreviewReplay\(access, \{ hrId: candidate\.hrId, role \}\)/, "and for the same person");
  assert.match(helper, /resolveLandingPathForRole\(role\)/, "it goes to the landing page the first launch was heading to");
  for (const minted of ["cookies", "createDevPreviewSessionToken", "revokeAppSession", "writeAuthAudit", "/api/dev-auth"]) {
    assert.ok(!helper.includes(minted), `a replay grants nothing: the replay path never touches ${minted}`);
  }

  // Every dev-auth hop redirects RELATIVELY, or the launch dies on a port the browser cannot reach.
  //
  // `next dev` builds `request.url` from the address it is BOUND to, not from the `Host` header, so
  // `NextResponse.redirect(new URL(path, request.url))` emits an absolute Location on the server's
  // own port. On a laptop that is invisible — bound port and browser port are both 3000. Under
  // `phx-live` the server is bound to 127.0.0.1:3100 on the Hetzner box and the browser reaches it
  // through an SSH tunnel on localhost:3000, so the launch sent the tab to http://localhost:3100/admin
  // where nothing listens: an empty error page, with the real session already revoked by hop one
  // (owner, 2026-10-12 — measured `Location: http://localhost:3100/admin` through the tunnel).
  const devAuthRoute = readFileSync("app/api/dev-auth/route.ts", "utf8");
  for (const [name, source] of [
    ["app/api/dev-auth/preview/route.ts", route],
    ["app/api/dev-auth/route.ts", devAuthRoute],
  ] as const) {
    assert.doesNotMatch(
      source,
      /NextResponse\.redirect\(/,
      `${name} must not use NextResponse.redirect — it emits the SERVER's origin, which is the wrong port whenever the browser reaches the dev server through a tunnel (phx-live).`,
    );
    assert.match(
      source,
      /devRelativeRedirect\(/,
      `${name} must redirect through devRelativeRedirect, whose Location the browser resolves against the origin it actually used.`,
    );
  }
  const devPreviewLib = readFileSync("src/lib/auth/dev-redirect.ts", "utf8");
  assert.match(
    devPreviewLib,
    /headers: \{ Location: `\$\{target\.pathname\}\$\{target\.search\}` \}/,
    "devRelativeRedirect must send path+query only — an origin of any kind reintroduces the wrong port.",
  );

  const picker = readFileSync("src/components/admin/dev-preview-picker.tsx", "utf8");
  assert.match(picker, /if \(launching\) \{\s*event\.preventDefault\(\);/, "a second click on Launch does nothing");
  assert.match(picker, /setLaunching\(true\);/, "the first click locks the button");
  assert.match(picker, /if \(event\.persisted\) setLaunching\(false\);/, "coming back from the page cache unlocks it");
  assert.doesNotMatch(picker, /\brounded(-|\b)/, "the picker has no rounded corner anywhere (square-edge golden rule)");
  const nameField = picker.slice(picker.indexOf('id="dev-preview-name"'), picker.indexOf("</SearchableSelect>", picker.indexOf('id="dev-preview-name"')));
  assert.match(nameField, /\bwrapValue\b/, "the Name field wraps a long value instead of clipping it on a phone");

  await testTheSwitchIsASameOriginPost();
}

async function testTheSwitchIsASameOriginPost() {
  // The redirect helper: a 303 when asked, the 307 default for the GET hop, path+query either way.
  const seeOther = devRelativeRedirect(new URL("http://127.0.0.1:3100/api/dev-auth?role=Medical+Rep"), 303);
  assert.equal(seeOther.status, 303, "the preview switch's redirect is a 303, so the next hop is a GET");
  assert.equal(seeOther.headers.get("location"), "/api/dev-auth?role=Medical+Rep");
  assert.equal(devRelativeRedirect(new URL("http://127.0.0.1:3100/admin")).status, 307, "the GET hop keeps its 307");

  // The route, run: POST only, and a cross-site POST is refused before anything is read.
  const route = (await import("../app/api/dev-auth/preview/route.ts")) as Record<string, unknown>;
  assert.equal(typeof route.POST, "function", "the preview switch answers POST");
  assert.equal(route.GET, undefined, "HEADLINE: the preview switch has no GET — a link or an <img> can never end the real session");

  const env = process.env as Record<string, string | undefined>;
  const savedNodeEnv = env.NODE_ENV;
  const savedFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input instanceof Request ? input.url : input));
    throw new Error("the preview switch must not reach the network in this test");
  }) as typeof fetch;
  try {
    env.NODE_ENV = "development";
    const post = route.POST as (request: Request) => Promise<Response>;
    let crossSite: Response;
    try {
      crossSite = await post(
        new Request("http://127.0.0.1:3000/api/dev-auth/preview", {
          body: new URLSearchParams({ role: "Medical Rep" }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "127.0.0.1:3000",
            origin: "https://attacker.example",
            "x-forwarded-for": "127.0.0.1",
          },
          method: "POST",
        }),
      );
    } catch (error) {
      // A throw is a failure too: only the origin check stands between a cross-site request and the
      // session read, the form read and the audit row.
      assert.fail(`HEADLINE: a cross-site POST is refused before the switch reads the session (${String(error).slice(0, 120)})`);
    }
    assert.equal(crossSite.status, 403, "a cross-site POST to the preview switch is refused");
    assert.equal(((await crossSite.json()) as { error?: string }).error, "csrf_failed", "refused as a cross-site request");
    assert.deepEqual(asked, [], "a refused switch reads no session and writes nothing");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = savedNodeEnv;
  }

  // The source: the origin check runs right after the local-dev gate, every hop is a 303, and the
  // launch fields come from the form body, never the address.
  const source = stripComments(readFileSync("app/api/dev-auth/preview/route.ts", "utf8"));
  const handler = source.slice(source.indexOf("export async function POST("));
  assert.ok(handler.length < source.length, "the route exports a POST handler");
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+GET\b|export\s+const\s+GET\b/, "no GET handler");
  const csrfAt = handler.indexOf("const csrf = assertSameOriginMutation(request);");
  assert.ok(csrfAt > 0, "the switch checks the request's origin in the route");
  for (const later of ["await readLaunchForm(request)", "resolveAccessContext(request)", "revokeAppSession(", "writeAuthAudit("]) {
    assert.ok(handler.indexOf(later) > csrfAt, `the origin check runs before ${later}`);
  }
  assert.ok(source.includes("request.formData()"), "the launch fields are read from the form body");
  assert.doesNotMatch(source, /searchParams\.get\(/, "the launch fields are never read from the address");
  const hops = handler.match(/devRelativeRedirect\([^;]*?\)(?=;)/g) ?? [];
  assert.ok(hops.length >= 3, "the replay, the no-candidate return and the switch all redirect");
  for (const hop of hops) {
    assert.match(hop, /, 303\)$/, `every hop from the POST is a 303: ${hop}`);
  }

  // The picker submits a form; no link to the switch is left in it.
  const picker = stripComments(readFileSync("src/components/admin/dev-preview-picker.tsx", "utf8"));
  assert.match(picker, /<form\s+action="\/api\/dev-auth\/preview"\s+method="post"/, "the picker launches through a POST form");
  assert.match(picker, /<input key=\{name\} name=\{name\} type="hidden" value=\{value\} \/>/, "the launch fields travel as hidden inputs");
  assert.match(picker, /type="submit"/, "Launch is the form's submit button");
  assert.doesNotMatch(picker, /href=\{previewHref\}|\/api\/dev-auth\/preview\?/, "no link to the switch is left in the picker");
  assert.match(picker, /onSubmit=\{\(event\) => \{\s*if \(launching\) \{\s*event\.preventDefault\(\);/, "a second submit is dropped");

  // The registry declares it.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  const entry = registry.split("\n").find((line) => line.includes('pattern: "/api/dev-auth/preview"'));
  assert.ok(entry, "the access registry lists the preview switch");
  assert.match(entry, /methods: \["POST"\]/, "the registry declares the switch as POST only");
  assert.match(entry, /csrfRequired: true/, "the registry declares the switch as CSRF-checked");
}
