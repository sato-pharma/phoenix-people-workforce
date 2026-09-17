import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  base64UrlEncode,
  buildForceInstalledApplications,
  buildPhoenixWebApp,
  CHROME_PACKAGE_NAME,
  createOrUpdatePhoenixWebApp,
  isWebAppPackageName,
  phoenixWebAppPolicyIsServiceable,
  readPngDimensions,
  WEB_APP_ICON_EDGE_PX,
  webAppPackageNameFrom,
} from "../src/lib/devices/android-web-app.ts";
import type { PolicyApplication } from "../src/lib/devices/android-web-app.ts";

/**
 * The Phoenix web app — the force-installable "APK" for the managed medical-rep tablets.
 *
 * WHAT THIS FILE PROVES, and why each of them rather than something else:
 *
 *  1. CHROME IS ALWAYS IN THE POLICY. Google requires Chrome on the device for a web app to honour
 *     its display mode. Omit it and the tablet still installs a Phoenix icon — which opens nothing.
 *     That failure is invisible from the console: the policy applies, the app reports installed, and
 *     the defect only appears in a rep's hands in front of a doctor. It is the single highest-cost
 *     mistake available in this module, so it is pinned from both ends — the builder always adds
 *     Chrome, and `phoenixWebAppPolicyIsServiceable` refuses a policy that lost it.
 *
 *  2. THE REAL ICON IS CHECKED, NOT A FIXTURE. `app/icon.png` is what production ships to Google,
 *     and a 512×512 requirement asserted only against a hand-made buffer proves nothing about the
 *     file that actually travels. This is the repo's own rule: verify the emitted artifact, never
 *     the source. A favicon swapped in here would otherwise reach every tablet as a smear.
 *
 *  3. CREATE VERSUS UPDATE PICKS THE RIGHT VERB. Creating a second web app does not replace the
 *     first — it mints a second package name, and a policy still naming the old one keeps installing
 *     the old one forever. The symptom is a fleet that ignores an icon or title change, which reads
 *     as caching and gets debugged in the wrong place. The package name decides POST versus PATCH,
 *     so that decision is pinned rather than trusted.
 *
 *  4. THE DISPLAY-MODE / SCHEME RULE. Google permits MINIMAL_UI alone for an `http://` start URL.
 *     Silently downgrading STANDALONE to MINIMAL_UI would put a URL bar on every tablet in the
 *     field, so the module raises instead — and an http URL here is nearly always a localhost
 *     address that escaped into a config.
 *
 * WHY `fetch` IS INJECTED. There is no network in this suite and there must not be: a real call
 * would need the owner's enterprise binding, and the API's own quota is 2 Cloud projects for the
 * whole company. The injected fetch records the method and path, which is exactly the surface
 * points 3 and 4 depend on.
 */

const ICON_PATH = "app/icon.png";

/** A minimal, structurally valid PNG header with the dimensions written into IHDR. */
function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const GOOD_ICON = pngWithDimensions(WEB_APP_ICON_EDGE_PX, WEB_APP_ICON_EDGE_PX);

type RecordedCall = { method: string; url: string; body: unknown };

function recordingFetch(
  response: unknown,
  calls: RecordedCall[],
  status = 200,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      method: init?.method ?? "GET",
      url: String(url),
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
    } as Response;
  }) as unknown as typeof fetch;
}

