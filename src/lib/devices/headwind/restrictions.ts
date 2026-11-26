/**
 * The locks a rep tablet carries, and the two that must never be put on it.
 *
 * 🔴 A CONFIGURATION'S `restrictions` STRING IS HANDED STRAIGHT TO ANDROID. The launcher splits it on
 * commas and calls `DevicePolicyManager.addUserRestriction(admin, token)` for each piece
 * (`Utils.lockUserRestrictions`, upstream `h-mdm/hmdm-android`), so the vocabulary is Android's own
 * `UserManager.DISALLOW_*` VALUES — not a Headwind list — and a token Android does not know is
 * silently ignored: the lock reads as applied on the server and holds nothing on the tablet. Every
 * token below was read out of AOSP's `UserManager.java` (android13-release) with its own rule about
 * who may set it; all of them are device-owner-settable, which the rep tablets' agent is.
 *
 * 🔴 AND A LOCK IS NOT FREE — each one takes something away from the person holding the tablet, so
 * `costs` is written down beside it and is what gets reported when the lock goes on. The owner's
 * standing instruction (26 Nov 2026) is to protect the tablet "without irritating the usage".
 */

export class TabletLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabletLockError";
  }
}

export type TabletLock = {
  /** What it stops, in plain words. */
  stops: string;
  /** What it costs the rep. "Nothing a rep does" where it takes nothing away. */
  costs: string;
  /** The Android release the token first exists in — below it Android ignores the token. */
  sinceAndroid: number;
};

/**
 * Every lock Phoenix is willing to put on a rep tablet.
 *
 * The first four are the fork's own protective set, which the agent keeps locked for the whole sync
 * (`docs/devices/headwind-rustdesk.md` §8.8); the rest are released and re-applied around each sync,
 * so a sync that dies half-way can leave one of them off until the next one — which is the other
 * reason every install link on the rules must answer 200.
 */
export const TABLET_LOCKS: Record<string, TabletLock> = {
  no_add_user: { costs: "Nothing a rep does.", sinceAndroid: 5, stops: "Adding a second user or a guest session." },
  no_airplane_mode: {
    costs: "Aeroplane mode is gone from quick settings and Settings. A rep on a flight has to switch the tablet off.",
    sinceAndroid: 9,
    stops: "Turning on aeroplane mode — the one tap that kills Wi-Fi and mobile data together.",
  },
  no_change_wifi_state: {
    costs: "The rep cannot turn Wi-Fi off. Joining and switching networks still works, because `no_config_wifi` is deliberately NOT set.",
    sinceAndroid: 12,
    stops: "Turning Wi-Fi off, from quick settings or Settings.",
  },
  no_config_location: {
    costs: "The location switch is greyed out. Phoenix can still turn location on itself (`setLocationEnabled` is exempt).",
    sinceAndroid: 6,
    stops: "Turning location off, or switching a location provider off.",
  },
  no_config_mobile_networks: {
    costs: "Nothing a rep does — the SIM's own APN is already set.",
    sinceAndroid: 5,
    stops: "Changing the mobile network settings: APN, preferred network type, carrier choice.",
  },
  no_control_apps: {
    costs: "Settings > Apps can no longer force-stop an app or clear its data. A rep never needs this, and it is what stops the agent being stopped by hand.",
    sinceAndroid: 5,
    stops: "Force-stopping, disabling or clearing the data of any app — the position agent and the launcher included.",
  },
  no_debugging_features: {
    costs: "Developer options and USB debugging are refused. Nothing a rep does.",
    sinceAndroid: 5,
    stops: "Turning on developer mode.",
  },
  no_factory_reset: { costs: "Nothing a rep does.", sinceAndroid: 5, stops: "Resetting the tablet from Settings." },
  no_install_unknown_sources: {
    costs: "An APK cannot be side-loaded from a browser or a file manager. Everything Phoenix sends still installs, because the agent installs as the device owner.",
    sinceAndroid: 5,
    stops: "Installing an app the company did not send.",
  },
  no_network_reset: {
    costs: "Nothing a rep does — it is the Settings button that would wipe every saved Wi-Fi network and the APN at once.",
    sinceAndroid: 6,
    stops: "Resetting the network settings.",
  },
  no_safe_boot: { costs: "Nothing a rep does.", sinceAndroid: 6, stops: "Rebooting into safe mode, where the agent would not run." },
  no_uninstall_apps: { costs: "Nothing a rep does.", sinceAndroid: 5, stops: "Uninstalling any app." },
};

/**
 * 🔴 TOKENS PHOENIX REFUSES, EACH WITH WHAT IT WOULD COST. These read like exactly what was asked for,
 * which is why they are named here rather than left to be discovered on a fleet that has gone quiet.
 */
