// Canonical nickname-aware display name for employee UI/reports. Legal and
// payroll documents (contracts, offer letters, payslips, payroll exports) and
// identity-matching logic must keep using the raw full name instead.
export function resolveEmployeeDisplayName(
  fullName: string,
  nickname?: string | null,
): string {
  const trimmedNickname = nickname?.trim();
  return trimmedNickname ? trimmedNickname : fullName;
}
