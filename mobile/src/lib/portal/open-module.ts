import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";

import { apiRequest } from "@/lib/api";
import { apiBaseUrl } from "@/lib/config";
import { palettes, type PhoenixPalette } from "@/theme/tokens";

/**
 * Opening a portal module — the production page itself, signed in, inside the app.
 *
 * WHY THE PRODUCTION PAGE AND NOT A NATIVE REBUILD. The portal has sixty-odd modules and 43,000
 * lines of screens behind them, every one of which reads a number a manager acts on. A native copy
 * of a module is a SECOND implementation of that screen, and two implementations of one payroll,
 * leave or sales number is precisely the drift this repo's domain-first rule exists to prevent — the
 * app would look the same on the day it shipped and disagree with the browser a month later. So the
 * modules that have no native screen are opened as what they already are: the live page, same
 * layout, same figures, same permissions, rendering under the portal's own fits-the-screen rule.
 *
 * Native screens stay native where native is the point — signing in, Phoenix CRM, the camera, GPS,
 * dictation, push, and working with no signal. Those cannot be a web page on a phone in a basement.
 *
 * 🔴 IT RENDERS IN AN IN-APP WEBVIEW, AND ONE LINE ELSEWHERE IS WHAT MAKES THAT SAFE.
 * This shipped first (2026-09-28) as a system browser tab, because on Android a WebView's cookie jar
 * IS React Native's own networking jar: the session cookie the hand-off sets would have ridden every
 * request the app makes, and the CSRF guard refuses a cookie-bearing request — every mutation coming
 * back `csrf_blocked`, measured against production on 2026-09-23. `lib/api.ts` now sets
 * `credentials: "omit"` on every call, which React Native's own `NetworkingModule` turns into
 * `CookieJar.NO_COOKIES` for that request, so nothing the WebView stores can reach the app. That is
 * what retired the browser tab and its address bar.
 *
 * **If `credentials: "omit"` ever leaves `lib/api.ts`, this must go back to a browser tab.**
 * `tests/native-web-handoff.test.ts` fails if it disappears, for exactly that reason.
 */

/** Chrome does not always honour these; they are the preference, never the guarantee. */
function tabOptions(palette: PhoenixPalette): WebBrowser.WebBrowserOpenOptions {
  return {
    controlsColor: palette.accent,
    createTask: false,
    enableBarCollapsing: true,
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
 * Ask the server for the one-trip URL that opens `href` already signed in.
 *
 * The app POSTs with its bearer token and gets back a URL whose ticket is good for sixty seconds;
 * loading it sets the ordinary session cookie and redirects to the module, so the ticket never
 * becomes a page's address or its referrer. See `src/lib/auth/native-web-handoff.ts` for why the
 * ticket is sealed rather than merely signed, and why it inherits the app session's own expiry.
 *
 * Throws `ModuleOpenError` when it could not be minted. It deliberately does NOT fall back to
 * loading the page unauthenticated: that lands a rep on a login form he did not ask for, which reads
 * as having been signed out of the app.
 */
export async function mintPortalModuleUrl(input: {
  href: string;
  token: string | null;
}): Promise<string> {
  const { href, token } = input;
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

  return url;
}

/**
 * Open `href` (a portal path such as `/employee-portals/plans`) on its own screen in this app.
 *
 * A plain navigation: the screen mints the hand-off itself, so nothing awaits the network before the
 * module's own frame is on screen, which is what makes a tap feel like the app rather than like a
 * browser starting up.
 */
export function openPortalModule(input: { href: string; label?: string }): void {
  router.push({
    params: { href: input.href, label: input.label ?? "" },
    pathname: "/(portal)/module",
  });
}

/**
 * Open an absolute Phoenix URL that already carries its own query or fragment — what a tapped
 * notification hands over. A portal path opens on the module screen; anything else on the same
 * server still opens in a browser tab, because only the portal is offered in-app.
 */
export async function openPhoenixUrl(input: {
  dark: boolean;
  label?: string;
  url: string;
}): Promise<void> {
  const { dark, label, url } = input;
  const path = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) : null;

  if (path && path.startsWith("/employee-portals")) {
    openPortalModule({ href: path, label });
    return;
  }

  await WebBrowser.openBrowserAsync(url, tabOptions(dark ? palettes.dark : palettes.light)).catch(
    () => undefined,
  );
}
