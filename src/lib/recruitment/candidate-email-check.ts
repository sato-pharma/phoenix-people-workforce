// Does a candidate's email address look like one that cannot receive mail?
//
// Owner, 2026-10-19 ("Stop broken emails at intake"). PR 6143 fixed the CV reader gluing the next
// word onto an address (gmail.comp, gmail.comi); what that cannot catch is an address that ARRIVED
// wrong — Aya Ali's "ayamamdouh78@yahoo.om", the applicant's own slip. Nothing is corrected
// automatically here: an address is somebody's identity and the duplicate-check key, and a guess
// that is wrong merges two people. The pool says "Check email" and names the likely address; a
// person confirms it.
//
// Pure, so the desktop row, the phone card and the tests read one rule.

/** The big free-mail providers and the exact domains each really uses. */
const PROVIDER_DOMAINS: Record<string, { label: string; domains: readonly string[] }> = {
  gmail: { domains: ["gmail.com"], label: "Gmail" },
  googlemail: { domains: ["googlemail.com"], label: "Gmail" },
  hotmail: { domains: ["hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.it", "hotmail.de"], label: "Hotmail" },
  icloud: { domains: ["icloud.com"], label: "iCloud" },
  live: { domains: ["live.com", "live.co.uk", "live.fr"], label: "Live" },
  outlook: { domains: ["outlook.com", "outlook.sa", "outlook.fr", "outlook.de"], label: "Outlook" },
  yahoo: { domains: ["yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.ca", "yahoo.com.eg"], label: "Yahoo" },
  ymail: { domains: ["ymail.com"], label: "Yahoo" },
};

/** Misspellings of a provider's name seen in CVs and typed answers, and the address they meant. */
const PROVIDER_MISSPELLINGS: Record<string, string> = {
  gamil: "gmail.com",
  gmai: "gmail.com",
  gmal: "gmail.com",
  gmaill: "gmail.com",
  gmial: "gmail.com",
  gnail: "gmail.com",
  hotmai: "hotmail.com",
  hotmal: "hotmail.com",
  hotmial: "hotmail.com",
  outlok: "outlook.com",
  yaho: "yahoo.com",
  yahooo: "yahoo.com",
};

const SHAPE = /^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/** The short label on the flag itself. */
export const EMAIL_CHECK_LABEL = "Check email";

export type CandidateEmailProblem = {
  /** What it most likely should be, when that is clear — never applied automatically. */
  likely: string | null;
  /** One sentence for the tooltip and the phone line. */
  explanation: string;
};

/** Null for an address that looks deliverable, or for no address at all (that is a different gap). */
export function candidateEmailProblem(email: string | null | undefined): CandidateEmailProblem | null {
  const value = String(email ?? "").trim().toLowerCase();
  if (!value) return null;
  const shape = value.match(SHAPE);
  if (!shape) return { explanation: `"${value}" is not an email address shape.`, likely: null };
  const domain = shape[1];
  const local = value.slice(0, value.length - domain.length - 1);
  const labels = domain.split(".");
  const name = labels[0];
  const ending = labels[labels.length - 1];
  if (!/^[a-z]{2,6}$/.test(ending)) {
    return { explanation: `"${domain}" does not end in a real domain ending.`, likely: null };
  }
  const provider = PROVIDER_DOMAINS[name];
  if (provider && !provider.domains.includes(domain)) {
    const likely = `${local}@${provider.domains[0]}`;
    return { explanation: `"${domain}" is not a ${provider.label} address — probably ${likely}.`, likely };
  }
  const meant = PROVIDER_MISSPELLINGS[name];
  if (meant) {
    const likely = `${local}@${meant}`;
    return { explanation: `"${domain}" looks like a misspelling — probably ${likely}.`, likely };
  }
  return null;
}
