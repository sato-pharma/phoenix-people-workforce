/**
 * Phoenix CRM — naming the rep's own browser in a location message. Pure arithmetic on a string, no I/O.
 *
 * WHY THIS EXISTS. Every location message used to read "Turn on precise location for Phoenix". There
 * is no Phoenix app. The rep opens the portal in a browser, so the permission he is sent to find
 * lives under Chrome, Firefox or Safari, and nothing in his phone's settings is called Phoenix. On
 * Phoenix CRM's first real day a rep met that sentence at 11:24 and was still blocked at 18:28: she
 * searched her settings, found no Phoenix, concluded the browser was at fault and signed in again on
 * Firefox — which refused her for the same reason, because the permission she needed was the one she
 * had never been told to look for. Eighteen planned visits went unlogged. **The instruction was
 * impossible to carry out, so carrying it out carefully was the slowest possible way to fail**, and
 * nothing on any screen could tell her so.
 *
 * So a message carries `BROWSER_PLACEHOLDER`, which is already a true sentence on its own, and the
 * screen that shows it swaps in the name the rep can actually read on his own settings screen. The
 * SERVER never guesses and never needs the user agent: its refusal is correct before anything is
 * substituted, and a browser we cannot name with confidence simply keeps the placeholder.
 */

/** Reads as a sentence with nothing substituted — never a token, never a gap. */
export const BROWSER_PLACEHOLDER = "your browser";

/**
 * The browser's own name, spelled as its entry in the phone's settings is spelled, or null when the
 * user agent names none we can state with confidence.
 *
 * ORDER IS THE WHOLE FUNCTION. Every Chromium browser also claims "Chrome", and nearly all of them
 * also claim "Safari", so the specific brands are read first and Safari is only ever what is left
 * when no other brand matched. Read the other way round, every rep on Earth is told to open Safari.
 */
export function browserNameFromUserAgent(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string" || userAgent === "") return null;
  // Edg/ (desktop), EdgA/ (Android), EdgiOS/ (iOS), Edge/ (the old EdgeHTML).
  if (/\bEdg(?:A|iOS|e)?\//.test(userAgent)) return "Edge";
  // OPR/ (desktop and Android), OPT/ (Opera Touch).
  if (/\bOP[RT]\//.test(userAgent)) return "Opera";
  if (/\bSamsungBrowser\//.test(userAgent)) return "Samsung Internet";
  if (/\bFirefox\//.test(userAgent) || /\bFxiOS\//.test(userAgent)) return "Firefox";
  // CriOS is Chrome on iPhone, where it is still called Chrome on the settings screen.
  if (/\bCriOS\//.test(userAgent) || /\bChrome\//.test(userAgent)) return "Chrome";
  if (/\bSafari\//.test(userAgent)) return "Safari";
  return null;
}

/**
 * The message with the rep's browser named wherever the placeholder stands. An unknown browser, or a
 * message that never carried the placeholder, comes back untouched — this never fails open onto a
 * half-written sentence.
 */
export function nameBrowserIn(text: string, browser: string | null): string {
  if (browser === null || browser === "" || !text.includes(BROWSER_PLACEHOLDER)) return text;
  return text.split(BROWSER_PLACEHOLDER).join(browser);
}
