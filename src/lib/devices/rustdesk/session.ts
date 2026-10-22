/**
 * Opening a remote screen session on one tablet.
 *
 * WHAT THIS DOES AND DELIBERATELY DOES NOT DO. Phoenix does not carry the video: the RustDesk desktop
 * app on the Super Admin's own computer connects to the tablet through a relay — RustDesk's own by
 * default, the company's if one is configured. So this module hands back what that app needs — which
 * tablet, which relay, and, on a self-hosted relay, its public key — and Phoenix's job ends there.
 * Building a browser viewer would mean putting a rep's screen through the Phoenix web app, which is
 * neither needed nor wanted.
 *
 * 🔴 THE SESSION PASSWORD IS NEVER PART OF THIS, IN ANY FORM. RustDesk's link scheme accepts a
 * password in the query string, and it must not be used: a URL is logged by browsers, by proxies and
 * by anything that touches it, and a tablet's permanent access password in a log is a tablet anybody
 * can drive. The connect link built here names the tablet only; the password is typed into the
 * RustDesk app by the person, once, or set as unattended access on the tablet itself.
 *
 * 🔴 AND THE TABLET'S RustDesk ID IS KEPT IN HEADWIND, NOT IN A SECOND LIST. Headwind gives every
 * device three free-text admin fields, and the first one holds the tablet's RustDesk ID. That means
 * one place to look and nothing to keep in step: a tablet re-enrolled or replaced is corrected where
 * it is already being corrected. A tablet whose field is empty reads as "not set up for screen
 * sessions yet" — never as an error, and never as a guess at somebody else's ID.
 */

import {
  rustDeskConfig,
  type RustDeskConfig,
  type RustDeskRelayMode,
} from "@/lib/devices/rustdesk/config";

export type RustDeskTarget = {
  /** The tablet's RustDesk ID, from its Headwind record. */
  rustDeskId: string;
  /** What the person clicks: opens the RustDesk desktop app straight onto this tablet. */
  connectUrl: string;
  /**
   * What the console prints after "through …" — a hostname on the company's own relay, or a plain
   * phrase on RustDesk's public one.
   *
   * 🔴 THE CONSOLE READS THIS AND NEVER `relayHost`, WHICH IS NULL ON THE PUBLIC RELAY. Reading the
   * host directly is how a toast ends up saying "through null".
   */
  relayLabel: string;
  /** The company's own relay host so it can be checked against the app's settings — null on public. */
  relayHost: string | null;
  /** Public by design — the app needs it to verify a SELF-HOSTED relay. Null on public. Never a secret. */
  publicKey: string | null;
  /** Which relay carries this session. */
  relayMode: RustDeskRelayMode;
  /** Watch only, or drive it. Control needs the tablet's accessibility service switched on. */
  mode: RustDeskSessionMode;
};

export type RustDeskSessionMode = "view" | "control";

export function isRustDeskSessionMode(value: unknown): value is RustDeskSessionMode {
  return value === "view" || value === "control";
}

/**
 * The connect link for a tablet.
 *
 * 🔴 THE ID IS URL-ENCODED EVEN THOUGH A RustDesk ID IS DIGITS. It arrives from a free-text field an
 * admin typed into Headwind, so it is not this module's place to assume it is clean — an unencoded
 * value would put whatever was typed straight into a link the person then clicks.
 */
function connectUrl(rustDeskId: string): string {
  return `rustdesk://connect/${encodeURIComponent(rustDeskId)}`;
}

/**
 * The target for a screen session on a tablet, or a plain sentence saying why there is none.
 *
 * Throws `RustDeskNotConfiguredError` only when a SELF-HOSTED relay is half configured — the page
 * turns that into setup instructions rather than an error, exactly as it does for a missing MDM
 * credential. Empty settings are not an error: they are the public relay, and it works.
 */
export function rustDeskTarget(
  input: { rustDeskId: string | null; mode: RustDeskSessionMode },
  env: NodeJS.ProcessEnv = process.env,
): { target: RustDeskTarget | null; reason: string | null } {
  const config: RustDeskConfig = rustDeskConfig(env);
  const rustDeskId = input.rustDeskId?.trim();
  if (!rustDeskId) {
    return {
      reason:
        "This tablet has no RustDesk ID on its Headwind record yet, so there is nothing to connect to. " +
        "Open the tablet's RustDesk app once, read the ID it shows, then open this tablet here and type it " +
        "under Remote screen ID — after that the screen buttons work from here.",
      target: null,
    };
  }

  return {
    reason: null,
    target: {
      connectUrl: connectUrl(rustDeskId),
      mode: input.mode,
      publicKey: config.publicKey,
      relayHost: config.relayHost,
      relayLabel: config.relayLabel,
      relayMode: config.relayMode,
      rustDeskId,
    },
  };
}
