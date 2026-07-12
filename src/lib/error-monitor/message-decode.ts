// Turns raw, half-unreadable error strings from app_error_events into plain English for
// the System Issues dashboard. Pure + display-time only — the raw string is always kept
// (shown on hover), and decoding runs over existing rows retroactively with no migration.
//
// React ships minified errors in production as
//   "Minified React error #418; visit https://react.dev/errors/418?args[]=…"
// The numeric code + the args[] needed to fill the %s placeholders are both in the string,
// so we can reconstruct the real message client-side from a small curated template map.

import { isStaleDeployChunkError, isTransientRouterMountError } from "@/lib/utils/stale-deploy-recovery";

// Condensed, admin-facing versions of React's official error templates
// (raw.githubusercontent.com/facebook/react/main/scripts/error-codes/codes.json).
// %s placeholders are filled from the message's args[] query params.
const REACT_ERROR_TEMPLATES: Record<string, string> = {
  "418": "Hydration mismatch: server-rendered %s didn't match the client.",
  "419": "Server couldn't finish a Suspense boundary (server render error); switched to client rendering.",
  "421": "Suspense boundary updated before it finished hydrating; switched to client rendering.",
  "422": "Hydration error — recovered by client-rendering from the nearest Suspense boundary.",
  "423": "Hydration error — recovered by client-rendering the entire root.",
  "424": "Root received an early update before hydration; switched the entire root to client rendering.",
  "425": "Text content does not match server-rendered HTML.",
};

const COMPONENT_STACK_SEPARATOR = "— Component stack —";

function fillTemplate(template: string, args: string[]): string {
  let i = 0;
  return template.replace(/%s/g, () => (i < args.length ? args[i++] : "…"));
}

/** Parse a React minified-error string into readable text, or null if it isn't one. */
function decodeReactError(raw: string): string | null {
  const match = raw.match(/react\.dev\/errors\/(\d+)/);
  if (!match) return null;
  const code = match[1];

  // args[] carry the values for the template's %s placeholders (URL-encoded).
  const args: string[] = [];
  for (const argMatch of raw.matchAll(/args\[\]=([^&"'\s]*)/g)) {
    try {
      args.push(decodeURIComponent(argMatch[1]));
    } catch {
      args.push(argMatch[1]);
    }
  }

  const template = REACT_ERROR_TEMPLATES[code];
  if (template) return fillTemplate(template, args);
  return `React error #${code} — see react.dev/errors/${code}`;
}

/**
 * Top application-component name from an EXPLICITLY captured React component stack (the
 * `\n    in Name` lines from a boundary's errorInfo, stored after our separator). Only
 * reads text after COMPONENT_STACK_SEPARATOR and only the component-stack `in` format —
 * it deliberately does NOT scan a raw minified JS stack, because those frames are
 * React internals / mangled names (`rX`, `resolveErrorDev`) that would be misleading,
 * not signal. Returns null when no component stack was captured.
 */
export function extractTopComponent(stack: string | null | undefined): string | null {
  if (!stack) return null;
  const sepIdx = stack.indexOf(COMPONENT_STACK_SEPARATOR);
  if (sepIdx < 0) return null;
  const componentStack = stack.slice(sepIdx + COMPONENT_STACK_SEPARATOR.length);
  const match = componentStack.match(/\n\s*in\s+([A-Za-z][A-Za-z0-9_.$]*)/);
  const name = match?.[1];
  // Skip anonymous/minified single-letter frames — they add no signal.
  if (!name || name.length < 2) return null;
  return name;
}

export type DecodedMessage = { display: string; raw: string };

/**
 * Decode a stored error message into admin-readable text. Order matters: React codes and
 * the known transient annotations are checked before falling through to the raw string.
 * `stack` (optional) is used only to append a captured top component ("(in LoginForm)").
 */
export function decodeErrorMessage(raw: string, stack?: string | null): DecodedMessage {
  const trimmed = (raw ?? "").trim();
  let display = trimmed;

  const reactDecoded = decodeReactError(trimmed);
  const asError = new Error(trimmed);

  if (reactDecoded) {
    display = reactDecoded;
  } else if (isStaleDeployChunkError(asError)) {
    display = "Stale deployment — a code chunk failed to load (auto-recovered on reload).";
  } else if (isTransientRouterMountError(asError)) {
    display = "Transient navigation race (auto-recovered on reload).";
  } else {
    const switched = trimmed.match(/^Switched to client rendering because the server rendering errored:\s*([\s\S]+)$/);
    if (switched) {
      const cause = decodeReactError(switched[1].trim()) ?? switched[1].trim().split("\n")[0];
      display = `Server render failed, fell back to client rendering — ${cause}`;
    }
  }

  const topComponent = extractTopComponent(stack);
  if (topComponent && !display.includes(`(in ${topComponent})`)) {
    display = `${display} (in ${topComponent})`;
  }

  return { display: display || "Unknown error", raw: trimmed };
}
