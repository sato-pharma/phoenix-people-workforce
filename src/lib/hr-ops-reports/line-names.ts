import { namesByHrId } from "@/lib/employees/names-by-hr-id";

/**
 * A report row prints the name the person goes by today (owner, 2026-11-03); the stored column stays
 * as it was written, because a submitted report is a record. A person not found, or a failed read,
 * keeps the stored name.
 */
export async function withCurrentLineNames<T extends { employee_name: string; hr_id?: string | null }>(
  lines: readonly T[],
): Promise<T[]> {
  const names = await namesByHrId(lines.map((line) => line.hr_id)).catch(() => null);
  return lines.map((line) => ({ ...line, employee_name: names?.get(line.hr_id) ?? line.employee_name }));
}
