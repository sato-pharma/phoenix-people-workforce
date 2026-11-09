/**
 * The Phoenix web app — the "small APK" that force-installs onto a managed tablet.
 *
 * WHAT THIS IS, AND WHY IT IS NOT A HAND-WRITTEN ANDROID APP. Phoenix is a Next.js site, so there
 * is no APK to ship. The Android Management API closes that gap itself: `enterprises.webApps.create`
 * takes a title, a start URL and an icon, and Google builds a real installable application from
 * them, distributes it through managed Google Play, and hands back a package name of the form
 * `com.google.enterprise.webapp.*`. That package goes into a device policy exactly like any Play
 * Store app, which is what makes it FORCE-INSTALLABLE and kiosk-pinnable.
 *
 * The alternative — a Kotlin WebView wrapper — would need a Play Developer account to distribute
 * privately (a one-off fee), a signing key that has to be kept for the life of the app, and its own
 * release path. It buys nothing here: the tablet still renders the same web pages. The owner's
 * constraint on 2026-09-18 was that this cost nothing, and the web-app route is the one that does.
 *
 * 🔴 CHROME IS NOT OPTIONAL. Google's own documentation is explicit that a device must have Google
 * Chrome installed for a web app's display mode to work at all. A policy that force-installs the
 * Phoenix web app and omits `com.android.chrome` produces an icon that opens nothing, on a tablet
 * a medical rep is holding in front of a doctor. `buildForceInstalledApplications` therefore adds
 * Chrome itself rather than trusting a caller to remember, and `phoenixWebAppPolicyIsServiceable`
 * exists so a policy assembled somewhere else can be checked before it is pushed.
 *
 * ON DISPLAY MODE. `STANDALONE` hides the URL bar but keeps the Android status bar and navigation
 * buttons — which is what Phoenix wants, because its own pages carry no back control and a rep with
 * no way back is a support call. `FULL_SCREEN` hides navigation too and is the wrong default here.
 * `MINIMAL_UI` is the only mode an `http://` start URL may use; Phoenix is HTTPS, so the guard in
 * `buildPhoenixWebApp` treats a plain-HTTP start URL as a mistake rather than quietly downgrading.
 *
 * AUTH IS PLUGGABLE, AND THAT IS DELIBERATE — the same decision, for the same reason, as
 * `src/lib/sales/master-map/sheets-client.ts`. The org policy on the owner's Google Cloud org
 * (`constraints/iam.disableServiceAccountKeyCreation`) blocks long-lived service-account keys, so
 * how this authenticates in production is still open: a key, impersonation, or workload identity
 * federation. Everything here is written against `GoogleTokenProvider`, so whichever route is
 * chosen, nothing in this file changes.
 *
 * NOTHING HERE ISSUES A DEVICE COMMAND OR WIPES ANYTHING. This module creates an app and describes
 * how to install it. Lock, wipe and lost mode are a separate concern and belong behind the custody
 * register's own permission gate, not beside the code that builds an icon.
 */

import { systemDeployment, systemIdentity } from "@/config/system-settings";

/** The v1 base. There is one global endpoint — no regional variants to get wrong. */
export const ANDROID_MANAGEMENT_API = "https://androidmanagement.googleapis.com/v1";

/** The single OAuth scope the whole API sits behind. */
export const ANDROID_MANAGEMENT_SCOPE = "https://www.googleapis.com/auth/androidmanagement";

/**
 * Chrome's package name.
 *
 * Pinned as a constant rather than typed at each call site because a typo here does not fail — it
 * produces a policy that installs a web app with no browser to render it, which looks like a broken
 * tablet rather than a broken policy.
 */
export const CHROME_PACKAGE_NAME = "com.android.chrome";

/** Google generates web-app package names in this shape. Used to recognise one, never to mint one. */
export const WEB_APP_PACKAGE_PREFIX = "com.google.enterprise.webapp.";

/** Google's stated ceiling for a web-app icon. */
export const WEB_APP_ICON_MAX_BYTES = 1_048_576;

/** Google's stated icon geometry — square, 512×512. */
export const WEB_APP_ICON_EDGE_PX = 512;

