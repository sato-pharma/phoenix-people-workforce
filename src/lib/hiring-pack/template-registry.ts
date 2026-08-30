/**
 * THE ARCHIVE — every version of every paper this module prints, current and superseded.
 *
 * Built 2026-08-30 on the owner's instruction, when he replaced the employment contract: "make the
 * other contract go to archived instead of removing it from system. Make a thing called archived …
 * and any paper I replace, it goes to the archive."
 *
 * So this is deliberately wider than the contract. All five documents are registered from day one,
 * each at the version it is on today, because the mechanism has to exist BEFORE the next form is
 * replaced. A registry that only knows about the one document that has already changed is a
 * registry somebody has to remember to extend, and the whole point of the instruction is that this
 * happens every time, not when someone thinks of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ARCHIVED IS A DESTINATION, NOT A WAITING ROOM. Nothing is ever removed from this list. A
 * superseded template stays whole and stays printable, for a reason that is easy to miss until it
 * bites: these are papers people SIGN. A contract signed in August against version 1 has to be
 * reproducible as the document that was actually signed — not as today's text with today's clauses.
 * Deleting a version does not tidy the code, it destroys the only record of what somebody agreed
 * to, and it does so silently, because the reprint still produces a plausible-looking contract.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE IS AND IS NOT. It is metadata: which versions exist, which one is current, when
 * each took over and what replaced it. The documents themselves live where they always did — the
 * contract's text in `contract-text-v1.ts` / `contract-text-v2.ts`, the government forms as their
 * own artwork and placement tables. Status lives here and only here, so "which version prints
 * today" has exactly one answer and cannot drift between a template file and a renderer.
 */

import type { HiringPackDocument } from "./types";

/**
 * Whether a version is the one that prints today.
 *
 * Exactly one `current` per document, always — enforced by `currentTemplateVersion`, which throws
 * rather than guessing. Two current versions is not a state anyone can resolve from a screen: it
 * means two different papers both claim to be the contract, and picking either one silently is how
 * the wrong text reaches a signature page.
 */
export type TemplateStatus = "current" | "archived";

export type DocumentTemplateVersion = {
  /**
   * Stable identity, unique across every document.
   *
   * NEVER RENAME OR REUSE ONE. It is written onto the employee row when a document is signed, and a
   * reprint resolves the version through it — so an id that changes meaning reprints somebody's
   * contract as a document they never saw, with no error anywhere.
   */
  id: string;
  document: HiringPackDocument;
  version: number;
  status: TemplateStatus;
  /** What this version is called in the Archived list. */
  labelEn: string;
  labelAr: string;
  /** The day this version became the one Phoenix prints. */
  effectiveFrom: string;
  /** The day it stopped, on an archived version. Null while it is current. */
  supersededOn: string | null;
  /** The id of the version that replaced it. Null while it is current. */
  supersededBy: string | null;
  /** Why it changed, or what it is — shown in the Archive so the record explains itself. */
  note: string;
};

/**
 * Every version, in document order then version order.
 *
 * ADDING A REPLACEMENT is two edits and never a deletion: mark the outgoing row `archived` with its
 * `supersededOn` and `supersededBy` filled in, and append the new row as `current`. The test suite
 * checks both halves — that exactly one version of each document is current, and that no id ever
 * disappears between commits.
 */
