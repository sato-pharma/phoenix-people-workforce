import { sharedIdentityDisplayName } from "@/lib/auth/identity-aliases";

// Canonical nickname-aware display name for employee UI/reports. Legal and
// payroll documents (contracts, offer letters, payslips, payroll exports) and
// identity-matching logic must keep using the raw full name instead.
//
// When `hrId` is a secondary account of a person who also holds a normal employee
// record (see `@/lib/auth/identity-aliases`), the person's name wins over the stored
// full name — so a system-console row reads as the human who operates it instead of
// "Phoenix System Administrator". The stored `full_name` is untouched, which is what
// the directory's system-account filter and every legal document keep matching on.
export function resolveEmployeeDisplayName(
  fullName: string,
  nickname?: string | null,
  hrId?: string | null,
): string {
  const aliasName = sharedIdentityDisplayName(hrId);
  if (aliasName) return aliasName;
  const trimmedNickname = nickname?.trim();
  return trimmedNickname ? trimmedNickname : fullName;
}
