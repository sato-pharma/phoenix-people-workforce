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

/**
 * Display only. A name stored ENTIRELY in capitals — "SAHAR EL GALLAD", the way the Source of Sales
 * files carry every manager and a few HR rows were typed — reads as "Sahar El Gallad". A name with
 * any lower-case letter is a spelling somebody chose ("AboElftouh", "Kamal eldeen") and is returned
 * exactly as stored; a name with no Latin capitals at all (Arabic) is untouched.
 *
 * Never feed the result to identity matching, a legal document or a payroll export — those keep the
 * stored full name, character for character.
 */
export function tidyAllCapitalsName(name: string): string {
  if (!/[A-Z]/.test(name) || /[a-z]/.test(name)) return name;
  return name.toLowerCase().replace(/(^|[\s\-'’.(/])([a-z])/g, (_match, edge: string, letter: string) => edge + letter.toUpperCase());
}

/** `resolveEmployeeDisplayName`, then `tidyAllCapitalsName`: the name a manager's screen prints. */
export function resolvePersonDisplayName(fullName: string, nickname?: string | null, hrId?: string | null): string {
  return tidyAllCapitalsName(resolveEmployeeDisplayName(fullName, nickname, hrId));
}
