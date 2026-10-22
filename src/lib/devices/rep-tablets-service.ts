/**
 * Rep Tablets — the service behind the page: what Google holds, what the register holds, the two
 * things the Super Admin can do about it (change the rules, make an enrollment code), and the one
 * thing the page does by itself (copy the IMEI each tablet reports into the register).
 *
 * Every call here goes to Google with the enterprise binding and the service-account credential,
 * and every change is followed by a REQUIRED audit row, the same as every other write in the device
 * register: if the trail cannot be written the request answers an error, and the message says to
 * check what happened before trying again.
 *
 * 🔴 NOTHING HERE LOGS OR AUDITS A CREDENTIAL. The enrollment code and the QR payload go back to the
 * browser that asked for them and nowhere else — the audit row records which tablet a code was made
 * for, how long it lasts and whether it works once, never the code.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { countDevicesByState, getEnterpriseProfile } from "@/lib/devices/android-enterprise";
import { androidManagementTokenProvider } from "@/lib/devices/android-management-auth";
import { CHROME_PACKAGE_NAME, androidManagementConfig } from "@/lib/devices/android-web-app";
import {
  buildManagedTabletRows,
  enrollableTablets,
  imeisToRecord,
  listEnterpriseDevices,
  type EnrollableTablet,
  type ManagedTabletRow,
  type RegisterTablet,
} from "@/lib/devices/managed-tablets";
import { deviceErrorMessage, getDeviceRegisterData, recordReportedImei } from "@/lib/devices/service";
import {
  registerTablet,
  tabletsToAutoRegister,
  type RegisteredTablet,
  type TabletFacts,
} from "@/lib/devices/tablet-auto-register";
import {
  DEFAULT_ENROLLMENT_VALIDITY,
  ENROLLMENT_VALIDITY,
  buildEnrollmentTokenRequest,
  createEnrollmentToken,
  type CreatedEnrollment,
  type EnrollmentValidity,
} from "@/lib/devices/tablet-enrollment";
import {
  OWNER_APP_INSTALL_TYPES,
  REP_TABLET_RULES,
  TabletPolicyInputError,
  buildRepTabletPolicy,
  getRepTabletPolicy,
  lookUpPlayApp,
  ownerAppsFromPolicy,
  parsePlayStorePackageName,
  policyDrift,
  policySettingLabel,
  pushRepTabletPolicy,
  withOwnerApp,
  withoutOwnerApp,
  type OwnerApp,
  type OwnerAppInstallType,
  type PolicyRule,
} from "@/lib/devices/tablet-policy";

/** Asked to make a code before the rules exist on Google. Answered 409: the order is the problem. */
export class TabletPolicyNotSavedError extends Error {
  constructor() {
    super(
      "Save the tablet rules first. A tablet enrolled now would have no rules to follow, and Google refuses a code for a policy it does not hold.",
    );
    this.name = "TabletPolicyNotSavedError";
  }
}

export type RepTabletApp = {
  packageName: string;
  /** Google Play's name for it — the package name only when Play could not be asked. */
  title: string;
  installType: OwnerAppInstallType;
};

export type RepTabletsEnterprise = {
  /** The binding itself — what `ANDROID_MANAGEMENT_ENTERPRISE_NAME` holds. Always known. */
  name: string;
  displayName: string | null;
  contactEmail: string | null;
  kind: string | null;
  /** Every device Google holds under this enterprise, in EVERY state — the true count. */
  deviceCount: number;
  /** That count broken down by what Google says each device is doing. */
  byState: Array<{ label: string; count: number }>;
  /** Set when the enterprise's own details could not be read. The count above still stands. */
  error: string | null;
};

export type RepTabletsState = {
  enterprise: RepTabletsEnterprise;
  policy: {
    /** False until the first save — nothing can be enrolled before then. */
    exists: boolean;
    version: string | null;
    /** Settings where Google's copy is not what Phoenix would push, by name. */
    drift: string[];
    apps: RepTabletApp[];
  };
  rules: readonly PolicyRule[];
  installTypes: readonly { value: OwnerAppInstallType; label: string }[];
  validity: Array<{ value: EnrollmentValidity; label: string }>;
  defaultValidity: EnrollmentValidity;
  tablets: ManagedTabletRow[];
  enrollable: EnrollableTablet[];
  /** Set when the custody register could not be read; the tablets are then shown unmatched. */
  registerError: string | null;
  /**
   * Enrolled tablets the register has never seen that carry a serial or an IMEI — the count, never
   * the act. Nothing is added on this read; a person adds each one (owner, 2026-10-22).
   */
  pendingRegistration: number;
  loadedAt: string;
};

async function connect() {
  const { enterpriseName } = androidManagementConfig();
  const token = await androidManagementTokenProvider()();
  return { enterpriseName, token };
}

/** Every device in the register — a tablet filed under the wrong category still matches by serial. */
async function loadRegister(): Promise<{ entries: RegisterTablet[]; error: string | null }> {
  try {
    const data = await getDeviceRegisterData();
    return { entries: data.devices, error: null };
  } catch (error) {
    return { entries: [], error: deviceErrorMessage(error) };
  }
}