export const DOCUMENT_TEMPLATE_VERSIONS: readonly DocumentTemplateVersion[] = [
  {
    id: "contract-v1",
    document: "contract",
    version: 1,
    status: "archived",
    labelEn: "Employment contract — 2026 edition",
    labelAr: "عقد عمل محدد المدة — إصدار 2026",
    effectiveFrom: "2026-08-22",
    supersededOn: "2026-08-30",
    supersededBy: "contract-v2",
    note: "The first contract Phoenix printed. Replaced by the owner's redrafted text on 2026-08-30. Kept printable: contracts signed against it must reproduce as the document that was signed.",
  },
  {
    id: "contract-v2",
    document: "contract",
    version: 2,
    status: "current",
    labelEn: "Employment contract — redrafted, Labour Law 14/2025",
    labelAr: "عقد عمل محدد المدة — محرر طبقًا لقانون العمل 14 لسنة 2025",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "Supplied by the owner as a Word document on 2026-08-30. Nineteen titled articles, a banded layout, and a fuller company recital carrying the commercial register, unified register and tax card.",
  },
  {
    id: "form1-v1",
    document: "form1",
    version: 1,
    status: "current",
    labelEn: "Social insurance Form 1 — insured person's subscription request",
    labelAr: "استمارة 1 تأمينات — طلب اشتراك مؤمن عليه",
    effectiveFrom: "2026-08-22",
    supersededOn: null,
    supersededBy: null,
    note: "The Authority's own form, reproduced as artwork with values placed on it. Replaced only when the Authority itself issues a new one.",
  },
  {
    id: "custody-laptop-v1",
    document: "custodyLaptop",
    version: 1,
    status: "current",
    labelEn: "Custody receipt — laptop",
    labelAr: "إقرار استلام عهدة — نموذج رقم 1 (حاسب محمول)",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "Sato's own instrument, supplied by the owner on 2026-08-30. Fifteen undertakings in four groups, three signatures and a return protocol. The device details print blank: Phoenix holds no asset register, and a serial number is read off the machine, not recalled.",
  },
  {
    id: "custody-mobile-v1",
    document: "custodyMobile",
    version: 1,
    status: "current",
    labelEn: "Custody receipt — phone or tablet",
    labelAr: "إقرار استلام عهدة — نموذج رقم 2 (هاتف / جهاز لوحي)",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The same instrument as the laptop receipt, with the phone's own item list and an IMEI and SIM block in place of the Windows fields. Both forms are current at once — which one prints depends on the device, not on the year.",
  },
  {
    id: "form6-v1",
    document: "form6",
    version: 1,
    status: "current",
    labelEn: "Social insurance Form 6 — notice of end of subscription",
    labelAr: "استمارة 6 تأمينات — إخطار بإنتهاء اشتراك مؤمن عليه",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The Authority's own form, reproduced as artwork with values placed on it. Replaced only when the Authority itself issues a new one.",
  },
  {
    id: "resignation-v1",
    document: "resignation",
    version: 1,
    status: "current",
    labelEn: "Ministry of Labour — resignation request",
    labelAr: "نموذج وزارة العمل — طلب استقالة",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The Ministry's own template under مادة 167 and decree 187/2025. Replaced only when the Ministry itself issues a new one.",
  },
  {
    id: "mutualTermination-v1",
    document: "mutualTermination",
    version: 1,
    status: "current",
    labelEn: "Ministry of Labour — mutual termination agreement",
    labelAr: "نموذج وزارة العمل — اتفاق إنهاء عقد عمل بالتراضي",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The Ministry's own template. The alternative to a resignation, never printed alongside one. Replaced only when the Ministry itself issues a new one.",
  },
  {
    id: "clearance-employee-v1",
    document: "clearanceEmployee",
    version: 1,
    status: "current",
    labelEn: "Clearance — the company certifies the employee is clear",
    labelAr: "إخلاء طرف موظف",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "Sato's own instrument, not a government form — so unlike Form 6 or the labour templates it is revised here whenever the owner revises the paper, and the superseded wording is archived rather than overwritten. Seven departments sign it, HR signs it, the company stamps it, and the employee keeps the original.",
  },
  {
    id: "clearance-company-v1",
    document: "clearanceCompany",
    version: 1,
    status: "current",
    labelEn: "Clearance — the employee releases the company",
    labelAr: "إخلاء طرف شركة",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The other half of the clearance pair, and a release of claims: the employee signs that the settlement figure written on it discharges everything owed for the whole period of employment. A COMPLEMENT of the employee clearance and never an alternative — both are signed, days apart. The company files it.",
  },
];

/** Every version of one document, newest first. */
export function templateVersionsFor(document: HiringPackDocument): DocumentTemplateVersion[] {
  return DOCUMENT_TEMPLATE_VERSIONS.filter((entry) => entry.document === document).sort(
    (a, b) => b.version - a.version,
  );
}

/**
 * The version of a document that prints today.
 *
 * Throws when there is not exactly one, rather than returning the first match. A registry with two
 * current contracts is a mistake nobody can see from a screen — both look right — so it has to stop
 * at the point it is discovered, not at the point somebody signs the wrong one.
 */
export function currentTemplateVersion(document: HiringPackDocument): DocumentTemplateVersion {
  const current = DOCUMENT_TEMPLATE_VERSIONS.filter(
    (entry) => entry.document === document && entry.status === "current",
  );
  if (current.length !== 1) {
    throw new Error(
      `Expected exactly one current template for ${document}, found ${current.length}. ` +
        "Replacing a document means archiving the outgoing version, never leaving two current.",
    );
  }
  return current[0];
}

/** Everything that has been superseded, newest supersession first. This is the Archive list. */
export function archivedTemplateVersions(): DocumentTemplateVersion[] {
  return DOCUMENT_TEMPLATE_VERSIONS.filter((entry) => entry.status === "archived").sort((a, b) =>
    (b.supersededOn ?? "").localeCompare(a.supersededOn ?? ""),
  );
}

/** One version by id, or null. Null means "an id nobody recognises", never "deleted". */
export function findTemplateVersion(id: string): DocumentTemplateVersion | null {
  return DOCUMENT_TEMPLATE_VERSIONS.find((entry) => entry.id === id) ?? null;
}

/**
 * Which version to print for a document, given what a signed record says.
 *
 * `signedVersionId` is what was stored when the paper was signed. A reprint of a signed document
 * reproduces THAT version; everything else gets the current one. An unrecognised id falls back to
 * current rather than throwing, because a stored id from a future branch must not make an
 * employee's file unprintable — but the caller is told, so the screen can say which it used.
 */
export function resolveTemplateVersion(
  document: HiringPackDocument,
  signedVersionId: string | null | undefined,
): { version: DocumentTemplateVersion; reproducedFromSignature: boolean } {
  if (signedVersionId) {
    const stored = findTemplateVersion(signedVersionId);
    if (stored && stored.document === document) {
      return { version: stored, reproducedFromSignature: true };
    }
  }
  return { version: currentTemplateVersion(document), reproducedFromSignature: false };
}