/**
 * `MINIMAL_UI` — URL bar visible. The only mode permitted for an `http://` start URL.
 * `STANDALONE` — URL bar hidden, Android status bar and navigation kept. Phoenix uses this.
 * `FULL_SCREEN` — everything hidden; the site must supply its own navigation.
 */
export type WebAppDisplayMode = "MINIMAL_UI" | "STANDALONE" | "FULL_SCREEN";

export type WebAppIcon = {
  /** 512×512 PNG or JPEG, base64url-encoded (base64 with `+`→`-`, `/`→`_`, padding stripped). */
  imageData: string;
};

/** The request body `enterprises.webApps.create` and `.patch` both take. */
export type WebApp = {
  title: string;
  startUrl: string;
  displayMode: WebAppDisplayMode;
  icons: WebAppIcon[];
  /** Server-assigned on create — `enterprises/{enterpriseId}/webApps/{packageName}`. */
  name?: string;
  /** Server-assigned. Read for the record; never sent. */
  versionCode?: string;
};

export type AndroidManagementConfig = {
  /** `enterprises/LC…` — the binding created once, by hand, when the enterprise is signed up. */
  enterpriseName: string;
};

/** How an application appears in a device policy's `applications[]`. */
export type PolicyApplicationInstallType =
  | "FORCE_INSTALLED"
  | "PREINSTALLED"
  | "BLOCKED"
  | "AVAILABLE"
  | "REQUIRED_FOR_SETUP"
  | "KIOSK";

export type PolicyApplication = {
  packageName: string;
  installType: PolicyApplicationInstallType;
  /** Force-installed work apps are not the rep's to remove. */
  disabled?: boolean;
};

/** A function that returns a bearer token for `ANDROID_MANAGEMENT_SCOPE`. */
export type GoogleTokenProvider = () => Promise<string>;

/**
 * Thrown when the enterprise binding is absent — a SETUP state, not a failure, and it reads as one.
 * Callers map this to 400 with this message rather than 500, exactly as the Action1 routes do.
 */
export class AndroidManagementNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidManagementNotConfiguredError";
  }
}

/** Thrown when Google answered, but not with what was asked for. Carries the status. */
export class AndroidManagementRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AndroidManagementRequestError";
    this.status = status;
  }
}

/** What the signup and its callback answer once Phoenix is already bound to an enterprise. */
export const ENTERPRISE_ALREADY_BOUND_MESSAGE =
  "Phoenix is already bound to the company's Android Enterprise, so a new signup is refused. A second signup would create a second enterprise, owned by whoever finished it, that holds none of the company's tablets.";

export function isAndroidManagementConfigured(): boolean {
  return Boolean(process.env.ANDROID_MANAGEMENT_ENTERPRISE_NAME?.trim());
}

export function androidManagementConfig(): AndroidManagementConfig {
  const enterpriseName = process.env.ANDROID_MANAGEMENT_ENTERPRISE_NAME?.trim();
  if (!enterpriseName) {
    throw new AndroidManagementNotConfiguredError(
      "Phoenix is not bound to an Android Enterprise yet. Create the enterprise once, then set " +
        "ANDROID_MANAGEMENT_ENTERPRISE_NAME to the binding it returns (it looks like " +
        "'enterprises/LC0123456789').",
    );
  }
  if (!enterpriseName.startsWith("enterprises/")) {
    throw new AndroidManagementNotConfiguredError(
      `ANDROID_MANAGEMENT_ENTERPRISE_NAME must be the full binding, starting 'enterprises/' — got '${enterpriseName}'.`,
    );
  }
  return { enterpriseName };
}

// ---------------------------------------------------------------------------------------------
// Building the app
// ---------------------------------------------------------------------------------------------

/**
 * base64url, the encoding Google asks for on `icons[].imageData`.
 *
 * Plain base64 is NOT accepted, and the failure is a 400 rather than a wrong-looking icon, so this
 * is not a cosmetic difference.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Read a PNG's declared dimensions out of its IHDR chunk.
 *
 * Cheap enough to run on every build, and it catches the one mistake that otherwise ships: somebody
 * repoints the icon at a favicon and every tablet in the field gets a 32-pixel smear scaled to a
 * launcher tile. Returns null for anything that is not a PNG — the caller decides what that means,
 * because a JPEG is legal here and simply cannot be measured this way.
 */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  const view = Buffer.from(bytes);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