export const REFUSED_TABLET_LOCKS: Record<string, string> = {
  no_config_wifi:
    "it stops the rep joining or switching a Wi-Fi network at all, not just turning Wi-Fi off — `no_change_wifi_state` is the lock that was wanted",
  no_install_apps:
    "Android applies it to the device owner TOO (AOSP: \"This user restriction also prevents device owners and profile owners installing apps\"), so no app, launcher or Phoenix update would ever reach the fleet again — `no_install_unknown_sources` is the lock that was wanted",
  no_share_location:
    "it holds location sharing OFF for the whole tablet, which is the opposite of what the position agent needs",
};

/** The set every rep tablet's rules must carry. The order is the stored order, so a diff reads cleanly. */
export const REP_TABLET_LOCK_SET: readonly string[] = [
  "no_factory_reset",
  "no_safe_boot",
  "no_debugging_features",
  "no_add_user",
  "no_config_location",
  "no_uninstall_apps",
  "no_change_wifi_state",
  "no_airplane_mode",
  "no_config_mobile_networks",
  "no_network_reset",
  "no_install_unknown_sources",
  "no_control_apps",
];

/**
 * 🔴 WHAT NOTHING ON THESE TABLETS CAN DO, SAID ON THE PAGE AS WELL AS HERE. There is NO user restriction
 * that stops the mobile-data switch being turned off: AOSP has none, and `no_config_mobile_networks` only
 * covers the network's settings.
 *
 * 🔴 AND A LAUNCHER BUILD CANNOT CLOSE IT EITHER — corrected 26 Nov 2026, after this comment, the runbook
 * and the module's rules all promised one could. Turning mobile data back on is
 * `TelephonyManager.setDataEnabled` / `setDataEnabledForReason`, which need `MODIFY_PHONE_STATE`
 * (`signature|privileged`) or carrier privileges, and `DevicePolicyManager` has no API for it at all, so
 * device-owner status grants nothing here. The only builds that can are platform-signed or in
 * `/system/priv-app`, a UICC-signed carrier app, or root (`svc data enable`) — none of them reachable on a
 * retail Lenovo TB328XU. Reading the switch is free (`isDataEnabled()` needs only `ACCESS_NETWORK_STATE`),
 * which is why the answer is to NOTICE the quiet, not to promise a lock: `fleet-watch.ts` names a held
 * tablet that has said nothing for three hours of the Cairo working day. Saying "he cannot turn the network
 * off" while only aeroplane mode and Wi-Fi are held is the half-truth that gets a tablet handed out
 * believed sealed; promising a future launcher will seal it is the same half-truth with a date on it.
 */
export const MOBILE_DATA_CANNOT_BE_HELD =
  "The mobile-data switch itself cannot be held — not by any Android lock, and not by a launcher build " +
  "either: turning it back on needs MODIFY_PHONE_STATE, which only a platform-signed build, a carrier app " +
  "or root has. Aeroplane mode and Wi-Fi are held, but a rep can still turn mobile data off in quick " +
  "settings. So it is watched instead: a held tablet that says nothing for three hours of the working day " +
  "is named to the Super Admin within the hour.";

/** The tokens in a stored `restrictions` string, in order, with blanks and repeats dropped. */
export function parseRestrictions(stored: unknown): string[] {
  if (typeof stored !== "string") return [];
  const out: string[] = [];
  for (const piece of stored.split(",")) {
    const token = piece.trim();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The string to store, given what is stored now and the locks to add.
 *
 * 🔴 IT ONLY EVER ADDS. A lock already on the rules keeps its place, and nothing is taken off — a
 * caller that wants a lock removed says so by name through its own path, because a silent removal
 * here would be a tablet quietly unlocked by a routine save.
 */
export function restrictionsWith(
  stored: unknown,
  add: readonly string[],
): { added: string[]; already: string[]; next: string } {
  const current = parseRestrictions(stored);
  const added: string[] = [];
  const already: string[] = [];
  for (const token of add) {
    const refused = REFUSED_TABLET_LOCKS[token];
    if (refused) {
      throw new TabletLockError(`Phoenix will not put \`${token}\` on a rep tablet: ${refused}. Nothing was changed.`);
    }
    if (!TABLET_LOCKS[token]) {
      throw new TabletLockError(
        `\`${token}\` is not a lock Phoenix knows, and Android ignores a token it does not know — the lock would read as ` +
          "applied here and hold nothing on the tablet. Nothing was changed.",
      );
    }
    if (current.includes(token)) already.push(token);
    else {
      current.push(token);
      added.push(token);
    }
  }
  return { added, already, next: current.join(",") };
}

/** What a lock takes away, for the report. */
export function describeTabletLock(token: string): string {
  const lock = TABLET_LOCKS[token];
  if (!lock) return `${token}: not a lock Phoenix knows`;
  return `${token} — stops: ${lock.stops} Costs: ${lock.costs} (Android ${lock.sinceAndroid}+)`;
}
