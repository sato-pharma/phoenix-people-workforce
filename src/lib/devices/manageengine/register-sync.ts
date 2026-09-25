/**
 * The custody register, filled by the tablets themselves — through ManageEngine this time.
 *
 * WHY THIS EXISTS (owner, 2026-09-25: "DO EVERYTHING GOOGLE WAS GOING TO DO"). Everything the Rep
 * Tablets page did for a Google-enrolled tablet was wired to Google's fleet read: a tablet that
 * enrolled put ITSELF into the custody register under the next `PHX-TAB-nnnn` tag, and the IMEI it
 * reported was copied onto its entry so nobody dials *#06#. Phoenix now enrolls on ManageEngine,
 * because Google's device-owner quota for this company is still nil — so a tablet enrolled the way
 * the company actually enrolls got neither. This module is the other half of that pair, and it
 * deliberately calls the SAME `registerTablet` and `recordReportedImei` the Google path calls: one
 * tablet must not be describable two ways depending on which console noticed it first.
 *
 * WHAT COUNTS AS A REP TABLET HERE, AND THE ONE HONEST DIFFERENCE. Google's side filters on the rep
 * tablet POLICY — a device carrying other rules is not a rep tablet and is left alone. ManageEngine's
 * device list carries no equivalent field, so the filter here is what the API does report: an ANDROID
 * device that ManageEngine has not marked removed. That is exact for this tenant, where the only
 * thing enrolled is a rep tablet on the company's own template. 🔴 IF A NON-TABLET ANDROID DEVICE IS
 * EVER ENROLLED THERE, narrow this with ManageEngine's own grouping — never with a guess at the model
 * name, which would file a real tablet as something else the day a maker changes a string.
 *
 * NOTHING HERE TAKES A VALUE FROM THE BROWSER. Which tablets are added, and which IMEIs are copied,
 * are decided from ManageEngine's live list and the register as they are at that moment. A stale page
 * or a forged request can trigger the work the page would have done anyway; it can never choose what
 * is written.
 */

import { imeisMatch } from "@/lib/devices/device-identity";
import { normalizeImei, normalizeSerial, type RegisterTablet } from "@/lib/devices/managed-tablets";
import {
  matchManageEngineToRegisterDetailed,
  type ManageEngineDevice,
} from "@/lib/devices/manageengine/devices";
import { deviceErrorMessage, getDeviceRegisterData, recordReportedImei } from "@/lib/devices/service";
import { registerTablet, type TabletFacts } from "@/lib/devices/tablet-auto-register";

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** A device ManageEngine still manages for us, on the platform rep tablets run. */
function isRepTablet(device: ManageEngineDevice): boolean {
  return device.isAndroid && device.enrollmentStatus !== "Removed";
}

/**
 * The ManageEngine tablets the custody register should gain: managed, Android, matching no entry,
 * and carrying a serial or an IMEI — the register refuses a device with neither, because nothing
 * would then tell it apart from the next one. One per tablet.
 */
export function manageEngineTabletsToRegister(
  devices: readonly ManageEngineDevice[],
  register: readonly RegisterTablet[],
): TabletFacts[] {
  const seen = new Set<string>();
  const out: TabletFacts[] = [];
  for (const device of devices) {
    if (!isRepTablet(device)) continue;
    if (matchManageEngineToRegisterDetailed(device, register)) continue;

    const facts: TabletFacts = {
      imei: clean(device.imei),
      manufacturer: clean(device.manufacturer),
      model: clean(device.model),
      serialNumber: clean(device.serialNumber),
    };
    const key = normalizeSerial(facts.serialNumber) ?? normalizeImei(facts.imei);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(facts);
  }
  return out;
}

export type ManageEngineImeiToRecord = { registerDeviceId: string; assetTag: string; imei: string };

/**
 * The reported IMEIs that may be copied into the register, on the Google half's rules exactly:
 *
 *   · the entry must hold NO IMEI — a number a person typed is never overwritten, even when the
 *     tablet reports a different one; the two are shown side by side and a person decides;
 *   · the entry must have been matched by the tablet's own SERIAL. Today that check is DELIBERATELY
 *     REDUNDANT — the only other way to match is by the IMEI itself, and such an entry already holds
 *     one, so the rule above has already stopped it (breaking this line on its own leaves every test
 *     green, which is exactly why it is written down here rather than left as a silent assumption).
 *     It is kept because it is the rule that actually matters: a row is only this tablet's when
 *     something the tablet itself carries says so, and it must not quietly stop being enforced the
 *     day a third way of matching is added;
 *   · no OTHER entry may already hold that IMEI, compared on digits so a typed "35-123456-789012-3"
 *     counts where `uq_company_devices_imei` would not catch it;
 *   · a tie is held back rather than guessed: two tablets claiming one entry, or one IMEI reaching
 *     two entries, writes nothing at all.
 */
