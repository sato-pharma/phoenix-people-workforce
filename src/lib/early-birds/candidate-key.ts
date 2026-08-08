import { normalizeHrIdForAccess } from "@/lib/hr-id";

/**
 * The stable identity of "this rep, in this fortnight, under this manager".
 *
 * It deliberately contains NO score and NO hash of the underlying dates. Recomputing the same rep
 * for the same period must be recognised as the SAME candidate rather than minting a new one —
 * folding volatile data into an identity key is exactly the trap the deductions module had to grow
 * a separate identity helper to work around.
 */
export function buildEarlyBirdsCandidateKey(input: {
  periodKey: string;
  managerHrId: string;
  employeeHrId: string;
}): string {
  // normalizeHrIdForAccess, NOT canonicalHrIdKey: the latter lowercases and applies the alias table
  // but KEEPS hyphens, so canonical "B100" and stored "B-100" would mint two different identities
  // for one person and the same rep would be recommended twice.
  const manager = normalizeHrIdForAccess(input.managerHrId) ?? "";
  const employee = normalizeHrIdForAccess(input.employeeHrId) ?? "";
  return `early-birds:${input.periodKey}:${manager}:${employee}`;
}
