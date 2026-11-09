/**
 * The custody register and the Headwind fleet — which managed tablets the register already knows,
 * which ones are waiting, and adding ONE that a person has confirmed.
 *
 * 🔴 NEW TABLETS ENTER CUSTODY ONLY WHEN A PERSON CONFIRMS THEM (owner, 2026-10-22). Until that day a
 * Headwind tablet that enrolled added ITSELF to the custody register the next time the fleet was read
 * — the "do everything Google was going to do" rule of 2026-09-25. That silent auto-create is gone: a
 * managed tablet the register has never seen now shows on the console as waiting, and a person adds it
 * from its own row through `registerOneHeadwindTablet`. The pure `headwindTabletsToRegister` is kept,
 * but it is now what COUNTS the tablets waiting, never what adds them. Adding one still goes through
 * the SAME `registerTablet` the other bridges call, so one tablet is never describable two ways
 * depending on which console noticed it first; only the trigger changed, from a read to a click.
 *
 * THE IMEI COPY IS UNCHANGED, AND IT IS A DIFFERENT THING. Copying the IMEI a tablet reports onto an
 * entry that already exists but holds none fills a field on a row a person already confirmed — it
 * creates no custody entry — so it still happens by itself through `recordReportedImei`, on the rules
 * `headwindImeisToRecord` sets.
 *
 * WHAT COUNTS AS A REP TABLET HERE. Headwind's device list holds only devices whose agent enrolled on
 * the company's own server, and the company's server manages nothing but rep tablets — so every
 * device in the list qualifies. 🔴 IF A NON-TABLET ANDROID DEVICE IS EVER ENROLLED THERE, narrow this
 * by Headwind's own GROUP or CONFIGURATION, which an admin sets deliberately — never by a guess at
 * the model name, which would file a real tablet as something else the day a maker changes a string.
 *
 * NOTHING HERE TAKES A VALUE FROM THE BROWSER. Which tablets are added, and which IMEIs are copied,
 * are decided from Headwind's live list and the register as they are at that moment. A stale page or
 * a forged request can trigger the work the page would have done anyway; it can never choose what is
 * written.
 */

import { imeisMatch } from "@/lib/devices/device-identity";
import { listHeadwindDevices, matchHeadwindToRegisterDetailed, type HeadwindDevice } from "@/lib/devices/headwind/devices";
import { HeadwindCommandInputError } from "@/lib/devices/headwind/target";
import { normalizeImei, normalizeSerial, type RegisterTablet } from "@/lib/devices/managed-tablets";
import { deviceErrorMessage, getDeviceRegisterData, recordReportedImei } from "@/lib/devices/service";
import { nextTabletAssetTag, registerTablet, type TabletFacts } from "@/lib/devices/tablet-auto-register";

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** Whether the tablet carries something the register can tell it apart by — the register's own bar. */
export function headwindTabletCanBeTold(device: Pick<HeadwindDevice, "imei" | "serialNumber">): boolean {
  return normalizeSerial(clean(device.serialNumber)) !== null || normalizeImei(clean(device.imei)) !== null;
}

/**
 * The managed tablets the register has never seen that CANNOT be added yet: enrolled, but carrying
 * neither a serial number nor an IMEI.
 *
 * 🔴 THEY WERE LEFT OUT OF EVERY COUNT. `headwindTabletsToRegister` skips them (correctly — nothing tells
 * them apart), so "waiting to be added" read one short and nothing on the page said a tablet was stuck.
 * A Headwind tablet sends its serial and IMEI in the hardware report at the end of its first update run,
 * and a run that stops at an install link that does not answer never gets there (memory note
 * `a-stalled-enrolment-run-never-sends-the-tablets-hardware-report`). So these are counted on their own,
 * and each row says why — never folded into the waiting count, where a press would only be refused.
 */
export function headwindTabletsAwaitingHardwareReport(
  devices: readonly HeadwindDevice[],
  register: readonly RegisterTablet[],
): HeadwindDevice[] {
  return devices.filter((device) => !matchHeadwindToRegisterDetailed(device, register) && !headwindTabletCanBeTold(device));
}

const TAG_NUMBER = /^PHX-TAB-(\d+)$/i;

