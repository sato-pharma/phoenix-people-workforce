/**
 * The enrolled tablets, as Google sees them, matched to the custody register.
 *
 * TWO LISTS OF THE SAME TABLETS, KEPT BY DIFFERENT PEOPLE. The register is what HR recorded —
 * asset tag, serial, who signed for it. Google's device list is what actually enrolled — model,
 * Android version, whether it is following the rules. Neither can answer "is PHX-TAB-0007 on the
 * rules, and who holds it" alone, so this module joins them, in this order:
 *
 *   1. The register id the enrollment code carried (`enrollmentTokenData`). Exact — nobody typed it.
 *   2. The serial number, ignoring case, spaces and dashes.
 *   3. The IMEI, digits only, tolerating a register that dropped the final check digit.
 *
 * A tablet matched by its code whose serial is NOT the register's was enrolled with another
 * tablet's code — the likeliest mix-up when several arrive in one box — and is flagged, not hidden.
 * A tablet that matches nothing is listed too: an enrolled device the register does not know is
 * exactly the thing a custody register exists to surface.
 *
 * THE IMEI COMES FROM THE TABLET, NOT FROM A PERSON. Every rep tablet reports its IMEI to Google
 * (`statusReportingSettings.networkInfoEnabled` in the rep-tablet policy), so nobody has to dial
 * *#06# and type fifteen digits into the register. `imeisToRecord` decides which reported IMEIs
 * may be copied into the register, and it is deliberately narrow: only into an entry that holds NO
 * IMEI, and never while the match itself is in doubt. An IMEI somebody typed is never replaced —
 * where it disagrees with what the tablet reports, the row says so and a person decides which is
 * wrong.
 *
 * READ-ONLY. Nothing here changes a device, and nothing here writes the register — the copy is
 * `recordReportedImei` in the register's own service.
 */

import { callAndroidManagement } from "@/lib/devices/android-web-app";
import { imeisMatch, normalizeImei, normalizeSerial } from "@/lib/devices/device-identity";
import { parseEnrollmentTokenData } from "@/lib/devices/tablet-enrollment";
import { REP_TABLET_POLICY_ID, policySettingLabel } from "@/lib/devices/tablet-policy";
import type { CompanyDevice } from "@/lib/devices/types";

/** The parts of Google's `Device` resource this page reads. Proto3 JSON drops defaults, so all optional. */
export type AmapiDevice = {
  name?: string;
  state?: string;
  appliedState?: string;
  policyCompliant?: boolean;
  nonComplianceDetails?: Array<{
    settingName?: string;
    nonComplianceReason?: string;
    packageName?: string;
    fieldPath?: string;
  }>;
  enrollmentTime?: string;
  lastStatusReportTime?: string;
  lastPolicySyncTime?: string;
  policyName?: string;
  appliedPolicyName?: string;
  appliedPolicyVersion?: string;
  enrollmentTokenData?: string;
  managementMode?: string;
  ownership?: string;
  hardwareInfo?: { brand?: string; manufacturer?: string; model?: string; serialNumber?: string };
  softwareInfo?: { androidVersion?: string; securityPatchLevel?: string };
  networkInfo?: { imei?: string; meid?: string };
};

/** 100 is Google's page ceiling; 20 pages is 2,000 tablets, far past this fleet. */
const DEVICES_PAGE_SIZE = 100;
const DEVICES_MAX_PAGES = 20;

/**
 * Every device in the enterprise, all pages.
 *
 * Refuses rather than truncates past the page cap: a list that silently stops at 2,000 would show
 * a tablet as "not enrolled" when it is simply on page 21.
 */
