import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isMarketingAdminOverrideNote,
  MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES,
  MARKETING_ADMIN_OVERRIDE_REQUEST_CODE,
  MARKETING_ADMIN_OVERRIDE_STEP_NAME,
} from "../src/lib/marketing-requests/admin-override-note.ts";

const moduleSource = readFileSync(
  new URL("../src/lib/marketing-requests/admin-override-note.ts", import.meta.url),
  "utf8",
);

/**
 * Every surface that renders an approval decision note. If a fourth appears, it belongs here too —
 * a note that is red on two screens and grey on a third is worse than one that is grey everywhere,
 * because the reader learns to trust a colour that is not always shown.
 */
const NOTE_SURFACES = [
  "../src/components/employee-portal/marketing-approval-timeline.tsx",
  "../src/components/employee-portal/marketing-approval-chain.tsx",
  "../src/components/marketing-requests/marketing-request-case-file.tsx",
] as const;

export function runMarketingAdminOverrideNoteTests() {
  /* ── the owner's ONE-TIME rule, enforced ────────────────────────────────── */

  // The whole point of the exception is that it stays one request. A second entry here would turn
  // "validated outside the system" into a reusable bypass of the SFE evidence gate, which is the
  // one outcome the owner ruled out when he asked for this (2026-08-26).
  const quotedRequestCodes = moduleSource.match(/"MKT-REQ-[^"]*"/g) ?? [];
  assert.equal(
    quotedRequestCodes.length,
    1,
    `admin-override-note.ts must name exactly ONE request code; found ${quotedRequestCodes.length}: ${quotedRequestCodes.join(", ")}`,
  );

  // A list, Set or array of codes is the shape a second entry would arrive in. Refuse the shape,
  // not just the count, so the rule cannot be widened without this test going red.
  assert.doesNotMatch(
    moduleSource,
    /REQUEST_CODES|new Set\(|:\s*(readonly\s+)?string\[\]/,
    "the override must stay a single string constant — no list, Set or array of request codes",
  );

  assert.equal(MARKETING_ADMIN_OVERRIDE_REQUEST_CODE, "MKT-REQ-20260825-09BB51CA");
  assert.equal(MARKETING_ADMIN_OVERRIDE_STEP_NAME, "SFE Validation");

  /* ── it matches the one note, and nothing else ──────────────────────────── */

  assert.equal(
    isMarketingAdminOverrideNote({
      requestCode: MARKETING_ADMIN_OVERRIDE_REQUEST_CODE,
      stepName: MARKETING_ADMIN_OVERRIDE_STEP_NAME,
    }),
    true,
    "the SFE Validation note on the one exempted request must be flagged",
  );

  // Casing and stray whitespace come from a URL and from marketing_workflow_steps respectively;
  // neither is worth losing the flag over.
  assert.equal(
    isMarketingAdminOverrideNote({ requestCode: "  mkt-req-20260825-09bb51ca  ", stepName: " sfe validation " }),
    true,
    "matching must tolerate casing and surrounding whitespace",
  );

  // Every other rung of the SAME request is an ordinary decision and must read as one.
  for (const stepName of ["Marketing Review", "CEO Approval", "Finance Execution"]) {
    assert.equal(
      isMarketingAdminOverrideNote({ requestCode: MARKETING_ADMIN_OVERRIDE_REQUEST_CODE, stepName }),
      false,
      `${stepName} on the exempted request must NOT be flagged — only its SFE Validation rung is`,
    );
  }

  // Any other request's SFE Validation rung is untouched. This is the assertion that would fail if
  // the exception ever leaked into a general rule.
  for (const requestCode of ["MKT-REQ-20260825-09BB51CB", "MKT-REQ-20260826-DEADBEEF", "MKT-REQ-20260825-09BB51C"]) {
    assert.equal(
      isMarketingAdminOverrideNote({ requestCode, stepName: "SFE Validation" }),
      false,
      `${requestCode} must never be flagged — the exception covers one request only`,
    );
  }

  // A caller that cannot say which request it is rendering gets the ordinary treatment.
  for (const input of [
    {},
    { requestCode: null, stepName: "SFE Validation" },
    { requestCode: MARKETING_ADMIN_OVERRIDE_REQUEST_CODE, stepName: null },
    { requestCode: "", stepName: "" },
  ]) {
    assert.equal(isMarketingAdminOverrideNote(input), false, "an unidentified note must never be flagged");
  }

  /* ── the colour is actually red, and actually wired up ──────────────────── */

  assert.match(
    MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES,
    /\btext-red-\d{3}\b/,
    "the note must render in red — that is the whole instruction",
  );

  for (const surface of NOTE_SURFACES) {
    const source = readFileSync(new URL(surface, import.meta.url), "utf8");
    assert.match(
      source,
      /isMarketingAdminOverrideNote\(\{/,
      `${surface} renders a decision note, so it must consult the override rule`,
    );
    assert.match(
      source,
      /MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES/,
      `${surface} must use the shared red treatment rather than its own`,
    );
  }
}
