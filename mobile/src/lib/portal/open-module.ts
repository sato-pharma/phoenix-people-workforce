import * as WebBrowser from "expo-web-browser";

import { apiRequest } from "@/lib/api";
import { apiBaseUrl } from "@/lib/config";
import { palettes, type PhoenixPalette } from "@/theme/tokens";

/**
 * Opening a portal module — the production page itself, signed in, without a second login.
 *
 * WHY THE PRODUCTION PAGE AND NOT A NATIVE REBUILD. The portal has sixty-odd modules and 43,000
 * lines of screens behind them, every one of which reads a number a manager acts on. A native copy
 * of a module is a SECOND implementation of that screen, and two implementations of one payroll,
 * leave or sales number is precisely the drift this repo's domain-first rule exists to prevent — the
 * app would look the same on the day it shipped and disagree with the browser a month later. So the
 * modules that have no native screen are opened as what they already are: the live page, same layout,
 * same figures, same permissions, rendering under the portal's own fits-the-screen rule.
 *
 * Native screens stay native where native is the point — signing in, Phoenix CRM, the camera, GPS,
 * dictation, push, and working with no signal. Those cannot be a web page on a phone in a basement.
 *
 * 🔴 A SYSTEM BROWSER TAB, NOT AN EMBEDDED WEBVIEW, AND THAT IS A CORRECTNESS DECISION. On Android
 * a `react-native-webview` shares its cookie jar with React Native's own networking, so a
 * `phoenix_session` cookie set for the module would be replayed on the APP's requests — which the
 * CSRF guard reads as a browser session and refuses, breaking every mutation the app makes with
 * `csrf_blocked`. That exact fault was measured against production on 2026-09-23 and is why
 * `/api/auth/login` clears cookies for a native caller. A Custom Tab has Chrome's own jar, so the
 * cookie cannot reach the app. Do not "upgrade" this to a WebView without solving that first.
 *
 * It also needs no new native module, so a module list shipped today reaches the fleet over EAS
 * Update rather than waiting on a managed-Play release.
 */

/** Chrome does not always honour these; they are the preference, never the guarantee. */
function tabOptions(palette: PhoenixPalette): WebBrowser.WebBrowserOpenOptions {
  return {
    controlsColor: palette.accent,
    // The bar collapses as the page scrolls, so the module gets the whole screen while it is read.
    enableBarCollapsing: true,
    // Stay part of this app in the recents list rather than becoming a separate Chrome task: the
    // person came from Phoenix and "close" has to land them back in Phoenix.
    createTask: false,
    showTitle: true,
    toolbarColor: palette.surface,
  };
}

export class ModuleOpenError extends Error {
  constructor(message = "Could not open that module. Try again.") {
    super(message);
    this.name = "ModuleOpenError";
  }
}

type HandoffResponse = { data: { next: string; url: string }; success: boolean };

/**
 * Open `href` (a portal path such as `/employee-portals/plans`) as the signed-in production page.
 *
 * The app asks the server for a one-trip URL with its bearer token, then hands that URL to the
 * browser tab. The server sets the session cookie and redirects, so the ticket is never the address
 * of a page and never becomes a referrer. See `src/lib/auth/native-web-handoff.ts` for why the ticket
 * is sealed rather than merely signed, and why it inherits the app session's own expiry.
 *
 * Throws `ModuleOpenError` when the hand-off could not be minted. It deliberately does NOT fall back
 * to opening the page unauthenticated: that lands a rep on a login form he did not ask for, which
 * reads as having been signed out of the app.
 */
export async function openPortalModule(input: {
  dark: boolean;
  href: string;
  token: string | null;
}): Promise<void> {
  const { dark, href, token } = input;

  if (!token) throw new ModuleOpenError("Sign in again to open this module.");

  let handoff: HandoffResponse;
  try {
    handoff = await apiRequest<HandoffResponse>(
      `/api/auth/web-session?next=${encodeURIComponent(href)}`,
      { method: "POST", token },
    );
  } catch {
    throw new ModuleOpenError();
  }

  const url = handoff?.data?.url;
  // The URL must be on the server this build talks to. A redirect target from anywhere else is not
  // Phoenix's, whatever answered — the same rule `push-link.ts` applies to a notification link.
  if (typeof url !== "string" || !url.startsWith(`${apiBaseUrl}/`)) {
    throw new ModuleOpenError();
  }

  try {
    await WebBrowser.openBrowserAsync(url, tabOptions(dark ? palettes.dark : palettes.light));
  } catch {
    throw new ModuleOpenError();
  }
}

/**
 * Open an absolute Phoenix URL that already carries its own query or fragment — what a tapped
 * notification hands over. Portal paths go through the signed-in hand-off; anything else on the same
 * server opens plainly, as it did before, because only the portal is offered this way.
 */
export async function openPhoenixUrl(input: {
  dark: boolean;
  token: string | null;
  url: string;
}): Promise<void> {
  const { dark, token, url } = input;
  const path = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) : null;

  if (path && path.startsWith("/employee-portals") && token) {
    try {
      await openPortalModule({ dark, href: path, token });
      return;
    } catch {
      // Fall through: a notification that opens the page is better than one that opens nothing, and
      // Chrome may already be signed in.
    }
  }

  await WebBrowser.openBrowserAsync(url, tabOptions(dark ? palettes.dark : palettes.light)).catch(
    () => undefined,
  );
}
