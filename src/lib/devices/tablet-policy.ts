/**
 * The rep tablet policy — the rules every company tablet enrolled from Phoenix follows.
 *
 * ONE POLICY, OWNED WHOLE BY PHOENIX. Every rep tablet is enrolled onto `rep-tablet`, and Phoenix
 * writes that policy in full on every save: `policies.patch` with no update mask replaces every
 * modifiable field. That is deliberate. A partial update would leave behind whatever an earlier
 * save or another tool set, and the page could no longer say truthfully what a tablet is made to
 * do. So the baseline is fixed in code, the only thing the Super Admin edits is the app list, and
 * both are pushed together every time.
 *
 * GOOGLE'S COPY IS THE SOURCE OF TRUTH FOR THE APP LIST. Phoenix keeps no table of its own: the
 * apps the owner added are read back out of the live policy before each change, so there is one
 * list, held where the tablets read it from, and no second copy to drift away from it.
 *
 * WHAT THE BASELINE DOES, AND WHY EACH LINE IS THERE — `REP_TABLET_RULES` below is the same list in
 * the words the page shows, and the two are kept side by side on purpose.
 *
 * WHAT IT DELIBERATELY DOES NOT SET:
 * - `modifyAccountsDisabled` — a rep may need to add a work email account on the tablet.
 * - `addUserDisabled` — Google ignores it on a fully managed tablet; setting it would only mislead.
 * - `installUnknownSourcesAllowed` / `debuggingFeaturesAllowed` — deprecated; `advancedSecurityOverrides`
 *   is what Google honours now, and a deprecated field beside it reads as a second rule.
 * - application reports, memory, power and hardware status — Phoenix does not need to know which
 *   apps a rep opens, so it does not ask.
 * - kiosk mode — there is no Phoenix app package yet (publishing one is the owner's own one-way
 *   step), so reps reach Phoenix in Chrome, and a kiosk would lock them into nothing.
 *
 * NOTHING HERE LOCKS, WIPES OR LOCATES A TABLET. Device commands are a separate concern.
 */

import {
  AndroidManagementRequestError,
  CHROME_PACKAGE_NAME,
  callAndroidManagement,
} from "@/lib/devices/android-web-app";

/** The one policy every rep tablet is enrolled onto. Short, lower-case, and never renamed. */
export const REP_TABLET_POLICY_ID = "rep-tablet";

/** Google's ceiling on `applications[]` in one policy. */
export const POLICY_APPLICATIONS_LIMIT = 3_000;

/**
 * The daily window, in the tablet's own local time, when system and app updates may install.
 *
 * Night-time, because WINDOWED is the one update mode that never restarts a tablet in front of a
 * doctor, and because it holds Chrome's own updates to the same window. A tablet that is switched
 * off overnight simply catches the next window.
 */
export const UPDATE_WINDOW = { endMinutes: 300, startMinutes: 120 } as const;

/**
 * The Android permissions Chrome holds from the moment it is installed.
 *
 * Phoenix runs in Chrome, and it needs the location for a check-in and the camera for a live photo
 * or an invoice. Granting them to Chrome in the policy means the rep is never asked "Allow Chrome to
 * access this device's location?" in front of a customer. Each website still asks once for its own
 * permission inside Chrome — that prompt is Chrome's, and no policy removes it. Google honours these
 * grants on a fully managed tablet from Android 12, which every Lenovo Tab M11 ships above.
 */
export const CHROME_PERMISSION_GRANTS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.CAMERA",
] as const;

/** How an app the owner adds reaches the tablets. */
export type OwnerAppInstallType = "FORCE_INSTALLED" | "AVAILABLE";

export const OWNER_APP_INSTALL_TYPES: readonly { value: OwnerAppInstallType; label: string }[] = [
  { label: "Installed on every tablet", value: "FORCE_INSTALLED" },
  { label: "In the tablet's store, rep's choice", value: "AVAILABLE" },
];

export function isOwnerAppInstallType(value: unknown): value is OwnerAppInstallType {
  return value === "FORCE_INSTALLED" || value === "AVAILABLE";
}

export type OwnerApp = {
  packageName: string;
  installType: OwnerAppInstallType;
};

export type PermissionGrant = {
  permission: string;
  policy: "GRANT" | "DENY" | "PROMPT";
};

export type TabletPolicyApplication = {
  packageName: string;
  installType: string;
  permissionGrants?: PermissionGrant[];
};