async function appTitles(
  connection: { enterpriseName: string; token: string },
  apps: readonly OwnerApp[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>([[CHROME_PACKAGE_NAME, "Chrome"]]);
  const found = await Promise.all(
    // A failed lookup costs the app its display name, not the page.
    apps.map((app) => lookUpPlayApp({ ...connection, packageName: app.packageName }).catch(() => null)),
  );
  for (const app of found) if (app) titles.set(app.packageName, app.title);
  return titles;
}

/**
 * Read the page. 🔴 THIS READ NO LONGER FILLS THE CUSTODY REGISTER (owner, 2026-10-22: "new tablets
 * enter Device Custody only when a person confirms them"). An enrolled tablet the register does not
 * know is counted in `pendingRegistration`, and a person adds it from the tablet itself on the USB
 * register (`registerRepTabletFromUsb`). `_actor` is kept for call-site compatibility only.
 */
export async function getRepTabletsState(_actor: string): Promise<RepTabletsState> {
  const connection = await connect();
  const [live, devices, loaded, profile] = await Promise.all([
    getRepTabletPolicy(connection),
    listEnterpriseDevices(connection),
    loadRegister(),
    // The enterprise's own details are the one part of this page that may fail on its own. It costs
    // the page a display name, never the device count beside it — see `android-enterprise.ts`.
    getEnterpriseProfile(connection).catch((error: unknown) => deviceErrorMessage(error)),
  ]);

  const register = loaded;
  // Counted, never added: a person confirms each new tablet (owner, 2026-10-22).
  const pendingRegistration = register.error ? 0 : tabletsToAutoRegister(devices, register.entries).length;

  const ownerApps = ownerAppsFromPolicy(live);
  const titles = await appTitles(connection, ownerApps);
  const version = typeof live?.version === "string" ? live.version : null;
  const tablets = buildManagedTabletRows(devices, register.entries, { appTitles: titles, currentPolicyVersion: version });

  const readProfile = typeof profile === "string" ? null : profile;

  return {
    defaultValidity: DEFAULT_ENROLLMENT_VALIDITY,
    enrollable: enrollableTablets(register.entries, tablets),
    enterprise: {
      byState: countDevicesByState(devices),
      contactEmail: readProfile?.contactEmail ?? null,
      deviceCount: devices.length,
      displayName: readProfile?.displayName ?? null,
      error: typeof profile === "string" ? profile : null,
      kind: readProfile?.kind ?? null,
      name: readProfile?.name ?? connection.enterpriseName,
    },
    installTypes: OWNER_APP_INSTALL_TYPES,
    loadedAt: new Date().toISOString(),
    policy: {
      apps: ownerApps.map((app) => ({ ...app, title: titles.get(app.packageName) ?? app.packageName })),
      drift: [...new Set(policyDrift(live, buildRepTabletPolicy(ownerApps)).map(policySettingLabel))],
      exists: live !== null,
      version,
    },
    pendingRegistration,
    registerError: register.error,
    rules: REP_TABLET_RULES,
    tablets,
    validity: (Object.keys(ENROLLMENT_VALIDITY) as EnrollmentValidity[]).map((value) => ({
      label: ENROLLMENT_VALIDITY[value].label,
      value,
    })),
  };
}

export type ImeiRecordResult = {
  /** Entries that now hold the IMEI their tablet reports. */
  recorded: Array<{ assetTag: string; imei: string }>;
  /** Entries somebody gave an IMEI between the read and the write — left exactly as they are. */
  alreadyRecorded: string[];
  /** Entries that could not be written, each with the reason. The others are not held up by them. */
  failed: Array<{ assetTag: string; message: string }>;
};

/**
 * Copy the IMEI each enrolled tablet reports into its custody-register entry, where the entry has
 * none — `imeisToRecord` decides which, `recordReportedImei` writes each with its own required
 * audit row.
 *
 * The page asks for this by itself after it loads, so the register fills without anybody typing an
 * IMEI. It takes NOTHING from the browser: which entries and which IMEIs are read again here, from
 * Google's list and the register as they are now, so a stale page or a forged request can only
 * trigger the copy the page would have made, never choose what is written.
 */
export async function recordReportedImeis(actor: string): Promise<ImeiRecordResult> {
  const connection = await connect();
  const [devices, register] = await Promise.all([listEnterpriseDevices(connection), getDeviceRegisterData()]);
  const rows = buildManagedTabletRows(devices, register.devices, { currentPolicyVersion: null });

  const result: ImeiRecordResult = { alreadyRecorded: [], failed: [], recorded: [] };
  for (const item of imeisToRecord(rows)) {
    try {
      const written = await recordReportedImei({ deviceId: item.registerDeviceId, imei: item.imei }, actor);
      if (written) result.recorded.push({ assetTag: item.assetTag, imei: item.imei });
      else result.alreadyRecorded.push(item.assetTag);
    } catch (error) {
      result.failed.push({ assetTag: item.assetTag, message: deviceErrorMessage(error) });
    }
  }
  return result;
}

export type PolicyChange =
  | { action: "save" }
  | { action: "add"; app: string; installType: OwnerAppInstallType }
  | { action: "remove"; packageName: string };

/**
 * Apply one change to the app list and push the whole policy.
 *
 * The live list is read first and the change applied to it, so two saves never race on a copy the
 * page loaded minutes ago. An added app is looked up on Google Play before it is pushed: Google
 * accepts a policy naming a package that does not exist, and every tablet then reports it as "not
 * installed" with nothing on this page to say why.
 */
export async function changeRepTabletPolicy(change: PolicyChange, actor: string): Promise<{ version: string | null }> {
  const connection = await connect();
  const live = await getRepTabletPolicy(connection);
  const before = ownerAppsFromPolicy(live);

  let after = before;
  let summary: string;
  if (change.action === "add") {
    const packageName = parsePlayStorePackageName(change.app);
    const app = await lookUpPlayApp({ ...connection, packageName });
    if (!app) {
      throw new TabletPolicyInputError(
        `Google Play has no app with the package name ${packageName}. Check the link — it may be a web page, not an app.`,
      );
    }
    after = withOwnerApp(before, { installType: change.installType, packageName });
    const how = OWNER_APP_INSTALL_TYPES.find((entry) => entry.value === change.installType)?.label.toLowerCase();
    summary = `Added ${app.title} to the rep tablets (${how ?? change.installType})`;
  } else if (change.action === "remove") {
    after = withoutOwnerApp(before, change.packageName);
    const app = await lookUpPlayApp({ ...connection, packageName: change.packageName }).catch(() => null);
    summary = `Removed ${app?.title ?? change.packageName} from the rep tablets — it is uninstalled from every tablet`;
  } else {
    summary = live ? "Pushed the rep tablet rules to Google again" : "Saved the rep tablet rules to Google for the first time";
  }

  const pushed = await pushRepTabletPolicy({ ...connection, policy: buildRepTabletPolicy(after) });
  const version = typeof pushed.version === "string" ? pushed.version : null;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: pushed.name ?? null,
    entityType: "android_device_policy",
    newValues: { apps: after, version },
    oldValues: live ? { apps: before, version: typeof live.version === "string" ? live.version : null } : null,
    summary,
  });
  return { version };
}