export async function listEnterpriseDevices(
  options: { token: string; enterpriseName: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AmapiDevice[]> {
  const devices: AmapiDevice[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < DEVICES_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ pageSize: String(DEVICES_PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = (await callAndroidManagement(
      options.token,
      `/${options.enterpriseName.trim()}/devices?${params.toString()}`,
      { method: "GET" },
      fetchImpl,
    )) as { devices?: unknown; nextPageToken?: unknown };
    if (Array.isArray(payload.devices)) devices.push(...(payload.devices as AmapiDevice[]));
    pageToken = typeof payload.nextPageToken === "string" && payload.nextPageToken ? payload.nextPageToken : null;
    if (!pageToken) return devices;
  }
  throw new Error(
    `The enterprise lists more than ${DEVICES_PAGE_SIZE * DEVICES_MAX_PAGES} devices. The page stops here rather than show a partial list as the whole fleet.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Matching to the register
// ---------------------------------------------------------------------------------------------

export type RegisterTablet = Pick<
  CompanyDevice,
  | "id"
  | "assetTag"
  | "category"
  | "manufacturer"
  | "model"
  | "serialNumber"
  | "imei"
  | "status"
  | "holderName"
  | "holderJobTitle"
  // Carried so the fleet view can tell a tablet that has a SIM recorded (stays online on its own) from
  // one that depends on a rep connecting Wi-Fi. `getDeviceRegisterData` already selects and maps both.
  | "simNumber"
  | "lineNumber"
>;

export type RegisterMatch = {
  entry: RegisterTablet;
  matchedBy: "enrollment" | "serial" | "imei";
};

// Serial and IMEI comparison lives in `device-identity.ts`, shared with the register's own
// correction, so "the same IMEI" means one thing on both screens. Re-exported for existing callers.
export { normalizeImei, normalizeSerial };

export function matchTabletToRegister(
  device: AmapiDevice,
  register: readonly RegisterTablet[],
): RegisterMatch | null {
  const tokenData = parseEnrollmentTokenData(device.enrollmentTokenData);
  if (tokenData) {
    const entry = register.find((candidate) => candidate.id === tokenData.registerDeviceId);
    if (entry) return { entry, matchedBy: "enrollment" };
  }

  const serial = normalizeSerial(device.hardwareInfo?.serialNumber);
  if (serial) {
    const entry = register.find((candidate) => normalizeSerial(candidate.serialNumber) === serial);
    if (entry) return { entry, matchedBy: "serial" };
  }

  const imei = normalizeImei(device.networkInfo?.imei);
  if (imei) {
    const entry = register.find((candidate) => {
      const registered = normalizeImei(candidate.imei);
      return registered !== null && imeisMatch(registered, imei);
    });
    if (entry) return { entry, matchedBy: "imei" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The rows the page shows
// ---------------------------------------------------------------------------------------------

const STATE_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  DEACTIVATED_BY_DEVICE_FINANCE: "Deactivated",
  DELETED: "Removed",
  DISABLED: "Disabled",
  LOST: "In lost mode",
  PREPARING_FOR_MIGRATION: "Preparing to move",
  PROVISIONING: "Setting up",
};

const NON_COMPLIANCE_LABELS: Record<string, string> = {
  API_LEVEL: "this Android version is too old for it",
  APP_INCOMPATIBLE: "the app does not support this tablet",
  APP_INSTALLED: "an app is installed that should not be",
  APP_NOT_INSTALLED: "not installed yet",
  APP_NOT_UPDATED: "not updated yet",
  APP_SIGNING_CERT_MISMATCH: "the app's signing certificate does not match",
  DEVICE_INCOMPATIBLE: "this tablet does not support it",
  INVALID_VALUE: "Google rejected the value",
  MANAGEMENT_MODE: "not possible in this management mode",
  PENDING: "still being applied",
  PROJECT_NOT_PERMITTED: "the Google Cloud project is not permitted",
  UNSUPPORTED: "not supported on this tablet",
  USER_ACTION: "waiting for the rep to act on the tablet",
};

export type ManagedTabletTone = "ok" | "warn" | "bad";

/**
 * What the page can say about a tablet's IMEI, and whether it may be copied into the register.
 *
 * - `not_reported`      — no network report from the tablet yet; it comes with the first status report.
 * - `none`              — the tablet reported its network but no IMEI. A Wi-Fi-only tablet has none.
 * - `unmatched`         — an IMEI, but no register entry to hold it.
 * - `in_register`       — the register already holds it for this tablet.
 * - `to_record`         — the register entry holds no IMEI, so this one is copied in.
 * - `register_differs`  — the register entry holds a different IMEI. Never overwritten.
 * - `on_another_tablet` — the register holds this IMEI on a different entry.
 * - `held_back`         — only the enrollment code says which entry this is: the tablet's serial is
 *                         not the entry's, or it reported none to compare. Not copied on a code alone.
 * - `contested`         — another enrolled tablet would write a different IMEI into the same entry,
 *                         or this same IMEI into a different one.
 */
export type ImeiStatus =
  | "not_reported"
  | "none"
  | "unmatched"
  | "in_register"
  | "to_record"
  | "register_differs"
  | "on_another_tablet"
  | "held_back"
  | "contested";

export type ManagedTabletRow = {
  /** Google's resource name. A React key only — never shown. */
  key: string;
  registerDeviceId: string | null;
  assetTag: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  matchedBy: RegisterMatch["matchedBy"] | null;
  /** Enrolled with a register entry's code, but the serial is not that entry's. */
  enrolledWithAnotherTabletsCode: boolean;
  model: string;
  serialNumber: string | null;
  /** The IMEI the tablet reports to Google, digits only. Null when it has reported none. */
  imei: string | null;
  imeiStatus: ImeiStatus;
  /** For `register_differs`: the IMEI the register holds for this tablet, as it was typed. */
  registerImei: string | null;
  /** For `on_another_tablet`: the asset tag of the register entry that already holds this IMEI. */
  imeiRecordedOn: string | null;
  androidVersion: string | null;
  securityPatchLevel: string | null;
  stateLabel: string;
  /** The state alone — Active is fine, lost mode or disabled is not, anything else is in between. */
  stateTone: ManagedTabletTone;
  /** The whole row: the state, the rules, and the match to the register together. */
  tone: ManagedTabletTone;
  compliant: boolean;
  /** Plain-English lines, one per setting the tablet is not following. */
  issues: string[];
  onRepPolicy: boolean;
  /** Null when either version is unknown. */
  policyUpToDate: boolean | null;
  enrolledAt: string | null;
  lastReportAt: string | null;
  lastSyncAt: string | null;
};

function titleCaseWords(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function modelLabel(device: AmapiDevice): string {
  const maker = device.hardwareInfo?.manufacturer?.trim() || device.hardwareInfo?.brand?.trim() || "";
  const model = device.hardwareInfo?.model?.trim() || "";
  if (maker && model.toLowerCase().startsWith(maker.toLowerCase())) return model;
  return [maker, model].filter(Boolean).join(" ") || "Model not reported yet";
}

function issueLines(device: AmapiDevice, appTitles: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  for (const detail of device.nonComplianceDetails ?? []) {
    const setting = detail.packageName
      ? appTitles.get(detail.packageName) ?? detail.packageName
      : policySettingLabel(detail.settingName ?? "");
    const reason = detail.nonComplianceReason
      ? NON_COMPLIANCE_LABELS[detail.nonComplianceReason] ?? detail.nonComplianceReason.toLowerCase().replace(/_/g, " ")
      : "not followed";
    lines.push(`${setting}: ${reason}`);
  }
  return [...new Set(lines)];
}

function isRepPolicy(policyName: string | undefined): boolean {
  return (policyName ?? "").split("/").pop() === REP_TABLET_POLICY_ID;
}

type ImeiFacts = Pick<ManagedTabletRow, "imei" | "imeiStatus" | "registerImei" | "imeiRecordedOn">;

/**
 * The reported IMEI against the register, for one tablet.
 *
 * Another entry already holding this IMEI outranks everything else: the register then says this
 * tablet is a different one, whatever matched it, and copying the IMEI would only put the same
 * number on two entries. `uq_company_devices_imei` compares the text as typed, so it would not
 * catch "35-123456-789012-3" against "351234567890123" — this comparison, on digits, does.
 *
 * An IMEI is copied only onto an entry the tablet's own serial number confirms. A code scanned
 * from the wrong tablet's sheet names the wrong entry, and nothing typed by a person would then
 * show the mistake — the register would simply carry another tablet's IMEI.
 */
function reportedImeiFacts(
  device: AmapiDevice,
  match: RegisterMatch | null,
  serialConfirmed: boolean,
  register: readonly RegisterTablet[],
): ImeiFacts {
  const nothingElse = { imeiRecordedOn: null, registerImei: null };
  const imei = normalizeImei(device.networkInfo?.imei);
  if (!imei) return { ...nothingElse, imei: null, imeiStatus: device.networkInfo ? "none" : "not_reported" };

  const elsewhere = register.find((entry) => {
    if (entry.id === match?.entry.id) return false;
    const registered = normalizeImei(entry.imei);
    return registered !== null && imeisMatch(registered, imei);
  });
  if (elsewhere) return { ...nothingElse, imei, imeiRecordedOn: elsewhere.assetTag, imeiStatus: "on_another_tablet" };
  if (!match) return { ...nothingElse, imei, imeiStatus: "unmatched" };

  const typed = match.entry.imei?.trim() || null;
  if (typed) {
    const registered = normalizeImei(typed);
    if (registered !== null && imeisMatch(registered, imei)) return { ...nothingElse, imei, imeiStatus: "in_register" };
    return { ...nothingElse, imei, imeiStatus: "register_differs", registerImei: typed };
  }
  return { ...nothingElse, imei, imeiStatus: serialConfirmed ? "to_record" : "held_back" };
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string) {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

/**
 * Two enrolled tablets writing different IMEIs into one entry, or one IMEI into two entries, is a
 * mix-up nothing here can settle — so neither is copied, and each row says why. The same tablet
 * listed twice (a re-enrollment after a reset leaves Google a second record) reports the same IMEI
 * for the same entry, and is not a conflict.
 */
function holdBackContestedImeis(rows: ManagedTabletRow[]) {
  const imeisByEntry = new Map<string, Set<string>>();
  const entriesByImei = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.imeiStatus !== "to_record" || !row.registerDeviceId || !row.imei) continue;
    addToSet(imeisByEntry, row.registerDeviceId, row.imei);
    addToSet(entriesByImei, row.imei, row.registerDeviceId);
  }
  for (const row of rows) {
    if (row.imeiStatus !== "to_record" || !row.registerDeviceId || !row.imei) continue;
    const contested =
      (imeisByEntry.get(row.registerDeviceId)?.size ?? 0) > 1 || (entriesByImei.get(row.imei)?.size ?? 0) > 1;
    if (!contested) continue;
    row.imeiStatus = "contested";
    if (row.tone === "ok") row.tone = "warn";
  }
}

export function buildManagedTabletRows(
  devices: readonly AmapiDevice[],
  register: readonly RegisterTablet[],
  options: { currentPolicyVersion: string | null; appTitles?: ReadonlyMap<string, string> },
): ManagedTabletRow[] {
  const appTitles = options.appTitles ?? new Map<string, string>();
  const rows = devices.map((device, index): ManagedTabletRow => {
    const match = matchTabletToRegister(device, register);
    const serial = normalizeSerial(device.hardwareInfo?.serialNumber);
    const registerSerial = normalizeSerial(match?.entry.serialNumber);
    const enrolledWithAnotherTabletsCode =
      match?.matchedBy === "enrollment" && serial !== null && registerSerial !== null && serial !== registerSerial;
    const imeiFacts = reportedImeiFacts(device, match, serial !== null && serial === registerSerial, register);

    const state = device.appliedState || device.state || "";
    const stateLabel = STATE_LABELS[state] ?? (state ? titleCaseWords(state) : "Not reported yet");
    const issues = issueLines(device, appTitles);
    const compliant = device.policyCompliant === true;
    const onRepPolicy = isRepPolicy(device.appliedPolicyName || device.policyName);
    const policyUpToDate =
      onRepPolicy && options.currentPolicyVersion && device.appliedPolicyVersion
        ? String(device.appliedPolicyVersion) === String(options.currentPolicyVersion)
        : null;

    const stateTone: ManagedTabletTone =
      state === "ACTIVE" ? "ok" : state === "LOST" || state === "DISABLED" ? "bad" : "warn";
    let tone: ManagedTabletTone = "ok";
    if (
      state !== "ACTIVE" ||
      !compliant ||
      !onRepPolicy ||
      !match ||
      enrolledWithAnotherTabletsCode ||
      imeiFacts.imeiStatus === "register_differs" ||
      imeiFacts.imeiStatus === "held_back"
    ) {
      tone = "warn";
    }
    if (stateTone === "bad" || enrolledWithAnotherTabletsCode || imeiFacts.imeiStatus === "on_another_tablet") tone = "bad";

    return {
      ...imeiFacts,
      androidVersion: device.softwareInfo?.androidVersion?.trim() || null,
      assetTag: match?.entry.assetTag ?? null,
      compliant,
      enrolledAt: device.enrollmentTime ?? null,
      enrolledWithAnotherTabletsCode,
      holderJobTitle: match?.entry.holderJobTitle ?? null,
      holderName: match?.entry.holderName ?? null,
      issues,
      key: device.name || `device-${index}`,
      lastReportAt: device.lastStatusReportTime ?? null,
      lastSyncAt: device.lastPolicySyncTime ?? null,
      matchedBy: match?.matchedBy ?? null,
      model: modelLabel(device),
      onRepPolicy,
      policyUpToDate,
      registerDeviceId: match?.entry.id ?? null,
      securityPatchLevel: device.softwareInfo?.securityPatchLevel?.trim() || null,
      serialNumber: device.hardwareInfo?.serialNumber?.trim() || null,
      stateLabel,
      stateTone,
      tone,
    };
  });
  holdBackContestedImeis(rows);

  // What needs attention first, then by asset tag; tablets the register does not know sort last
  // within their group so a known tablet is never pushed off the top by a stranger.
  const rank = { bad: 0, ok: 2, warn: 1 } as const;
  return rows.sort((left, right) => {
    if (rank[left.tone] !== rank[right.tone]) return rank[left.tone] - rank[right.tone];
    if (!left.assetTag !== !right.assetTag) return left.assetTag ? -1 : 1;
    return (left.assetTag ?? left.serialNumber ?? "").localeCompare(right.assetTag ?? right.serialNumber ?? "");
  });
}

export type ImeiToRecord = { registerDeviceId: string; assetTag: string; imei: string };

/** The reported IMEIs that may be copied into the register — one per entry, only where it holds none. */
export function imeisToRecord(rows: readonly ManagedTabletRow[]): ImeiToRecord[] {
  const seen = new Set<string>();
  const records: ImeiToRecord[] = [];
  for (const row of rows) {
    if (row.imeiStatus !== "to_record" || !row.registerDeviceId || !row.assetTag || !row.imei) continue;
    if (seen.has(row.registerDeviceId)) continue;
    seen.add(row.registerDeviceId);
    records.push({ assetTag: row.assetTag, imei: row.imei, registerDeviceId: row.registerDeviceId });
  }
  return records;
}

export type EnrollableTablet = {
  id: string;
  assetTag: string;
  holderName: string | null;
  model: string | null;
  /** Already on Google's list — enrolling it again is a re-enrollment after a reset. */
  enrolled: boolean;
};

/** Register tablets a code can be made for: every tablet the company still has. */
export function enrollableTablets(
  register: readonly RegisterTablet[],
  rows: readonly ManagedTabletRow[],
): EnrollableTablet[] {
  const enrolled = new Set(rows.map((row) => row.registerDeviceId).filter((id): id is string => Boolean(id)));
  return register
    .filter((entry) => entry.category === "tablet" && entry.status !== "retired" && entry.status !== "lost" && entry.status !== "stolen")
    .map((entry) => ({
      assetTag: entry.assetTag,
      enrolled: enrolled.has(entry.id),
      holderName: entry.holderName,
      id: entry.id,
      model: [entry.manufacturer, entry.model].filter(Boolean).join(" ") || null,
    }))
    .sort((left, right) => left.assetTag.localeCompare(right.assetTag));
}