/** The request body `policies.patch` takes. Every field Phoenix manages, and nothing else. */
export type RepTabletPolicy = {
  applications: TabletPolicyApplication[];
  playStoreMode: "WHITELIST";
  advancedSecurityOverrides: {
    untrustedAppsPolicy: "DISALLOW_INSTALL";
    developerSettings: "DEVELOPER_SETTINGS_DISABLED";
    googlePlayProtectVerifyApps: "VERIFY_APPS_ENFORCED";
  };
  factoryResetDisabled: true;
  locationMode: "LOCATION_ENFORCED";
  passwordPolicies: Array<{ passwordQuality: "SOMETHING"; passwordScope: "SCOPE_DEVICE" }>;
  systemUpdate: { type: "WINDOWED"; startMinutes: number; endMinutes: number };
  statusReportingSettings: { softwareInfoEnabled: true; networkInfoEnabled: true };
};

/**
 * The policy as Google stores it: whatever was pushed, plus `name` and a read-only `version`.
 *
 * Typed loosely on purpose. It is read back from the network, and anything in it may have been set
 * by a tool other than Phoenix — which is exactly what `policyDrift` exists to notice.
 */
export type LivePolicy = Record<string, unknown> & {
  name?: string;
  version?: string;
  applications?: unknown;
};

/** A mistake in what the Super Admin typed — answered 400 with this message, never 500. */
export class TabletPolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabletPolicyInputError";
  }
}

export function repTabletPolicyName(enterpriseName: string): string {
  const enterprise = enterpriseName.trim();
  if (!/^enterprises\/[A-Za-z0-9_-]+$/.test(enterprise)) {
    throw new Error(`The enterprise binding must look like 'enterprises/LC0123456789' — got '${enterprise}'.`);
  }
  return `${enterprise}/policies/${REP_TABLET_POLICY_ID}`;
}

// ---------------------------------------------------------------------------------------------
// The app list
// ---------------------------------------------------------------------------------------------

/** Java package-name shape: two or more dot-separated segments, each starting with a letter. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function isAndroidPackageName(value: string): boolean {
  return value.length <= 255 && PACKAGE_NAME.test(value);
}

/**
 * Accept what the Super Admin is most likely to paste — a Google Play link — or a bare package name.
 *
 * `https://play.google.com/store/apps/details?id=com.whatsapp&hl=en` and `market://details?id=…`
 * both carry the package in `id`. Anything else that looks like a link is refused rather than
 * guessed at: a policy entry naming the wrong package installs the wrong app on every tablet.
 */
export function parsePlayStorePackageName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TabletPolicyInputError("Paste the app's Google Play link, or its package name.");
  }

  let candidate = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new TabletPolicyInputError(`'${trimmed}' is not a link that can be read.`);
    }
    const isPlayLink =
      url.protocol === "market:" ||
      ((url.protocol === "https:" || url.protocol === "http:") && url.hostname === "play.google.com");
    if (!isPlayLink) {
      throw new TabletPolicyInputError(
        "That is not a Google Play link. Open the app on play.google.com and copy the address from there.",
      );
    }
    const id = url.searchParams.get("id")?.trim();
    if (!id) {
      throw new TabletPolicyInputError(
        "That Google Play link names no app — an app's link ends in ?id= followed by its package name.",
      );
    }
    candidate = id;
  }

  if (!isAndroidPackageName(candidate)) {
    throw new TabletPolicyInputError(
      `'${candidate}' is not an Android package name. It looks like com.company.app — letters, digits and dots.`,
    );
  }
  return candidate;
}

/**
 * The apps the owner added, read back out of the live policy.
 *
 * Chrome is left out because it is part of the baseline, not the owner's list. An entry with any
 * other install type was not written by Phoenix, so it is not the owner's list either; it is left
 * for `policyDrift` to report, which is where a stranger in the policy belongs.
 */
export function ownerAppsFromPolicy(live: LivePolicy | null): OwnerApp[] {
  const entries = Array.isArray(live?.applications) ? (live.applications as unknown[]) : [];
  const apps: OwnerApp[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { installType, packageName } = entry as { installType?: unknown; packageName?: unknown };
    if (typeof packageName !== "string" || packageName === CHROME_PACKAGE_NAME || seen.has(packageName)) continue;
    // An absent install type is Google's INSTALL_TYPE_UNSPECIFIED, which it treats as AVAILABLE.
    const type = installType === undefined ? "AVAILABLE" : installType;
    if (!isOwnerAppInstallType(type)) continue;
    seen.add(packageName);
    apps.push({ installType: type, packageName });
  }
  return apps;
}