export type BuildPhoenixWebAppOptions = {
  /** The raw icon file. `app/icon.png` is 512×512 and is what production uses. */
  icon: Uint8Array;
  /** Defaults to the production URL in system settings. */
  startUrl?: string;
  /**
   * Defaults to the BRAND name ("Phoenix"), not the full app name.
   *
   * This is the same choice `public/manifest.json` already made in its `short_name`, and for the
   * same reason: a launcher tile truncates, and "Phoenix Workforce" is what gets truncated.
   */
  title?: string;
  displayMode?: WebAppDisplayMode;
};

/**
 * Assemble the create/patch body, refusing the four things Google would reject or silently accept
 * to the fleet's cost.
 */
export function buildPhoenixWebApp(options: BuildPhoenixWebAppOptions): WebApp {
  const startUrl = (options.startUrl ?? systemDeployment.productionUrl).trim();
  const title = (options.title ?? systemIdentity.brandName).trim();
  const displayMode = options.displayMode ?? "STANDALONE";

  if (!title) {
    throw new Error("A web app needs a title — it is the label under the icon on the rep's tablet.");
  }

  let parsed: URL;
  try {
    parsed = new URL(startUrl);
  } catch {
    throw new Error(`startUrl must be an absolute URL — got '${startUrl}'.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`startUrl must be http or https — got '${parsed.protocol}'.`);
  }
  // Google permits MINIMAL_UI only for an http start URL. Downgrading silently would put a URL bar
  // on every tablet, so this is an error the caller has to mean.
  if (parsed.protocol === "http:" && displayMode !== "MINIMAL_UI") {
    throw new Error(
      `An http:// start URL may only use MINIMAL_UI — '${displayMode}' needs https. Phoenix is ` +
        "https in production; an http URL here is almost always a local address by mistake.",
    );
  }

  if (options.icon.length === 0) {
    throw new Error("A web app needs at least one icon — Google rejects an empty icons list.");
  }
  if (options.icon.length > WEB_APP_ICON_MAX_BYTES) {
    throw new Error(
      `The icon is ${options.icon.length} bytes; Google's ceiling is ${WEB_APP_ICON_MAX_BYTES}.`,
    );
  }
  const dimensions = readPngDimensions(options.icon);
  if (dimensions && (dimensions.width !== WEB_APP_ICON_EDGE_PX || dimensions.height !== WEB_APP_ICON_EDGE_PX)) {
    throw new Error(
      `The icon must be ${WEB_APP_ICON_EDGE_PX}×${WEB_APP_ICON_EDGE_PX} — got ${dimensions.width}×${dimensions.height}.`,
    );
  }

  return {
    displayMode,
    icons: [{ imageData: base64UrlEncode(options.icon) }],
    startUrl,
    title,
  };
}

// ---------------------------------------------------------------------------------------------
// Putting it in a policy
// ---------------------------------------------------------------------------------------------

/**
 * The `applications[]` fragment that force-installs Phoenix on a managed tablet.
 *
 * Chrome is added unconditionally and de-duplicated, so a caller that already listed it gets one
 * entry rather than two. `disabled: false` is stated rather than left to the default because the
 * whole point of a force-installed work app is that the holder cannot turn it off.
 */
export function buildForceInstalledApplications(
  webAppPackageName: string,
  alsoForceInstall: readonly string[] = [],
): PolicyApplication[] {
  const packageName = webAppPackageName.trim();
  if (!packageName) {
    throw new Error("The web app's package name is required — create the web app first.");
  }

  const ordered = [packageName, CHROME_PACKAGE_NAME, ...alsoForceInstall.map((entry) => entry.trim())];
  const seen = new Set<string>();
  const applications: PolicyApplication[] = [];
  for (const entry of ordered) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    applications.push({ disabled: false, installType: "FORCE_INSTALLED", packageName: entry });
  }
  return applications;
}