function tagNumber(value: string | null | undefined): number | null {
  const match = TAG_NUMBER.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * A warning when the Headwind device number and the custody tag name the tablet differently.
 *
 * 🔴 THE TWO NUMBERS ARE MINTED APART. A tablet is enrolled in Headwind under a `PHX-TAB-n` number a
 * person types, and its custody tag is minted as "the highest PHX-TAB in the register, plus one"
 * (`nextTabletAssetTag`) — so a retired tablet, a test row (PHX-TAB-0003..0006 are dev rows) or an
 * enrolment out of order leaves the two pointing at different numbers, and "PHX-TAB-0009" then means
 * two different tablets depending on the screen. This only SAYS so; how tags are minted is unchanged.
 *
 * A tablet in the register is compared with its own tag. One not in it yet is compared with the tag
 * the next press would give it, so the person sees the mismatch BEFORE adding it, not after. A device
 * number that is not a PHX-TAB number has nothing to compare and says nothing.
 */
export function headwindTagDrift(
  deviceNumber: string,
  assetTag: string | null,
  nextTag: string | null,
): string | null {
  const headwindNumber = tagNumber(deviceNumber);
  if (headwindNumber === null) return null;
  const device = clean(deviceNumber) as string;
  if (assetTag) {
    const custody = tagNumber(assetTag);
    if (custody === headwindNumber) return null;
    return `Headwind numbers this tablet ${device}, but its custody tag is ${assetTag}. Check the label on the tablet before acting on it by number.`;
  }
  if (!nextTag || tagNumber(nextTag) === headwindNumber) return null;
  return `Headwind numbers this tablet ${device}, but adding it to custody now gives it the tag ${nextTag}, the next free number in the register. The two will read differently.`;
}

/** The tag the next press would mint, against the register as it stands. */
export function headwindNextAssetTag(register: readonly RegisterTablet[]): string {
  return nextTabletAssetTag(register.map((entry) => entry.assetTag));
}

/**
 * The Headwind tablets the custody register should gain: matching no entry, and carrying a serial or
 * an IMEI — the register refuses a device with neither, because nothing would then tell it apart from
 * the next one. One per tablet.
 */
export function headwindTabletsToRegister(
  devices: readonly HeadwindDevice[],
  register: readonly RegisterTablet[],
): TabletFacts[] {
  const seen = new Set<string>();
  const out: TabletFacts[] = [];
  for (const device of devices) {
    if (matchHeadwindToRegisterDetailed(device, register)) continue;

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

export type HeadwindImeiToRecord = { registerDeviceId: string; assetTag: string; imei: string };

/**
 * The reported IMEIs that may be copied into the register, on the other two halves' rules exactly:
 *
 *   · the entry must hold NO IMEI — a number a person typed is never overwritten, even when the
 *     tablet reports a different one; the two are shown side by side and a person decides;
 *   · the entry must have been matched by the tablet's own SERIAL. Today that check is DELIBERATELY
 *     REDUNDANT — the only other way to match is by the IMEI itself, and such an entry already holds
 *     one, so the rule above has already stopped it (breaking this line on its own leaves every test
 *     green, which is exactly why it is written down here rather than left as a silent assumption).
 *     It is kept because it is the rule that actually matters: a row is only this tablet's when
 *     something the tablet itself carries says so;
 *   · no OTHER entry may already hold that IMEI, compared on digits so a typed "35-123456-789012-3"
 *     counts where `uq_company_devices_imei` would not catch it;
 *   · a tie is held back rather than guessed: two tablets claiming one entry, or one IMEI reaching
 *     two entries, writes nothing at all.
 */
export function headwindImeisToRecord(
  devices: readonly HeadwindDevice[],
  register: readonly RegisterTablet[],
): HeadwindImeiToRecord[] {
  const candidates: HeadwindImeiToRecord[] = [];
  for (const device of devices) {
    const imei = normalizeImei(device.imei);
    if (!imei) continue;

    const match = matchHeadwindToRegisterDetailed(device, register);
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
    (candidate) => entryCounts.get(candidate.registerDeviceId) === 1 && imeiCounts.get(candidate.imei) === 1,
  );
}

export type HeadwindRegisterOneDecision =
  | { ok: true; facts: TabletFacts }
  | { ok: false; message: string };

/**
 * Whether ONE named Headwind tablet can be added to the custody register, and with which facts — a
 * pure decision, no I/O, so every refusal can be proven without a database and without writing a row.
 *
 * The rules are the register's own, said once: a tablet that has left the fleet cannot be added; a
 * tablet the register already holds is refused rather than given a second tag (the parity every bridge
 * keeps); and a tablet carrying neither a serial nor an IMEI is refused, because nothing would then
 * tell it apart from the next one. The device number is trimmed before it is matched — a stray space
 * off a console must not turn a known tablet into "not in the fleet".
 */
export function headwindRegisterOneDecision(
  deviceNumber: string,
  devices: readonly HeadwindDevice[],
  register: readonly RegisterTablet[],
): HeadwindRegisterOneDecision {
  const wanted = clean(deviceNumber);
  if (!wanted) return { message: "Say which tablet to add to the custody register.", ok: false };

  const device = devices.find((candidate) => clean(candidate.deviceNumber) === wanted);
  if (!device) {
    return {
      message: "That tablet is not in the Headwind fleet any more. Reload the page and add it from its row.",
      ok: false,
    };
  }

  const match = matchHeadwindToRegisterDetailed(device, register);
  if (match) {
    return { message: `This tablet is already in the custody register as ${match.entry.assetTag}.`, ok: false };
  }

  const facts: TabletFacts = {
    imei: clean(device.imei),
    manufacturer: clean(device.manufacturer),
    model: clean(device.model),
    serialNumber: clean(device.serialNumber),
  };
  if (!headwindTabletCanBeTold(facts)) {
    return {
      message:
        "This tablet is enrolled but has never sent its hardware report — neither a serial number nor an IMEI — so nothing would tell it apart from another tablet. Its first update run probably stalled on an install link; once every link on its rules answers, restart it and it sends the report.",
      ok: false,
    };
  }
  return { facts, ok: true };
}

export type HeadwindRegisterOneResult = {
  assetTag: string;
  created: boolean;
  /** Set when the Headwind device number and the custody tag now read differently (`headwindTagDrift`). */
  tagWarning: string | null;
};

/**
 * Add ONE named Headwind tablet to the custody register, in the actor's name — the person-confirmed
 * step that replaced the silent auto-create removed on 2026-10-22.
 *
 * NOTHING HERE TAKES A VALUE FROM THE BROWSER BUT THE DEVICE NUMBER. The facts written are read from
 * Headwind's own live list, and the tag is numbered against the register as it is now; a stale page or
 * a forged request can ask to add a tablet that is already there or already gone, and gets the refusal
 * `headwindRegisterOneDecision` returns, never a row whose contents it chose. The write goes through
 * the SAME `registerTablet` the auto-create used, which writes its own REQUIRED audit row — so there
 * is no second audit here, and no second write path a parity test would have to pin.
 */
export async function registerOneHeadwindTablet(
  deviceNumber: string,
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindRegisterOneResult> {
  const devices = await listHeadwindDevices(fetchImpl, env);
  // One read of the register answers both "is this tablet already known" and the entry list the new
  // tag is numbered against — the same list `registerTablet` re-reads only if another writer races it.
  const { devices: register } = await getDeviceRegisterData();

  const decision = headwindRegisterOneDecision(deviceNumber, devices, register);
  if (!decision.ok) throw new HeadwindCommandInputError(decision.message);

  const facts = decision.facts;
  const added = await registerTablet(facts, "headwind", actor, register);
  return {
    assetTag: added.assetTag,
    created: added.created,
    tagWarning: headwindTagDrift(deviceNumber, added.assetTag, null),
  };
}

export type HeadwindImeiRecordResult = {
  /** Entries that now hold the IMEI their tablet reports. */
  recorded: Array<{ assetTag: string; imei: string }>;
  /** Entries somebody gave an IMEI between the read and the write — left exactly as they are. */
  alreadyRecorded: string[];
  /** Entries that could not be written, each with its reason. The others are not held up by them. */
  failed: Array<{ assetTag: string; message: string }>;
};

/**
 * Copy the IMEI each Headwind tablet reports into its register entry, where the entry has none.
 *
 * `recordReportedImei` writes each one with its own required audit row, naming Headwind as the
 * console that reported it, and refuses to overwrite anything — so calling this twice is harmless.
 */
export async function recordHeadwindImeis(
  devices: readonly HeadwindDevice[],
  register: readonly RegisterTablet[],
  actor: string,
): Promise<HeadwindImeiRecordResult> {
  const result: HeadwindImeiRecordResult = { alreadyRecorded: [], failed: [], recorded: [] };
  for (const item of headwindImeisToRecord(devices, register)) {
    try {
      const written = await recordReportedImei(
        { deviceId: item.registerDeviceId, imei: item.imei, source: "headwind" },
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
