// Recognises the one client error the browser refuses to describe.
//
// When a script from another origin throws, the HTML spec requires the browser to sanitize the
// `error` event before any page code sees it: message becomes exactly "Script error.", filename
// becomes "", lineno/colno become 0, and `error` becomes null. All five together are a positive
// fingerprint — not a guess. The browser has already withheld everything that could identify the
// thrower, so such a row can never be diagnosed, no matter how many of them are collected.
//
// This app loads NO third-party scripts (no analytics, no tag manager, no CDN widget) and serves
// its own chunks same-origin from the app domain. So the thrower is always something the BROWSER
// injected — a content blocker, a translation or reader script, an extension — and never app code.
//
// Measured on production 2026-09-03: 1,972 such rows, 65% of every client error ever recorded,
// every single one with no stack at all — while the app's own errors carry `/_next/` chunk frames
// 239 times. Firefox iOS reports this for 32 of its 37 total errors. One 20-minute session wrote
// 24 of them, which read on the Error Monitor as a page crashing in a loop. The page was working
// the whole time: `readyState=complete`, visible, and still in use minutes later.

/**
 * Some extensions wrap the sanitized message in their own frame delimiter before it reaches
 * `window.onerror`, e.g. `~#!#~0~#!#~Script error.~#!#~`. Same non-answer, different envelope.
 */
const MASKED_MESSAGE_PATTERN = /^(?:~#!#~\d+~#!#~)?script error\.?(?:~#!#~)?$/i;

/** Admin-facing text for a row that the browser deliberately emptied. */
export const CROSS_ORIGIN_MASKED_DISPLAY =
  "A browser-injected script threw (extension, content blocker or reader). No detail is available — browsers withhold it for cross-origin scripts. This is not app code.";

/**
 * True when the message is the browser's sanitized placeholder rather than a real one.
 *
 * Also true for `CROSS_ORIGIN_MASKED_DISPLAY` itself, because that is what gets STORED:
 * `global-error-reporter.tsx` reports the display text, not "Script error.", so every masked row
 * written since then carries it. Recognising only the browser's spelling let all 217 of them past
 * the System Audit's `masked_script_error` filter, and eight reached the morning message as a
 * Command Center fault (31 Oct 2026).
 */
export function isCrossOriginMaskedMessage(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  return text === CROSS_ORIGIN_MASKED_DISPLAY || MASKED_MESSAGE_PATTERN.test(text);
}

export type MaskedErrorEventShape = {
  colno?: number | null;
  error?: unknown;
  filename?: string | null;
  lineno?: number | null;
  message?: string | null;
};

/**
 * True only when EVERY part of the fingerprint holds. Deliberately strict: if the browser let a
 * real Error object, a source URL or a position survive, the error is attributable and must be
 * reported in full — even when its message happens to read "Script error.". Suppressing a
 * diagnosable error would cost far more than keeping one undiagnosable row.
 */
export function isCrossOriginMaskedErrorEvent(event: MaskedErrorEventShape): boolean {
  if (event.error !== null && event.error !== undefined) return false;
  if (event.filename) return false;
  if (event.lineno) return false;
  if (event.colno) return false;
  return isCrossOriginMaskedMessage(event.message);
}