/**
 * Whether a policy's applications list can actually render the Phoenix web app.
 *
 * Exists for the policy assembled elsewhere — a screen, a migration, a hand-written JSON blob —
 * where nothing forced Chrome in. Returns the reason rather than a bare false, because "it did not
 * work on the tablet" is the most expensive way to discover a missing package name.
 */
export function phoenixWebAppPolicyIsServiceable(
  applications: readonly PolicyApplication[],
  webAppPackageName: string,
): { ok: true } | { ok: false; reason: string } {
  const installed = new Set(
    applications
      .filter((application) => application.installType === "FORCE_INSTALLED" || application.installType === "KIOSK")
      .map((application) => application.packageName),
  );
  if (!installed.has(webAppPackageName)) {
    return { ok: false, reason: `The policy does not install ${webAppPackageName}.` };
  }
  if (!installed.has(CHROME_PACKAGE_NAME)) {
    return {
      ok: false,
      reason:
        `The policy installs ${webAppPackageName} but not ${CHROME_PACKAGE_NAME}. A web app needs ` +
        "Chrome present to honour its display mode — without it the icon opens nothing.",
    };
  }
  return { ok: true };
}

/** Whether a package name is one of Google's generated web apps. */
export function isWebAppPackageName(packageName: string): boolean {
  return packageName.startsWith(WEB_APP_PACKAGE_PREFIX);
}

/** Pull the package name back out of the server-assigned resource name. */
export function webAppPackageNameFrom(resourceName: string): string | null {
  const match = /\/webApps\/([^/]+)$/.exec(resourceName);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------------------------
// Talking to Google
// ---------------------------------------------------------------------------------------------

/** Long enough for an icon upload, short enough that a wedged call does not hold a request open. */
const ANDROID_MANAGEMENT_TIMEOUT_MS = 30_000;

/**
 * One authenticated call to the Android Management API, parsed.
 *
 * Exported so the tablet policy and enrollment modules share this one implementation of the error
 * shape. 🔴 The error message carries Google's response body and the request path, so no caller may
 * put a credential in `path`: an enrollment token's value travels only in RESPONSE bodies.
 */
export async function callAndroidManagement(
  token: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${ANDROID_MANAGEMENT_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(ANDROID_MANAGEMENT_TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new AndroidManagementRequestError(
      `Android Management API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body}`,
      response.status,
    );
  }
  return body ? (JSON.parse(body) as unknown) : {};
}

/**
 * Create the Phoenix web app, or update it in place when it already exists.
 *
 * `existingPackageName` is what decides between the two — it is stored against the enterprise once
 * and reused forever after, because CREATING A SECOND WEB APP DOES NOT REPLACE THE FIRST. It mints
 * another package name, and a policy still naming the old one keeps installing the old one. The
 * symptom is a fleet that ignores an icon change, which reads as caching.
 *
 * Google's own note: a newly created web app becomes selectable within minutes, but can take up to
 * 24 hours to propagate to every device. Nothing here polls for that — it is not a failure state.
 */
export async function createOrUpdatePhoenixWebApp(
  options: {
    token: string;
    enterpriseName: string;
    webApp: WebApp;
    existingPackageName?: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ packageName: string; resourceName: string; created: boolean }> {
  const { enterpriseName, token, webApp } = options;
  const existing = options.existingPackageName?.trim() || null;

  const payload = await callAndroidManagement(
    token,
    existing ? `/${enterpriseName}/webApps/${existing}` : `/${enterpriseName}/webApps`,
    { body: JSON.stringify(webApp), method: existing ? "PATCH" : "POST" },
    fetchImpl,
  );

  const resourceName = (payload as { name?: string }).name?.trim() ?? "";
  const packageName = resourceName ? webAppPackageNameFrom(resourceName) : null;
  if (!packageName) {
    throw new AndroidManagementRequestError(
      `Google accepted the web app but returned no usable resource name (got '${resourceName}'). ` +
        "Without a package name nothing can force-install it.",
      200,
    );
  }
  return { created: !existing, packageName, resourceName };
}