/** Add an app, or change how an app already on the list is installed. */
export function withOwnerApp(apps: readonly OwnerApp[], app: OwnerApp): OwnerApp[] {
  if (app.packageName === CHROME_PACKAGE_NAME) {
    throw new TabletPolicyInputError(
      "Chrome is already on every tablet — it is part of the baseline, because Phoenix runs in it.",
    );
  }
  if (!isAndroidPackageName(app.packageName)) {
    throw new TabletPolicyInputError(`'${app.packageName}' is not an Android package name.`);
  }
  if (!isOwnerAppInstallType(app.installType)) {
    throw new TabletPolicyInputError("Choose whether the app is installed on every tablet or offered in the store.");
  }
  const existing = apps.findIndex((entry) => entry.packageName === app.packageName);
  if (existing === -1) return [...apps, app];
  return apps.map((entry, index) => (index === existing ? app : entry));
}

export function withoutOwnerApp(apps: readonly OwnerApp[], packageName: string): OwnerApp[] {
  if (!apps.some((entry) => entry.packageName === packageName)) {
    throw new TabletPolicyInputError(`${packageName} is not on the tablets' app list.`);
  }
  return apps.filter((entry) => entry.packageName !== packageName);
}

// ---------------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------------

export function buildRepTabletPolicy(ownerApps: readonly OwnerApp[]): RepTabletPolicy {
  const applications: TabletPolicyApplication[] = [
    {
      installType: "FORCE_INSTALLED",
      packageName: CHROME_PACKAGE_NAME,
      permissionGrants: CHROME_PERMISSION_GRANTS.map((permission) => ({ permission, policy: "GRANT" })),
    },
  ];
  const seen = new Set<string>([CHROME_PACKAGE_NAME]);
  for (const app of ownerApps) {
    if (!isAndroidPackageName(app.packageName)) {
      throw new TabletPolicyInputError(`'${app.packageName}' is not an Android package name.`);
    }
    if (!isOwnerAppInstallType(app.installType)) {
      throw new TabletPolicyInputError(`${app.packageName} has no valid install type.`);
    }
    if (seen.has(app.packageName)) continue;
    seen.add(app.packageName);
    applications.push({ installType: app.installType, packageName: app.packageName });
  }
  if (applications.length > POLICY_APPLICATIONS_LIMIT) {
    throw new TabletPolicyInputError(
      `A tablet policy holds at most ${POLICY_APPLICATIONS_LIMIT} apps — this one would hold ${applications.length}.`,
    );
  }

  return {
    advancedSecurityOverrides: {
      developerSettings: "DEVELOPER_SETTINGS_DISABLED",
      googlePlayProtectVerifyApps: "VERIFY_APPS_ENFORCED",
      untrustedAppsPolicy: "DISALLOW_INSTALL",
    },
    applications,
    factoryResetDisabled: true,
    locationMode: "LOCATION_ENFORCED",
    passwordPolicies: [{ passwordQuality: "SOMETHING", passwordScope: "SCOPE_DEVICE" }],
    playStoreMode: "WHITELIST",
    statusReportingSettings: { networkInfoEnabled: true, softwareInfoEnabled: true },
    systemUpdate: { endMinutes: UPDATE_WINDOW.endMinutes, startMinutes: UPDATE_WINDOW.startMinutes, type: "WINDOWED" },
  };
}

export type PolicyRule = { title: string; detail: string };

/** The baseline in the words the page shows. Keep in step with `buildRepTabletPolicy`. */
export const REP_TABLET_RULES: readonly PolicyRule[] = [
  {
    detail:
      "Phoenix runs in Chrome, so Chrome is installed on every tablet, cannot be removed, and already holds the location and camera permissions Phoenix needs.",
    title: "Chrome is always there",
  },
  {
    detail:
      "The tablet's Play Store offers only the apps listed on this page, and any other app is removed automatically. The tablet's own built-in apps, the camera among them, stay.",
    title: "Only approved apps",
  },
  {
    detail:
      "Apps from outside Google Play cannot be installed, Google Play Protect checks every app, and developer options stay off.",
    title: "No side-loaded apps",
  },
  {
    detail: "The rep cannot factory-reset the tablet from Settings, so it cannot quietly leave the company's control.",
    title: "No reset from Settings",
  },
  {
    detail: "Location stays switched on, so a check-in always has a position to record.",
    title: "Location always on",
  },
  {
    detail: "The tablet must have a screen lock — a PIN, a pattern or a password — before it can be used.",
    title: "Screen lock required",
  },
  {
    detail:
      "Android and app updates install only between 2:00 and 5:00 at night on the tablet's own clock, never during a visit.",
    title: "Updates overnight",
  },
  {
    detail:
      "The tablet reports its model, serial number, Android version, security patch and network identity. It does not report which apps are used or where it is.",
    title: "What the tablet reports",
  },
];

// ---------------------------------------------------------------------------------------------
// Comparing Google's copy with the baseline
// ---------------------------------------------------------------------------------------------

