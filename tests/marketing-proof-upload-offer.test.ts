import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext, phoenixRoles } from "../src/lib/auth/permissions.ts";
import { canUploadMoneyTransferProof, marketingCreatorRoles } from "../src/lib/marketing-requests/service.ts";

// The Approved list offered "Upload proof" to every viewer, and the server refused all but Finance:
// uploadMarketingFinanceEvidence admits system scope, marketingCreatorRoles and Finance Manager, then
// assertMarketingFinanceEvidenceAccess admits only its own short list for a money transfer proof. A rep
// or manager pressing it got a guaranteed "Forbidden" (System Audit, 31 Oct 2026). The screen now asks
// canUploadMoneyTransferProof, and it must answer exactly what the two gates let through together.

const SERVICE = "src/lib/marketing-requests/service.ts";
const SCREEN = "src/components/employee-portal/marketing-request-drafts.tsx";

/** The roles the proof branch of assertMarketingFinanceEvidenceAccess names, read from the gate itself. */
function proofGateRoles(): Set<string> {
  const source = readFileSync(SERVICE, "utf8");
  const start = source.indexOf("function assertMarketingFinanceEvidenceAccess(");
  assert.notEqual(start, -1, "the proof gate still exists");
  const branchStart = source.indexOf('if (params.evidenceType === "money_transfer_proof") {', start);
  assert.notEqual(branchStart, -1, "the gate still has a money transfer proof branch");
  const branch = source.slice(branchStart, source.indexOf("throw forbiddenError(", branchStart));
  const roles = new Set([...branch.matchAll(/params\.access\.role === "([^"]+)"/g)].map((match) => match[1]));
  assert.ok(roles.size > 0, "the proof branch names at least one role");
  return roles;
}

function testThePredicateIsWhatBothGatesAdmit() {
  const proofRoles = proofGateRoles();
  for (const role of phoenixRoles) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    const firstGate =
      access.scope === "system" || marketingCreatorRoles.has(access.role) || access.role === "Finance Manager";
    const secondGate = access.scope === "system" || proofRoles.has(access.role);
    assert.equal(
      canUploadMoneyTransferProof(access),
      firstGate && secondGate,
      `${role}: the screen must offer the proof upload exactly when the server would accept it`,
    );
  }
  // The two people the owner named as the payment rung keep the button.
  assert.equal(canUploadMoneyTransferProof(createAccessContext({ hrId: "TEST-1", role: "Finance Manager" })), true);
  assert.equal(canUploadMoneyTransferProof(createAccessContext({ hrId: "TEST-1", role: "Super Admin" })), true);
  // A rep's own approved request is where the refused press came from.
  assert.equal(canUploadMoneyTransferProof(createAccessContext({ hrId: "TEST-1", role: "Medical Rep" })), false);
}

function testTheScreenAsksBeforeOfferingTheUpload() {
  const service = readFileSync(SERVICE, "utf8");
  assert.ok(
    service.includes("canUploadMoneyTransferProof: canUploadMoneyTransferProof(access),"),
    "the drafts workspace must send the viewer's answer to the screen",
  );

  const screen = readFileSync(SCREEN, "utf8");
  const uploads = [...screen.matchAll(/"money_transfer_proof",\s*file,/g)];
  assert.equal(uploads.length, 2, "the proof upload appears on the desktop table and on the phone card");
  for (const match of uploads) {
    const before = screen.slice(0, match.index);
    const opened = before.lastIndexOf("{workspace.canUploadMoneyTransferProof ? (");
    const closed = before.lastIndexOf(") : (");
    assert.ok(
      opened !== -1 && opened > closed,
      "every proof upload must sit inside the canUploadMoneyTransferProof branch, or a rep is offered a refusal again",
    );
  }
  assert.ok(
    screen.includes("canUploadMoneyTransferProof: payload.canUploadMoneyTransferProof ?? false,"),
    "the screen must read the server's answer and default to no upload",
  );
}

export function runMarketingProofUploadOfferTests() {
  testThePredicateIsWhatBothGatesAdmit();
  testTheScreenAsksBeforeOfferingTheUpload();
}
