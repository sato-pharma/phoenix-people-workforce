import assert from "node:assert/strict";

import { decodeErrorMessage, extractTopComponent } from "../src/lib/error-monitor/message-decode.ts";

export function runErrorMonitorMessageDecodeTests() {
  // ── React minified code + args substitution ─────────────────────────────────
  const hydration = decodeErrorMessage(
    "Minified React error #418; visit https://react.dev/errors/418?args[]=<div>&args[]= for the full message",
  );
  assert.match(hydration.display, /Hydration mismatch/);
  assert.match(hydration.display, /<div>/); // %s filled from args[]
  assert.equal(hydration.raw.startsWith("Minified React error #418"), true);

  // Text-content mismatch (#425) has no %s.
  assert.match(
    decodeErrorMessage("Minified React error #425; visit https://react.dev/errors/425 for the full message").display,
    /Text content does not match/,
  );

  // Unknown React code → graceful fallback, not the raw minified string.
  assert.match(
    decodeErrorMessage("Minified React error #999; visit https://react.dev/errors/999").display,
    /React error #999 — see react\.dev\/errors\/999/,
  );

  // ── Known transient annotations (reuse the recovery detectors) ──────────────
  assert.match(
    decodeErrorMessage("Cannot read properties of undefined (reading 'call')").display,
    /Stale deployment/,
  );
  assert.match(
    decodeErrorMessage("invariant expected layout router to be mounted").display,
    /Transient navigation race/,
  );

  // ── "Switched to client rendering because the server rendering errored" ─────
  const switched = decodeErrorMessage(
    "Switched to client rendering because the server rendering errored:\nSomething broke",
  );
  assert.match(switched.display, /Server render failed/);
  assert.match(switched.display, /Something broke/);

  // ── Plain messages pass through untouched ───────────────────────────────────
  assert.equal(decodeErrorMessage("Forbidden: Employee cannot read expenses.").display, "Forbidden: Employee cannot read expenses.");
  assert.equal(decodeErrorMessage("").display, "Unknown error");

  // ── Component-stack top-frame extraction + append ───────────────────────────
  const stackWithComponent = "Error: boom\n    at x\n\n— Component stack —\n    in LoginForm (at page.tsx:12)\n    in AuthCard";
  assert.equal(extractTopComponent(stackWithComponent), "LoginForm");
  assert.equal(extractTopComponent(null), null);
  // A raw minified JS stack WITHOUT a captured component stack must NOT be mined for a
  // frame name — those are React internals (rX, resolveErrorDev), which would mislead.
  assert.equal(extractTopComponent("Error: boom\n    at rX (chunk.js:1:2)\n    at resolveErrorDev"), null);
  assert.equal(extractTopComponent("    in t\n    in n"), null); // no separator either

  const withComponent = decodeErrorMessage("Minified React error #425; visit https://react.dev/errors/425", stackWithComponent);
  assert.match(withComponent.display, /\(in LoginForm\)$/);
}