export function manageEngineImeisToRecord(
  devices: readonly ManageEngineDevice[],
  register: readonly RegisterTablet[],
): ManageEngineImeiToRecord[] {
  const candidates: ManageEngineImeiToRecord[] = [];
  for (const device of devices) {
    if (!isRepTablet(device)) continue;
    const imei = normalizeImei(device.imei);
    if (!imei) continue;

    const match = matchManageEngineToRegisterDetailed(device, register);
    if (!match || !match.bySerial) continue;
    if (clean(match.entry.imei)) continue;

    const elsewhere = register.some((entry) => {
      if (entry.id === match.entry.id) return false;
      const registered = normalizeImei(entry.imei);
      return registered !== null && imeisMatch(registered, imei);
    });
    if (elsewhere) continue;

    candidates.push({ assetTag: match.entry.assetTag, imei, registerDeviceId: match.entry.id });
  }

  const entryCounts = new Map<string, number>();
  const imeiCounts = new Map<string, number>();
  for (const candidate of candidates) {
    entryCounts.set(candidate.registerDeviceId, (entryCounts.get(candidate.registerDeviceId) ?? 0) + 1);
    imeiCounts.set(candidate.imei, (imeiCounts.get(candidate.imei) ?? 0) + 1);
  }
  return candidates.filter(
    (candidate) =>
      entryCounts.get(candidate.registerDeviceId) === 1 && imeiCounts.get(candidate.imei) === 1,
  );
}

export type ManageEngineAutoRegisterResult = {
  /** Asset tags created on this read, in the order the tablets were added. */
  registered: string[];
  /** One tablet could not be added; the others were not held up by it. */
  error: string | null;
};

/**
 * Add every unregistered ManageEngine tablet to the custody register, in the actor's name.
 *
 * The register is re-read between writes so each tablet is numbered against what the previous one
 * just created, never against a list read before any of them existed. A failure on one tablet is
 * reported and the loop carries on — a tablet the register refuses must not stop the rest of the
 * fleet arriving.
 */
export async function autoRegisterManageEngineTablets(
  devices: readonly ManageEngineDevice[],
  register: readonly RegisterTablet[],
  actor: string,
): Promise<ManageEngineAutoRegisterResult> {
  const missing = manageEngineTabletsToRegister(devices, register);
  if (missing.length === 0) return { error: null, registered: [] };

  const registered: string[] = [];
  let error: string | null = null;
  let entries = [...register];
  for (const facts of missing) {
    try {
      const added = await registerTablet(facts, "manageengine", actor, entries);
      if (added.created) registered.push(added.assetTag);
      entries = (await getDeviceRegisterData()).devices;
    } catch (caught) {
      error = `A tablet (serial ${facts.serialNumber ?? "not reported"}) could not be added to the custody register: ${deviceErrorMessage(caught)}`;
    }
  }
  return { error, registered };
}

export type ManageEngineImeiRecordResult = {
  /** Entries that now hold the IMEI their tablet reports. */
  recorded: Array<{ assetTag: string; imei: string }>;
  /** Entries somebody gave an IMEI between the read and the write — left exactly as they are. */
  alreadyRecorded: string[];
  /** Entries that could not be written, each with its reason. The others are not held up by them. */
  failed: Array<{ assetTag: string; message: string }>;
};

/**
 * Copy the IMEI each ManageEngine tablet reports into its register entry, where the entry has none.
 *
 * `recordReportedImei` writes each one with its own required audit row, naming ManageEngine as the
 * console that reported it, and refuses to overwrite anything — so calling this twice is harmless.
 */
export async function recordManageEngineImeis(
  devices: readonly ManageEngineDevice[],
  register: readonly RegisterTablet[],
  actor: string,
): Promise<ManageEngineImeiRecordResult> {
  const result: ManageEngineImeiRecordResult = { alreadyRecorded: [], failed: [], recorded: [] };
  for (const item of manageEngineImeisToRecord(devices, register)) {
    try {
      const written = await recordReportedImei(
        { deviceId: item.registerDeviceId, imei: item.imei, source: "manageengine" },
        actor,
      );
      if (written) result.recorded.push({ assetTag: item.assetTag, imei: item.imei });
      else result.alreadyRecorded.push(item.assetTag);
    } catch (caught) {
      result.failed.push({ assetTag: item.assetTag, message: deviceErrorMessage(caught) });
    }
  }
  return result;
}
