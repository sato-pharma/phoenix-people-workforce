/**
 * Where a tapped notification takes the person.
 *
 * Phoenix builds one link per notification, for the web portal. `resolvePushActionUrl` in
 * `src/lib/notifications/push.ts` turns a path such as "/employee-portals/approvals" into an absolute
 * URL on the server's own domain, and leaves it relative when the server has no domain configured.
 * The phone receives the same link a browser does, so this file decides what a tap on it means here:
 *
 * - A page the app has its own screen for opens that screen — but only when the link asks for nothing
 *   the screen cannot show. A query or a fragment is a detail the app would silently drop, so a link
 *   carrying one goes to the browser, which can honour it.
 * - Any other Phoenix page opens in the browser. The app does not have most of the portal yet, and a
 *   tap that goes nowhere reads as a broken notification.
 * - A link to anywhere else is ignored, and the tap just opens the app. Only Phoenix's own server
 *   sends these, so a foreign link is a mistake to contain, not a destination to trust.
 *
 * The link is taken apart with a pattern rather than with `URL`, so this behaves identically on the
 * phone and in the Node test that pins it (`tests/mobile-push-link.test.ts`), whatever the phone's
 * `URL` implements. No React Native imports, for the same reason. The patterns are strict on purpose:
 * a backslash, a space or a control character is something a browser would reinterpret, and a link
 * that could be read two ways is not treated as Phoenix's.
 */

/** A screen of the app, in the form `router.push` takes. */
export type AppScreenHref = "/(portal)" | "/(portal)/profile";

export type PushLinkTarget =
  | { href: AppScreenHref; kind: "screen" }
  | { kind: "browser"; url: string };

/** Portal pages the app has its own screen for. Every other Phoenix page opens in the browser. */
const APP_SCREENS: Readonly<Record<string, AppScreenHref>> = {
  "/employee-portals": "/(portal)",
  "/employee-portals/profile": "/(portal)/profile",
};

/** http(s)://authority, then path, query and fragment. */
const ABSOLUTE_LINK = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** A server-relative link: one leading slash (two would name another host), then path, query, fragment. */
const RELATIVE_LINK = /^(\/(?!\/)[^?#]*)(\?[^#]*)?(#.*)?$/;

/** Characters a browser would quietly rewrite or drop, making the link mean something else. */
const AMBIGUOUS = /[\\\s\u0000-\u001f\u007f]/;

type LinkParts = { origin: string | null; path: string; query: string; fragment: string };

function originOf(scheme: string, authority: string): string {
  return `${scheme.toLowerCase()}://${authority.toLowerCase()}`;
}

function splitLink(value: string): LinkParts | null {
  if (AMBIGUOUS.test(value)) return null;

  const absolute = ABSOLUTE_LINK.exec(value);
  if (absolute) {
    return {
      fragment: absolute[5] ?? "",
      origin: originOf(absolute[1]!, absolute[2]!),
      path: absolute[3] || "/",
      query: absolute[4] ?? "",
    };
  }

  const relative = RELATIVE_LINK.exec(value);
  if (relative) {
    return { fragment: relative[3] ?? "", origin: null, path: relative[1]!, query: relative[2] ?? "" };
  }

  return null;
}

/**
 * Decide what a tap on a notification carrying `link` should do. `serverUrl` is the Phoenix server
 * this app talks to (`apiBaseUrl`), whose domain is the one the server builds its links on.
 *
 * Returns null when the tap should only open the app.
 */
export function resolvePushLink(link: unknown, serverUrl: string): PushLinkTarget | null {
  if (typeof link !== "string") return null;
  const value = link.trim();
  if (value.length === 0) return null;

  const server = ABSOLUTE_LINK.exec(serverUrl.trim());
  if (!server) return null;
  const serverOrigin = originOf(server[1]!, server[2]!);

  const parts = splitLink(value);
  if (!parts) return null;
  if (parts.origin !== null && parts.origin !== serverOrigin) return null;

  // "/employee-portals/" and "/employee-portals" are the same page.
  const page = parts.path.replace(/\/+$/, "") || "/";
  const screen = APP_SCREENS[page];
  if (screen && parts.query === "" && parts.fragment === "") {
    return { href: screen, kind: "screen" };
  }

  return { kind: "browser", url: `${serverOrigin}${parts.path}${parts.query}${parts.fragment}` };
}