export async function runAndroidWebAppTests(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // 1. Chrome is never absent
  // -------------------------------------------------------------------------------------------
  const applications = buildForceInstalledApplications("com.google.enterprise.webapp.phoenix");
  const packageNames = applications.map((application) => application.packageName);

  assert.ok(
    packageNames.includes(CHROME_PACKAGE_NAME),
    "THE HEADLINE ASSERTION: a force-install policy for a web app MUST carry Chrome. Without it "
      + "the tablet installs a Phoenix icon that opens nothing, and the console reports success.",
  );
  assert.ok(
    packageNames.includes("com.google.enterprise.webapp.phoenix"),
    "the web app itself must be in the list it was built for",
  );
  assert.ok(
    applications.every((application) => application.installType === "FORCE_INSTALLED"),
    "every entry is FORCE_INSTALLED — an AVAILABLE work app is one a rep can decline",
  );
  assert.ok(
    applications.every((application) => application.disabled === false),
    "a force-installed work app is stated as enabled; the holder does not get to turn it off",
  );

  // A caller who already listed Chrome gets ONE entry, not two — a duplicate package name is a
  // policy Google rejects, which would block the whole fleet rather than just Chrome.
  const withChromeAlready = buildForceInstalledApplications("com.google.enterprise.webapp.phoenix", [
    CHROME_PACKAGE_NAME,
    "com.sato.crm",
  ]);
  const chromeEntries = withChromeAlready.filter((entry) => entry.packageName === CHROME_PACKAGE_NAME);
  assert.equal(chromeEntries.length, 1, "Chrome is de-duplicated, never listed twice");
  assert.ok(
    withChromeAlready.some((entry) => entry.packageName === "com.sato.crm"),
    "extra packages the caller asked for survive de-duplication",
  );

  assert.throws(
    () => buildForceInstalledApplications("   "),
    /package name is required/i,
    "an empty package name is refused — it would silently install Chrome alone",
  );

  // -------------------------------------------------------------------------------------------
  // 2. A policy assembled elsewhere is checked, and the reason is returned
  // -------------------------------------------------------------------------------------------
  const servingPolicy: PolicyApplication[] = [
    { disabled: false, installType: "FORCE_INSTALLED", packageName: "com.google.enterprise.webapp.phoenix" },
    { disabled: false, installType: "FORCE_INSTALLED", packageName: CHROME_PACKAGE_NAME },
  ];
  assert.deepEqual(
    phoenixWebAppPolicyIsServiceable(servingPolicy, "com.google.enterprise.webapp.phoenix"),
    { ok: true },
    "a policy carrying both the web app and Chrome is serviceable",
  );

  const chromeless = phoenixWebAppPolicyIsServiceable(
    [{ disabled: false, installType: "FORCE_INSTALLED", packageName: "com.google.enterprise.webapp.phoenix" }],
    "com.google.enterprise.webapp.phoenix",
  );
  assert.equal(chromeless.ok, false, "a policy without Chrome is NOT serviceable");
  assert.match(
    chromeless.ok === false ? chromeless.reason : "",
    /chrome/i,
    "the refusal names Chrome, so the fix is obvious without reading this module",
  );

  const appless = phoenixWebAppPolicyIsServiceable(
    [{ disabled: false, installType: "FORCE_INSTALLED", packageName: CHROME_PACKAGE_NAME }],
    "com.google.enterprise.webapp.phoenix",
  );
  assert.equal(appless.ok, false, "Chrome alone does not make a policy serviceable");

  // A KIOSK-pinned web app counts as installed — kiosk is how the locked-down tablet will run.
  assert.deepEqual(
    phoenixWebAppPolicyIsServiceable(
      [
        { installType: "KIOSK", packageName: "com.google.enterprise.webapp.phoenix" },
        { installType: "FORCE_INSTALLED", packageName: CHROME_PACKAGE_NAME },
      ],
      "com.google.enterprise.webapp.phoenix",
    ),
    { ok: true },
    "KIOSK install type counts as installed",
  );

  // -------------------------------------------------------------------------------------------
  // 3. base64url, not base64
  // -------------------------------------------------------------------------------------------
  const encoded = base64UrlEncode(Uint8Array.from([251, 255, 254, 253, 0, 1]));
  assert.ok(!encoded.includes("+"), "base64url replaces '+' — plain base64 is rejected with a 400");
  assert.ok(!encoded.includes("/"), "base64url replaces '/'");
  assert.ok(!encoded.includes("="), "base64url strips padding");

  // -------------------------------------------------------------------------------------------
  // 4. The icon rules, including the file production actually ships
  // -------------------------------------------------------------------------------------------
  const realIcon = readFileSync(ICON_PATH);
  const realDimensions = readPngDimensions(realIcon);
  assert.ok(realDimensions, `${ICON_PATH} must be a PNG — it is what travels to Google`);
  assert.equal(
    realDimensions?.width,
    WEB_APP_ICON_EDGE_PX,
    `${ICON_PATH} must be ${WEB_APP_ICON_EDGE_PX}px wide — a smaller icon reaches every tablet scaled up`,
  );
  assert.equal(realDimensions?.height, WEB_APP_ICON_EDGE_PX, `${ICON_PATH} must be square`);

  const fromRealIcon = buildPhoenixWebApp({ icon: realIcon });
  assert.equal(fromRealIcon.displayMode, "STANDALONE", "Phoenix hides the URL bar but keeps Android navigation");
  assert.equal(fromRealIcon.icons.length, 1, "exactly one icon is sent");
  assert.ok(fromRealIcon.icons[0].imageData.length > 0, "the icon is encoded, not empty");
  assert.ok(
    fromRealIcon.startUrl.startsWith("https://"),
    "the production start URL is https — MINIMAL_UI is the only mode http may use",
  );

  assert.throws(
    () => buildPhoenixWebApp({ icon: pngWithDimensions(32, 32) }),
    /512×512/,
    "a favicon-sized icon is refused rather than shipped to the fleet",
  );
  assert.throws(
    () => buildPhoenixWebApp({ icon: Uint8Array.from([]) }),
    /at least one icon/i,
    "Google rejects an empty icons list, so this is caught here",
  );

  // -------------------------------------------------------------------------------------------
  // 5. The display-mode / scheme rule
  // -------------------------------------------------------------------------------------------
  assert.throws(
    () => buildPhoenixWebApp({ icon: GOOD_ICON, startUrl: "http://localhost:3000" }),
    /MINIMAL_UI/,
    "an http start URL with STANDALONE is refused — silently downgrading would put a URL bar on every tablet",
  );
  assert.doesNotThrow(
    () => buildPhoenixWebApp({ displayMode: "MINIMAL_UI", icon: GOOD_ICON, startUrl: "http://localhost:3000" }),
    "http IS legal when the caller means MINIMAL_UI",
  );
  assert.throws(
    () => buildPhoenixWebApp({ icon: GOOD_ICON, startUrl: "/hr/devices" }),
    /absolute URL/,
    "a relative start URL is refused — the tablet has no origin to resolve it against",
  );

  // -------------------------------------------------------------------------------------------
  // 6. Create versus update
  // -------------------------------------------------------------------------------------------
  const created: RecordedCall[] = [];
  const createResult = await createOrUpdatePhoenixWebApp(
    {
      enterpriseName: "enterprises/LC0123456789",
      token: "test-token",
      webApp: buildPhoenixWebApp({ icon: GOOD_ICON }),
    },
    recordingFetch({ name: "enterprises/LC0123456789/webApps/com.google.enterprise.webapp.abc123" }, created),
  );
  assert.equal(created.length, 1, "one call per create");
  assert.equal(created[0].method, "POST", "no existing package name means CREATE");
  assert.ok(created[0].url.endsWith("/enterprises/LC0123456789/webApps"), "create posts to the collection");
  assert.equal(createResult.created, true, "the result says it was created");
  assert.equal(
    createResult.packageName,
    "com.google.enterprise.webapp.abc123",
    "the package name is parsed out of the server-assigned resource name",
  );

  const updated: RecordedCall[] = [];
  const updateResult = await createOrUpdatePhoenixWebApp(
    {
      enterpriseName: "enterprises/LC0123456789",
      existingPackageName: "com.google.enterprise.webapp.abc123",
      token: "test-token",
      webApp: buildPhoenixWebApp({ icon: GOOD_ICON, title: "Phoenix HR" }),
    },
    recordingFetch({ name: "enterprises/LC0123456789/webApps/com.google.enterprise.webapp.abc123" }, updated),
  );
  assert.equal(
    updated[0].method,
    "PATCH",
    "AN EXISTING PACKAGE NAME MUST PATCH. A second create mints a SECOND package, and a policy "
      + "naming the first keeps installing the first — a fleet that ignores every change since.",
  );
  assert.ok(
    updated[0].url.endsWith("/webApps/com.google.enterprise.webapp.abc123"),
    "the patch addresses the existing web app by package name",
  );
  assert.equal(updateResult.created, false, "the result says it was updated, not created");

  // A 200 that carries no usable name is a failure, not a success — nothing could force-install it.
  await assert.rejects(
    createOrUpdatePhoenixWebApp(
      {
        enterpriseName: "enterprises/LC0123456789",
        token: "test-token",
        webApp: buildPhoenixWebApp({ icon: GOOD_ICON }),
      },
      recordingFetch({ name: "" }, []),
    ),
    /no usable resource name/,
    "an accepted call that returns no package name is surfaced rather than treated as done",
  );

  // -------------------------------------------------------------------------------------------
  // 7. Recognising a generated package
  // -------------------------------------------------------------------------------------------
  assert.equal(isWebAppPackageName("com.google.enterprise.webapp.abc123"), true);
  assert.equal(isWebAppPackageName(CHROME_PACKAGE_NAME), false, "Chrome is a real app, not a web app");
  assert.equal(
    webAppPackageNameFrom("enterprises/LC0123456789/webApps/com.google.enterprise.webapp.abc123"),
    "com.google.enterprise.webapp.abc123",
  );
  assert.equal(webAppPackageNameFrom("enterprises/LC0123456789"), null, "a non-web-app name yields null");
}
