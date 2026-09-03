import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A failed approval on the outstation requests admin screen must SAY SO.
//
// Found 2026-09-03, after the owner approved request 99 (Dina Fadel, 541.90 EGP), saw
// nothing happen, and reported it done. Production still read `status = "submitted"`,
// `trip_id = null`, zero `OUTSTATION-99` payroll rows and zero audit rows: the click had
// failed and the screen had reported neither the failure nor the success.
//
// Two independent defects stacked, and BOTH had to be true for the click to vanish:
//
//   1. `RequestActionButtons` gated its outcome line on `busy` — `acting?.id === request.id`.
//      Every action clears `acting` in its own `finally` block, so by the time the message
//      exists `busy` is already false and NEITHER line ever rendered. That component is used
//      in exactly one place: inside `RequestDetailsModal`. There is no approve button on the
//      list row, so this is the only approve path on the screen.
//
//   2. The page-level toast was `fixed bottom-4 right-4 z-40`, while the details modal is
//      `fixed inset-0 z-[200]` portalled to document.body. With the modal open — which is
//      exactly when you approve — the toast painted BEHIND its backdrop.
//
// So the fallback was hidden by the same modal whose own message was dead. The button stayed
// enabled, the modal stayed open, nothing turned red, and an unpaid claim read as approved.
//
// This test pins the two structural facts rather than any wording or byte window: the outcome
// must not be gated on the flag that is already cleared, and the toast must outrank the modal
// it can appear over.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SOURCE = fileURLToPath(
  new URL("../src/components/outstation/outstation-requests-admin.tsx", import.meta.url),
);

/** `z-40` and `z-[200]` both appear here; read either shape as a number. */
function tailwindZIndex(className: string): number | null {
  const bracketed = /\bz-\[(\d+)\]/.exec(className);
  if (bracketed) return Number(bracketed[1]);
  const plain = /\bz-(\d+)\b/.exec(className);
  return plain ? Number(plain[1]) : null;
}

export async function runOutstationAdminApproveOutcomeTests() {
  const source = readFileSync(ADMIN_SOURCE, "utf8");

  // ── 1. The outcome must not be gated on the flag the finally block already cleared ────────
  for (const gate of ["actionError && busy", "actionMessage && busy"]) {
    assert.equal(
      source.includes(gate),
      false,
      `\`${gate}\` never renders: every action clears \`acting\` in its finally block, so \`busy\` ` +
        "is already false when the message exists. Gate the outcome on the settled action instead.",
    );
  }

  // The replacement has to be reachable, i.e. the id of the request the action ran on must
  // outlive the clear. Without this the new gate is just a different way of rendering nothing.
  assert.match(
    source,
    /const \[actionRequestId, setActionRequestId\] = useState<number \| null>\(null\)/,
    "the settled-action gate needs a request id that survives `setActing(null)`",
  );

  const actingStarts = source.match(/setActing\(\{ action: "(approve|reject|delete)", id: /g) ?? [];
  assert.equal(
    actingStarts.length,
    3,
    "expected the approve / reject / delete actions to be the three that mark a request busy",
  );
  const recordedIds = source.match(/setActionRequestId\(/g) ?? [];
  assert.equal(
    recordedIds.length,
    actingStarts.length,
    "every action that sets `acting` must also record which request it ran on, or its outcome " +
      "line can never render once `acting` is cleared",
  );

  // ── 2. The toast must outrank the modal it has to appear over ─────────────────────────────
  const modalShell = /<div className="(fixed inset-0 [^"]*)"/.exec(source);
  assert.ok(modalShell, "expected to find the details modal's full-screen shell");
  const modalZ = tailwindZIndex(modalShell[1]);
  assert.ok(modalZ !== null, "the details modal shell must carry an explicit z-index");

  const toasts = [...source.matchAll(/className="(?:[^"]*\s)?(fixed bottom-4 right-4 [^"]*)"/g)];
  assert.ok(toasts.length >= 2, "expected both the success and the error toast");
  for (const [, className] of toasts) {
    const toastZ = tailwindZIndex(className);
    assert.ok(toastZ !== null, "each action toast must carry an explicit z-index");
    assert.ok(
      toastZ > modalZ,
      `the action toast (z-index ${toastZ}) must paint above the details modal (z-index ${modalZ}); ` +
        "the approve button lives INSIDE that modal, so a lower toast is invisible exactly when it " +
        "is the only thing reporting a failed approval",
    );
  }
}
