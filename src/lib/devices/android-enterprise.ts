/**
 * The Google enterprise itself — which one Phoenix is bound to, and how many tablets it holds.
 *
 * WHY THIS EXISTS. Every other module here reads THROUGH the enterprise: the policy, the devices,
 * the enrollment codes. None of them shows the enterprise. So when Google refuses a QR code with
 * "your organization has reached its limit", the page has nothing to say about which organization
 * that is or what it already holds, and the only place to look is the Google Cloud console.
 *
 * TWO FACTS, AND ONLY ONE OF THEM COSTS A CALL. The device count is counted from the device list
 * the page already fetched — no second request, and no filter, so a tablet Google is still
 * provisioning or has since deleted is counted rather than quietly missing. The enterprise's own
 * details (its display name, who signed it up, and which KIND of enterprise it is) are a single
 * `enterprises.get`.
 *
 * 🔴 A FAILED `enterprises.get` MUST NOT COST THE PAGE ITS DEVICE COUNT. The count is the fact the
 * owner came for; the display name is decoration beside it. The caller therefore catches, keeps the
 * count, and shows the reason — never the other way round.
 *
 * READ-ONLY. Nothing here changes the enterprise.
 */

import { callAndroidManagement } from "@/lib/devices/android-web-app";
import type { AmapiDevice } from "@/lib/devices/managed-tablets";

/** What the page shows about the enterprise. Every field optional — proto3 JSON drops defaults. */
export type EnterpriseProfile = {
  /** The binding, `enterprises/LC…` — what `ANDROID_MANAGEMENT_ENTERPRISE_NAME` holds. */
  name: string;
  /** The name Google shows on the tablet's own screens. Null when the enterprise never set one. */
  displayName: string | null;
  /** The address Google contacts about this enterprise — the account that signed it up. */
  contactEmail: string | null;
  /** How the enterprise was made, in words: what decides which Google limits apply to it. */
  kind: string | null;
};

/**
 * Google's enterprise kinds, in words.
 *
 * The distinction is not cosmetic: a managed Google Play Accounts enterprise is one an application
 * created for itself through the signup flow, and it lives inside the Cloud project's Android
 * Management API allowance. A Workspace-bound one belongs to a managed Google domain and does not.
 * That is exactly the difference a provisioning limit turns on, so the page says which this is.
 */
const ENTERPRISE_KINDS: Readonly<Record<string, string>> = {
  MANAGED_GOOGLE_DOMAIN: "Bound to a Google Workspace domain",
  MANAGED_GOOGLE_PLAY_ACCOUNTS_ENTERPRISE: "Managed Google Play Accounts — created by Phoenix itself",
};

/** Google's device states, in words. The raw values are shouted constants nobody should read. */
const DEVICE_STATES: Readonly<Record<string, string>> = {
  ACTIVE: "Working",
  DELETED: "Wiped and removed",
  DISABLED: "Locked",
  PROVISIONING: "Still setting up",
};

function pickString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * One tablet count per state Google actually reported, most tablets first.
 *
 * A state Google does not use on this fleet is left out rather than shown as zero — a row of
 * zeroes reads as a fleet with problems it does not have. A state this module has no word for is
 * shown as Google spells it, never dropped: an unknown state is precisely the one worth seeing.
 */
export function countDevicesByState(devices: readonly AmapiDevice[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const raw = typeof device.state === "string" && device.state.trim() ? device.state.trim() : "STATE_NOT_REPORTED";
    const label = DEVICE_STATES[raw] ?? raw;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Read the enterprise Phoenix is bound to.
 *
 * Throws on a failed call — the caller decides what a missing display name costs, and on this page
 * it costs nothing but a line of explanation.
 */
export async function getEnterpriseProfile(
  options: { token: string; enterpriseName: string },
  fetchImpl: typeof fetch = fetch,
): Promise<EnterpriseProfile> {
  const name = options.enterpriseName.trim();
  const payload = (await callAndroidManagement(options.token, `/${name}`, { method: "GET" }, fetchImpl)) as Record<
    string,
    unknown
  >;

  const contact = payload.contactInfo;
  const contactEmail =
    contact && typeof contact === "object" ? pickString(contact as Record<string, unknown>, "contactEmail") : null;

  // Google names the kind in `enterpriseType`; older enterprises answer only the per-kind field,
  // so its presence is read as the kind too rather than leaving the line blank.
  const declared = pickString(payload, "enterpriseType");
  const kindKey =
    declared && declared !== "ENTERPRISE_TYPE_UNSPECIFIED"
      ? declared
      : pickString(payload, "managedGooglePlayAccountsEnterpriseType")
        ? "MANAGED_GOOGLE_PLAY_ACCOUNTS_ENTERPRISE"
        : pickString(payload, "managedGoogleDomainType")
          ? "MANAGED_GOOGLE_DOMAIN"
          : null;

  return {
    contactEmail,
    displayName: pickString(payload, "enterpriseDisplayName"),
    kind: kindKey ? (ENTERPRISE_KINDS[kindKey] ?? kindKey) : null,
    name: pickString(payload, "name") ?? name,
  };
}