/**
 * Proto3 JSON drops default values — `false`, `0`, empty lists, `*_UNSPECIFIED` enums — from what
 * Google sends back, so a field Phoenix set to `false` comes back ABSENT. Comparing raw JSON would
 * call that a difference forever. Both sides are stripped of defaults, and lists are put in a stable
 * order, before they are compared.
 */
function normalizeForCompare(value: unknown): unknown {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return undefined;
  if (typeof value === "string" && value.endsWith("_UNSPECIFIED")) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(normalizeForCompare).filter((item) => item !== undefined);
    if (items.length === 0) return undefined;
    return items
      .map((item) => ({ item, key: JSON.stringify(item) }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map(({ item }) => item);
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, normalizeForCompare((value as Record<string, unknown>)[key])] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
}

/** Fields Google writes itself, never part of what Phoenix pushes. */
const SERVER_FIELDS = new Set(["name", "version"]);

/**
 * The top-level settings where Google's copy is not what Phoenix would push, as setting names.
 *
 * Empty when they agree, or when there is no copy on Google yet (that case has its own message).
 */
export function policyDrift(live: LivePolicy | null, expected: RepTabletPolicy): string[] {
  if (!live) return [];
  const keys = new Set<string>([...Object.keys(live), ...Object.keys(expected)]);
  const differing: string[] = [];
  for (const key of [...keys].sort()) {
    if (SERVER_FIELDS.has(key)) continue;
    const left = JSON.stringify(normalizeForCompare(live[key]));
    const right = JSON.stringify(normalizeForCompare((expected as unknown as Record<string, unknown>)[key]));
    if (left !== right) differing.push(key);
  }
  return differing;
}

const SETTING_LABELS: Record<string, string> = {
  advancedSecurityOverrides: "Security",
  applications: "Apps",
  factoryResetDisabled: "Factory reset",
  locationMode: "Location",
  passwordPolicies: "Screen lock",
  passwordRequirements: "Screen lock",
  playStoreMode: "Play Store",
  statusReportingSettings: "Reporting",
  systemUpdate: "Updates",
};

/** A policy setting's name as the page shows it. Unknown ones are spelled out from camelCase. */
export function policySettingLabel(settingName: string): string {
  const known = SETTING_LABELS[settingName];
  if (known) return known;
  const words = settingName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "A setting";
}

// ---------------------------------------------------------------------------------------------
// Talking to Google
// ---------------------------------------------------------------------------------------------

type CallOptions = { token: string; enterpriseName: string };

/** The live policy, or null when it has never been pushed. */
export async function getRepTabletPolicy(
  options: CallOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<LivePolicy | null> {
  try {
    const payload = await callAndroidManagement(
      options.token,
      `/${repTabletPolicyName(options.enterpriseName)}`,
      { method: "GET" },
      fetchImpl,
    );
    return payload as LivePolicy;
  } catch (error) {
    if (error instanceof AndroidManagementRequestError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Create the policy, or replace it whole.
 *
 * `policies.patch` creates a policy that does not exist yet, so the first save and every later one
 * are the same call. No `updateMask`: every field Phoenix does not send is cleared, which is what
 * makes the baseline the whole truth about a rep's tablet.
 */
export async function pushRepTabletPolicy(
  options: CallOptions & { policy: RepTabletPolicy },
  fetchImpl: typeof fetch = fetch,
): Promise<LivePolicy> {
  const payload = (await callAndroidManagement(
    options.token,
    `/${repTabletPolicyName(options.enterpriseName)}`,
    { body: JSON.stringify(options.policy), method: "PATCH" },
    fetchImpl,
  )) as LivePolicy;
  if (typeof payload.name !== "string" || !payload.name) {
    throw new AndroidManagementRequestError(
      "Google accepted the tablet rules but returned no policy name, so it is not certain they were stored.",
      200,
    );
  }
  return payload;
}

export type PlayApp = { packageName: string; title: string };

/**
 * An app's name from Google Play, or null when Play has no such app.
 *
 * Asked before an app is added — a policy naming a package that does not exist is accepted by
 * Google and then fails on every tablet as "app not installed" — and to show the list by name.
 */
export async function lookUpPlayApp(
  options: CallOptions & { packageName: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PlayApp | null> {
  if (!isAndroidPackageName(options.packageName)) {
    throw new TabletPolicyInputError(`'${options.packageName}' is not an Android package name.`);
  }
  try {
    const payload = (await callAndroidManagement(
      options.token,
      `/${options.enterpriseName.trim()}/applications/${options.packageName}?languageCode=en`,
      { method: "GET" },
      fetchImpl,
    )) as { title?: unknown };
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    return { packageName: options.packageName, title: title || options.packageName };
  } catch (error) {
    if (error instanceof AndroidManagementRequestError && error.status === 404) return null;
    throw error;
  }
}