export type EnrollmentResult = CreatedEnrollment & {
  /** The register tablet the code was made for; null for an any-tablet code. */
  assetTag: string | null;
  validForLabel: string;
};

export async function createRepTabletEnrollment(
  input: { registerDeviceId: string | null; validFor: EnrollmentValidity },
  actor: string,
): Promise<EnrollmentResult> {
  const connection = await connect();
  if (!(await getRepTabletPolicy(connection))) throw new TabletPolicyNotSavedError();

  let target: { registerDeviceId: string; assetTag: string } | null = null;
  if (input.registerDeviceId) {
    const { devices } = await getDeviceRegisterData();
    const entry = devices.find((device) => device.id === input.registerDeviceId);
    if (!entry || entry.category !== "tablet") {
      throw new TabletPolicyInputError("That tablet is not in the custody register any more. Reload the page.");
    }
    if (entry.status === "retired" || entry.status === "lost" || entry.status === "stolen") {
      throw new TabletPolicyInputError(`${entry.assetTag} is marked ${entry.status} in the register, so it cannot be enrolled.`);
    }
    target = { assetTag: entry.assetTag, registerDeviceId: entry.id };
  }

  const request = buildEnrollmentTokenRequest({
    enterpriseName: connection.enterpriseName,
    target,
    validFor: input.validFor,
  });
  const created = await createEnrollmentToken({ ...connection, request });
  const validForLabel = ENROLLMENT_VALIDITY[input.validFor].label;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: target?.registerDeviceId ?? null,
    entityType: "android_enrollment_token",
    newValues: {
      assetTag: target?.assetTag ?? null,
      expiresAt: created.expiresAt,
      oneTimeOnly: created.oneTimeOnly,
      registerDeviceId: target?.registerDeviceId ?? null,
      validFor: input.validFor,
    },
    summary: target
      ? `Made a one-time enrollment code for ${target.assetTag}, valid ${validForLabel}`
      : `Made a reusable enrollment code for any rep tablet, valid ${validForLabel}`,
  });

  return { ...created, assetTag: target?.assetTag ?? null, validForLabel };
}

/**
 * A tablet plugged into the Super Admin's computer: the page read its serial from the USB
 * descriptor and sends it here. Answers the register entry — new, or the one already holding it.
 */
export async function registerRepTabletFromUsb(facts: TabletFacts, actor: string): Promise<RegisteredTablet> {
  const { devices } = await getDeviceRegisterData();
  return registerTablet(facts, "usb", actor, devices);
}
