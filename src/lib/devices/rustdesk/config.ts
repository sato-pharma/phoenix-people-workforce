/**
 * The company's own RustDesk relay — what brings remote screen view and control back, free.
 *
 * WHY THIS EXISTS. ManageEngine's remote view and remote control stop when the trial ends (they are
 * the amber "Paid" buttons on the ManageEngine section of the Rep Tablets page), and Headwind MDM
 * Community does not include screen mirroring either — it is a +$990 paid add-on there. RustDesk is
 * an ordinary open-source app that does exactly that job, and unlike an MDM it is NOT subject to
 * Android's one-device-owner rule: it rides ALONGSIDE Headwind on the same tablet. So the two
 * together give the whole feature set with no per-device licence at all.
 *
 * 🔴 SELF-HOSTED, ON THE SAME SMALL SERVER, AND THAT IS NOT OPTIONAL. RustDesk's public relay is a
 * free service run by somebody else, and a rep's screen — patient names, prescriptions, salary
 * screens — must not travel through it. The compose file beside this repo runs `hbbs` and `hbbr` on
 * the company's own box; these settings point the Phoenix console at that box.
 *
 * 🔴 NO SECRET BELONGS IN A CONNECT LINK OR A LOG LINE. The relay's public key is exactly that —
 * public, and needed by every client — but a session password is not, and neither is ever written
 * into a URL by this module. `session.ts` builds a target, never a credential.
 */

export class RustDeskNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RustDeskNotConfiguredError";
  }
}

/**
 * The RustDesk Android package.
 *
 * 🔴 `com.carriez.flutter_hbb` LOOKS WRONG AND IS CORRECT. RustDesk's Android client keeps the
 * package id of the Flutter project it was built from; the app on the tablet is called RustDesk and
 * its package is this. It is env-overridable only because a self-built client (RustDesk's custom
 * client builder renames the package) would carry a different one — never change the default to
 * something that merely reads better.
 */
const DEFAULT_PACKAGE = "com.carriez.flutter_hbb";

export function rustDeskPackageName(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUSTDESK_APP_PACKAGE?.trim() || DEFAULT_PACKAGE;
}

export type RustDeskConfig = {
  /** The company's ID/rendezvous server — the `hbbs` host, e.g. relay.satopharma.com. */
  relayHost: string;
  /** The server's public key. Public by design: every client needs it to verify the relay. */
  publicKey: string;
  packageName: string;
};

/** The relay settings from env, or a clear error naming what is missing. */
export function rustDeskConfig(env: NodeJS.ProcessEnv = process.env): RustDeskConfig {
  const relayHost = env.RUSTDESK_RELAY_HOST?.trim();
  const publicKey = env.RUSTDESK_PUBLIC_KEY?.trim();

  const missing = [
    relayHost ? null : "RUSTDESK_RELAY_HOST",
    publicKey ? null : "RUSTDESK_PUBLIC_KEY",
  ].filter((entry): entry is string => entry !== null);
  if (missing.length > 0) {
    throw new RustDeskNotConfiguredError(
      `Remote screen sessions are not connected yet: set ${missing.join(", ")} (from the company's own ` +
        "RustDesk server). The tablets are still managed normally — only viewing and controlling a screen needs this.",
    );
  }

  return { packageName: rustDeskPackageName(env), publicKey: publicKey!, relayHost: relayHost! };
}

/** True when the relay settings are present — the console may offer screen view and control. */
export function isRustDeskConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RUSTDESK_RELAY_HOST?.trim() && env.RUSTDESK_PUBLIC_KEY?.trim());
}
