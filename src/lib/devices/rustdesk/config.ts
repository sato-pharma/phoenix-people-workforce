/**
 * Where remote screen view and control are relayed — RustDesk's public servers, or the company's own.
 *
 * WHY THIS EXISTS. ManageEngine's remote view and remote control stop when the trial ends (they are
 * the amber "Paid" buttons on the ManageEngine section of the Rep Tablets page), and Headwind MDM
 * Community does not include screen mirroring either — it is a +$990 paid add-on there. RustDesk is
 * an ordinary open-source app that does exactly that job, and unlike an MDM it is NOT subject to
 * Android's one-device-owner rule: it rides ALONGSIDE Headwind on the same tablet. So the two
 * together give the whole feature set with no per-device licence at all.
 *
 * 🔴 THE DEFAULT IS RUSTDESK'S PUBLIC RELAY, AND THAT IS THE OWNER'S DECISION — 2026-09-25. This
 * module said the opposite until that day: that self-hosting "is not optional" and a rep's screen
 * "must not travel through" somebody else's relay. That was written before anyone had priced the
 * whole path, and it was wrong on the fact it rested on. **RustDesk is NaCl end-to-end encrypted, so
 * a relay — anyone's relay — carries ciphertext it cannot read.** Self-hosting buys OWNERSHIP and an
 * SLA; it does not buy secrecy, because the secrecy is already there. Renting a box for it cost an
 * evening of failed sign-ups at three providers and bought nothing that was missing, so the relay
 * moved to RustDesk's own free EU servers and the box was dropped.
 *
 * 🔴 SO "NOT CONFIGURED" IS NO LONGER A STATE THIS CAN BE IN, AND THE ERROR NOW MEANS SOMETHING
 * NARROWER. Empty settings are a valid, working configuration — the public relay. The one thing that
 * is still refused is HALF a self-hosted relay: a host with no key, or a key with no host. A client
 * pointed at a private relay it cannot verify does not fail loudly, it quietly falls back, and a
 * fleet that everyone believes is on the company's own relay while it is not is worse than either
 * honest answer.
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

/**
 * What the console prints when the relay is RustDesk's own.
 *
 * 🔴 IT IS A LABEL, NOT A HOSTNAME, AND THAT SEPARATION IS DELIBERATE. RustDesk's public deployment
 * is several hosts chosen by the client at run time, so there is no single name to show and nothing
 * here should invent one. `relayHost` stays null on the public relay precisely so that a future
 * reader cannot mistake a sentence for an address and put it in a config file.
 */
const PUBLIC_RELAY_LABEL = "RustDesk's public relay";

export type RustDeskRelayMode = "public" | "self-hosted";

export type RustDeskConfig = {
  /** Which relay the fleet uses. `public` needs no server and no settings at all. */
  relayMode: RustDeskRelayMode;
  /** The company's own ID/rendezvous host, e.g. relay.satopharma.com — null on the public relay. */
  relayHost: string | null;
  /** The self-hosted relay's public key. Public by design; null on the public relay. */
  publicKey: string | null;
  /** Always a phrase the console can print after "through …". Never null, never an address to copy. */
  relayLabel: string;
  packageName: string;
};

export function rustDeskPackageName(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUSTDESK_APP_PACKAGE?.trim() || DEFAULT_PACKAGE;
}

/**
 * The relay settings from env.
 *
 * Both variables empty is the normal, supported case: the public relay. Both set is the company's
 * own. Exactly one set throws, because that is the only combination that cannot be honoured.
 */
export function rustDeskConfig(env: NodeJS.ProcessEnv = process.env): RustDeskConfig {
  const relayHost = env.RUSTDESK_RELAY_HOST?.trim();
  const publicKey = env.RUSTDESK_PUBLIC_KEY?.trim();
  const packageName = rustDeskPackageName(env);

  if (!relayHost && !publicKey) {
    return {
      packageName,
      publicKey: null,
      relayHost: null,
      relayLabel: PUBLIC_RELAY_LABEL,
      relayMode: "public",
    };
  }

  if (!relayHost || !publicKey) {
    const missing = relayHost ? "RUSTDESK_PUBLIC_KEY" : "RUSTDESK_RELAY_HOST";
    throw new RustDeskNotConfiguredError(
      `The company's own RustDesk relay is only half set up: ${missing} is missing. Set both, or clear ` +
        "both to use RustDesk's public relay. A client pointed at a private relay it cannot verify does " +
        "not fail loudly — it quietly connects somewhere else, and nobody notices.",
    );
  }

  return {
    packageName,
    publicKey,
    relayHost,
    relayLabel: relayHost,
    relayMode: "self-hosted",
  };
}

/**
 * True when the console may offer screen view and control.
 *
 * 🔴 THIS IS NOW TRUE BY DEFAULT, WHICH IS THE POINT OF THE CHANGE. It was false until both relay
 * variables were set, so the buttons sat greyed out until a box existed. The public relay needs no
 * box, so the only thing that still turns them off is the half-configured relay above — which is a
 * mistake to fix, not a feature to wait for.
 */
export function isRustDeskConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    rustDeskConfig(env);
    return true;
  } catch {
    return false;
  }
}
