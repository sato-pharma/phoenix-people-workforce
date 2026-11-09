// Pure, so the rule behind "Back" (owner, 2026-11-09) is pinned without a browser.

/**
 * True when the entry before this one in the tab's history is a page of this app. `document.referrer` cannot answer
 * it: the app moves between pages without reloading, and the referrer stays the first page loaded. The browser's
 * Navigation API lists this app's own entries only, so the entry before the current one is ours when it exists; a
 * browser without it falls back to the history length.
 */
export function previousEntryIsThisApp(input: {
  previousUrl: string | null | undefined;
  origin: string;
  hasNavigationApi: boolean;
  historyLength: number;
}): boolean {
  if (!input.hasNavigationApi) return input.historyLength > 1;
  if (!input.previousUrl) return false;
  try {
    return new URL(input.previousUrl).origin === input.origin;
  } catch {
    return false;
  }
}
