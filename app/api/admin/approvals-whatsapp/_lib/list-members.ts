// Turns a list form's body into members (not a route — a plain module beside the list routes).

import { dedupeRecipients, parsePastedNumbers, type ApprovalsRecipient } from "@/lib/approvals-whatsapp/rules";
import { employeesByWaId, loadApprovalsEmployees } from "@/lib/approvals-whatsapp/store";

export async function listMembersFromBody(body: Record<string, unknown>): Promise<{
  recipients: ApprovalsRecipient[];
  skipped: { noNumber: string[]; invalid: Array<{ text: string; reason: string }>; duplicates: number };
}> {
  const employees = await loadApprovalsEmployees();
  const byHrId = new Map(employees.map((employee) => [employee.hrId.trim().toUpperCase(), employee]));
  const byWaId = employeesByWaId(employees);
  const chosen: ApprovalsRecipient[] = [];
  const noNumber: string[] = [];
  const hrIds = Array.isArray(body.employeeHrIds) ? body.employeeHrIds.filter((id): id is string => typeof id === "string") : [];
  for (const hrId of hrIds.slice(0, 5000)) {
    const employee = byHrId.get(hrId.trim().toUpperCase());
    if (!employee) continue;
    if (!employee.waId) noNumber.push(employee.name);
    else chosen.push({ displayName: employee.name, employeeHrId: employee.hrId, waId: employee.waId });
  }
  const pasted = parsePastedNumbers(typeof body.pasted === "string" ? body.pasted : "");
  for (const waId of pasted.valid) {
    const employee = byWaId.get(waId) ?? null;
    chosen.push({ displayName: employee?.name ?? null, employeeHrId: employee?.hrId ?? null, waId });
  }
  const { duplicates, recipients } = dedupeRecipients(chosen);
  return { recipients, skipped: { duplicates: duplicates.length + pasted.duplicates.length, invalid: pasted.invalid, noNumber } };
}
