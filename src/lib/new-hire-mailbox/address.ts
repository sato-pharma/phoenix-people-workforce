/**
 * New hire mailboxes — which company address a new hire gets. Pure: no I/O, so every rule here runs
 * for real in tests/new-hire-mailbox.test.ts.
 *
 * THE ADDRESS HR TYPED ALWAYS WINS. Every hire added in September 2026 arrived with a work email
 * already on the record, spelt the way the company spells it, and some of those spellings are not
 * the obvious one ("mohamad.hamed", "samaa.shalaby"). A generated address is only a proposal for a
 * hire saved without one, and the person creating the mailbox can still change it before connecting.
 *
 * The generated shape is the house one, measured on production on 2026-09-18: of 173 company
 * mailboxes, 107 are first.second, then first.third and first.last as the next choices when a name
 * is already taken. The name read is the NICKNAME first ("Mohamed Eleiwa" for "Mohamed Alaa
 * Eleiwa"), because that is the name the person is known by and the one HR's own addresses follow.
 */

/** The domain every Turbify mailbox the company runs lives on. */
export const COMPANY_MAIL_DOMAIN = "satopharma.com";

const LOCAL_PART_MAX = 64;

/** Lower-case Latin letters only: "El-said" → "elsaid", "AbdelRahman" → "abdelrahman". */
function namePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** The Latin words of a name, in order, with the empty ones (Arabic script, stray symbols) dropped. */
export function latinNameParts(name: string | null | undefined): string[] {
  return String(name ?? "")
    .split(/\s+/)
    .map(namePart)
    .filter((part) => part.length > 0);
}

/** True for an address on the company's own mail domain, the only kind Turbify hosts for it. */
export function isCompanyAddress(address: string | null | undefined): boolean {
  const value = String(address ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  return value.slice(at + 1) === COMPANY_MAIL_DOMAIN && /^[a-z0-9._-]+$/.test(value.slice(0, at));
}

function address(local: string): string | null {
  const trimmed = local.replace(/^\.+|\.+$/g, "").slice(0, LOCAL_PART_MAX);
  return trimmed ? `${trimmed}@${COMPANY_MAIL_DOMAIN}` : null;
}

/**
 * Every address this hire could be given, best first. The typed work email alone when HR entered a
 * company one; otherwise first.second, first.third, first.last from the nickname and then the full
 * name, with duplicates collapsed.
 */
export function mailboxAddressCandidates(employee: {
  fullName: string | null | undefined;
  nickname?: string | null;
  workEmail?: string | null;
}): string[] {
  const typed = String(employee.workEmail ?? "").trim().toLowerCase();
  if (isCompanyAddress(typed)) return [typed];

  const out: string[] = [];
  const push = (local: string) => {
    const value = address(local);
    if (value && !out.includes(value)) out.push(value);
  };
  for (const parts of [latinNameParts(employee.nickname), latinNameParts(employee.fullName)]) {
    if (parts.length === 0) continue;
    const [first, ...rest] = parts;
    if (rest.length === 0) {
      push(first);
      continue;
    }
    push(`${first}.${rest[0]}`);
    if (rest.length > 1) push(`${first}.${rest[1]}`);
    push(`${first}.${rest[rest.length - 1]}`);
  }
  return out;
}

/**
 * The address to propose: the first candidate nobody else holds. Null when every candidate is taken
 * or the name holds no Latin letters, and then the person creating the mailbox types one.
 */
export function proposeMailboxAddress(
  employee: Parameters<typeof mailboxAddressCandidates>[0],
  taken: ReadonlySet<string>,
): string | null {
  const candidates = mailboxAddressCandidates(employee);
  // HR's typed address is the hire's own even when it shows up in `taken` — it is taken BY them.
  if (candidates.length === 1 && isCompanyAddress(employee.workEmail)) return candidates[0];
  return candidates.find((candidate) => !taken.has(candidate)) ?? null;
}
