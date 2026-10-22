/**
 * Tablets that put themselves into the custody register — nobody types a serial number.
 *
 * THREE DOORS, ONE REGISTER ENTRY (owner, 2026-09-18: "connect the tablet to my device and Phoenix
 * auto register, no manual work"; he asked for all of them):
 *
 *   1. ENROLLMENT. A tablet that scans an "Any rep tablet" code and matches nothing in the register
 *      is added the next time the Rep Tablets page asks Google for the fleet, with the serial, IMEI,
 *      maker and model Google reports for it.
 *   2. USB. Plugged into the Super Admin's computer, the tablet's USB descriptor carries its serial
 *      number; the page reads it through WebUSB (no Developer mode, no cable driver) and adds it.
 *   3. MANAGEENGINE. A tablet that scans the ManageEngine template code is added the next time the
 *      Rep Tablets page asks ManageEngine for the fleet — the same door as (1), through the vendor
 *      the company actually enrolls on while Google's device-owner quota is still nil (owner,
 *      2026-09-25: "do everything Google was going to do").
 *   4. HEADWIND. The same door again, through the company's OWN Headwind MDM server — the one with
 *      no device cap, which is where the fleet moves as it outgrows ManageEngine's free 25.
 *
 * WHICH DOOR A TABLET CAME THROUGH ONLY CHANGES THE NOTE ON ITS ENTRY. The tag, the identity checks
 * and the `in_stock` landing are deliberately one code path: the same tablet must not be describable
 * two different ways depending on which console noticed it first.
 *
 * Whichever door, the tablet gets the next `PHX-TAB-0001`-style asset tag (the owner's choice), numbered
 * in the order tablets arrive, and lands `in_stock` — handing it to a rep is still Device Custody's
 * signed issue, which this module never does.
 *
 * NEVER A SECOND ENTRY FOR THE SAME TABLET. The register already refuses a repeated serial or IMEI
 * (`uq_company_devices_serial`, `uq_company_devices_imei`); this module checks both first so a tablet
 * that was plugged in by USB and then enrolled is recognised, not duplicated. A lost race on the
 * asset tag (`uq_company_devices_asset_tag`) is retried with the next number.
 */

import { createDevice, getDeviceRegisterData } from "@/lib/devices/service";
import {
  matchTabletToRegister,
  normalizeImei,
  normalizeSerial,
  type AmapiDevice,
  type RegisterTablet,
} from "@/lib/devices/managed-tablets";
import { REP_TABLET_POLICY_ID } from "@/lib/devices/tablet-policy";

export const TABLET_ASSET_TAG_PREFIX = "PHX-TAB-";

const TAG_PATTERN = /^PHX-TAB-(\d+)$/i;

/** The next free tag after the highest `PHX-TAB-n` in the register, four digits wide at least. */
export function nextTabletAssetTag(existingTags: readonly string[]): string {
  let highest = 0;
  for (const tag of existingTags) {
    const match = TAG_PATTERN.exec(tag.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${TABLET_ASSET_TAG_PREFIX}${String(highest + 1).padStart(4, "0")}`;
}

export type TabletFacts = {
  serialNumber: string | null;
  imei: string | null;
  manufacturer: string | null;
  model: string | null;
};

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** The register entry already holding this serial or IMEI, if any. */
export function findRegisteredTablet(facts: TabletFacts, register: readonly RegisterTablet[]): RegisterTablet | null {
  const serial = normalizeSerial(facts.serialNumber);
  if (serial) {
    const entry = register.find((candidate) => normalizeSerial(candidate.serialNumber) === serial);
    if (entry) return entry;
  }
  const imei = normalizeImei(facts.imei);
  if (imei) {
    const entry = register.find((candidate) => {
      const registered = normalizeImei(candidate.imei);
      return registered !== null && (registered === imei || registered.slice(0, 14) === imei.slice(0, 14));
    });
    if (entry) return entry;
  }
  return null;
}

/**
 * Enrolled devices the register should gain: on the rep-tablet rules, not removed, matching no
 * entry, and carrying a serial or IMEI (the register refuses a device with neither). One per serial.
 */
export function tabletsToAutoRegister(
  devices: readonly AmapiDevice[],
  register: readonly RegisterTablet[],
): TabletFacts[] {
  const seen = new Set<string>();
  const out: TabletFacts[] = [];
  for (const device of devices) {
    const state = device.appliedState || device.state || "";
    if (state === "DELETED") continue;
    const policy = (device.appliedPolicyName || device.policyName || "").split("/").pop();
    if (policy !== REP_TABLET_POLICY_ID) continue;
    if (matchTabletToRegister(device, register)) continue;

    const facts: TabletFacts = {
      imei: clean(device.networkInfo?.imei),
      manufacturer: clean(device.hardwareInfo?.manufacturer) ?? clean(device.hardwareInfo?.brand),
      model: clean(device.hardwareInfo?.model),
      serialNumber: clean(device.hardwareInfo?.serialNumber),
    };
    const key = normalizeSerial(facts.serialNumber) ?? normalizeImei(facts.imei);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(facts);
  }
  return out;
}

export type RegisteredTablet = { registerDeviceId: string; assetTag: string; created: boolean };

const TAG_RACE_RETRIES = 5;

/**
 * Add one tablet to the register under the next free tag, or return the entry that already has it.
 * `register` is the caller's current read; it is re-read only when another writer took the tag.
 */
export type TabletRegistrationSource = "enrollment" | "usb" | "manageengine" | "headwind";

const SOURCE_NOTES: Readonly<Record<TabletRegistrationSource, string>> = {
  enrollment: "Added automatically when the tablet enrolled on the rep tablet rules.",
  headwind: "Added to custody from the Rep Tablets page after it enrolled on the company's own Headwind server.",
  manageengine: "Added automatically when the tablet enrolled in ManageEngine on the company's code.",
  usb: "Added automatically when the tablet was plugged into Phoenix by USB.",
};

export async function registerTablet(
  facts: TabletFacts,
  source: TabletRegistrationSource,
  actor: string,
  register: RegisterTablet[],
): Promise<RegisteredTablet> {
  if (!normalizeSerial(facts.serialNumber) && !normalizeImei(facts.imei)) {
    throw new Error("The tablet did not report a serial number or an IMEI, so it cannot be told apart from another tablet.");
  }

  let current = register;
  for (let attempt = 0; attempt < TAG_RACE_RETRIES; attempt += 1) {
    const existing = findRegisteredTablet(facts, current);
    if (existing) return { assetTag: existing.assetTag, created: false, registerDeviceId: existing.id };

    const assetTag = nextTabletAssetTag(current.map((entry) => entry.assetTag));
    try {
      const id = await createDevice(
        {
          assetTag,
          category: "tablet",
          imei: facts.imei,
          manufacturer: facts.manufacturer,
          model: facts.model,
          note: SOURCE_NOTES[source],
          serialNumber: facts.serialNumber,
        },
        actor,
      );
      return { assetTag, created: true, registerDeviceId: id };
    } catch (error) {
      // Another writer may have taken this tag, or registered this very tablet, since `current`
      // was read. Re-read and go round: the check at the top then finds the tablet, or the next tag.
      current = (await getDeviceRegisterData()).devices;
      if (attempt === TAG_RACE_RETRIES - 1) throw error;
    }
  }
  throw new Error("Could not find a free asset tag for the tablet.");
}
