import { canonicalHrIdKey } from "@/lib/hr-id";
import type { EmployeeImportIssue } from "@/lib/imports/employee-import-types";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// "Is this nickname actually somebody else's name?" — the pure half of the employee importer's
// nickname guard.
//
// employees.nickname is the DISPLAY name, not a decoration: resolveEmployeeDisplayName returns it
// in preference to full_name, so whatever lands in that column is what every screen in the app
// calls that person. On 2026-08-05 a 116-row master import whose Nickname column was shifted by a
// row wrote four new hires' names onto six existing employees; each silently became someone else
// app-wide, and a District Manager's direct order showed the National Sales Manager as its
// requester for hours before anyone read the row by hand.
//
// This lives apart from employee-validator.ts for two reasons. validateEmployeeImportRows is
// already very large, and inlining the index-building there pushed its cognitive complexity past
// what the quality gate allows. More importantly, the two halves of this guard run in different
// places — the validator indexes the uploaded FILE, employee-import-existing-state.ts indexes the
// live DIRECTORY — and they must agree byte-for-byte on how a name is normalized. Both now call
// personNameKey here, so they cannot drift apart the way two copies of a regex silently would.
//
// Everything in this module is pure: no database, no I/O, directly unit-testable.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The ONE definition of "same name" this guard uses: whitespace-collapsed and lowercased, so
 * "magdy  el senosey" and "Magdy El Senosey" are the same person. Null for a blank name — an
 * absent name is not a collision with anything.
 */
export function personNameKey(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return normalized || null;
}

/**
 * Record `hrId` as a holder of `fullName` in a directory-side index.
 *
 * A full name is NOT unique — two live employees genuinely share one (Gannatallah Amer is both
 * PD-0008 and B-165) — so holders accumulate into a list rather than overwriting. Collapsing them
 * would make whichever row loaded second look like an impostor.
 */
export function addFullNameHolder(
  index: Map<string, string[]>,
  fullName: string | null | undefined,
  hrId: string | null | undefined,
): void {
  const nameKey = personNameKey(fullName);
  const storedHrId = String(hrId ?? "").trim();
  if (!nameKey || !storedHrId) return;
  const holders = index.get(nameKey);
  if (holders) holders.push(storedHrId);
  else index.set(nameKey, [storedHrId]);
}

/**
 * Name -> the canonical HR_ID keys carrying it, merged from the uploaded file AND the live
 * directory. Both sources matter: a full-master upload collides within itself, while a partial
 * upload only collides against people who are not in the file at all.
 */
export function buildPersonNameIndex(params: {
  existingHrIdsByFullNameKey?: Map<string, string[]>;
  records: Array<{ fullName: string | null; hrId: string | null; rowType: string }>;
}): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  const add = (name: string | null | undefined, hrId: string | null | undefined) => {
    const nameKey = personNameKey(name);
    const hrIdKey = canonicalHrIdKey(hrId ?? "");
    if (!nameKey || !hrIdKey) return;
    const holders = index.get(nameKey);
    if (holders) holders.add(hrIdKey);
    else index.set(nameKey, new Set([hrIdKey]));
  };

  for (const record of params.records) {
    if (record.rowType === "employee") add(record.fullName, record.hrId);
  }
  for (const [nameKey, hrIds] of params.existingHrIdsByFullNameKey ?? []) {
    for (const hrId of hrIds) add(nameKey, hrId);
  }

  return index;
}

/**
 * The HR_IDs that own `nickname` when it is somebody ELSE's real name — or null when the nickname
 * is safe to import.
 *
 * Safe means one of: nobody is named that (an ordinary short form like "Dina Fadel"), or this
 * employee is themselves among the holders. Both matter in live data — 11 employees are stored
 * with their own full name as their nickname, and 21 carry a short form — so a guard that refused
 * either would block routine imports rather than the dangerous one.
 */
export function findNicknameOwners(params: {
  hrId: string | null | undefined;
  index: Map<string, Set<string>>;
  nickname: string | null | undefined;
}): string[] | null {
  const nicknameKey = personNameKey(params.nickname);
  const ownHrIdKey = canonicalHrIdKey(params.hrId ?? "");
  if (!nicknameKey || !ownHrIdKey) return null;

  const holders = params.index.get(nicknameKey);
  if (!holders || holders.has(ownHrIdKey)) return null;

  return Array.from(holders).map((key) => key.toUpperCase()).sort();
}

/**
 * Record an employee's STORED nickname in a directory-side index: canonical HR_ID key ->
 * personNameKey of the nickname. A blank nickname or HR_ID records nothing — an employee with no
 * saved nickname cannot already be carrying the one a file brings.
 */
export function addStoredNickname(
  index: Map<string, string>,
  hrId: string | null | undefined,
  nickname: string | null | undefined,
): void {
  const hrIdKey = canonicalHrIdKey(hrId ?? "");
  const nicknameKey = personNameKey(nickname);
  if (!hrIdKey || !nicknameKey) return;
  index.set(hrIdKey, nicknameKey);
}

/**
 * The nickname guard's verdict for one uploaded row, as import issues.
 *
 * A nickname that is somebody else's real name is an ERROR, and the validator refuses the whole
 * row for it. The one exception is the nickname this employee ALREADY carries in the directory:
 * importing it renames nobody. Refusing it anyway blocked that employee's row on every upload with
 * an error the file could never clear — on 2026-09-15 a Pedia rep's saved nickname was also a
 * colleague's full name. That case is a WARNING and the row imports.
 *
 * The exception trusts the directory, never the file: a nickname a shifted column would newly write
 * is still refused, and a new hire has no saved nickname to match.
 */
export function nicknameCollisionIssues(params: {
  hrId: string | null | undefined;
  index: Map<string, Set<string>>;
  nickname: string | null | undefined;
  rowNumber: number;
  storedNicknameKeyByHrIdKey?: Map<string, string>;
}): { errors: EmployeeImportIssue[]; warnings: EmployeeImportIssue[] } {
  const owners = findNicknameOwners(params);
  if (!owners) return { errors: [], warnings: [] };

  const storedNicknameKey = params.storedNicknameKeyByHrIdKey?.get(canonicalHrIdKey(params.hrId ?? "") ?? "");
  if (storedNicknameKey && storedNicknameKey === personNameKey(params.nickname)) {
    return {
      errors: [],
      warnings: [
        {
          rowNumber: params.rowNumber,
          field: "nickname",
          code: "nickname_shared_with_another_employee",
          message: `Nickname "${params.nickname}" is also another employee's full name, so the two can look like the same person on screen. It is already this employee's saved nickname, so the import keeps it and renames nobody — give this employee a nickname of their own to tell them apart.`,
        },
      ],
    };
  }

  return {
    errors: [
      {
        rowNumber: params.rowNumber,
        field: "nickname",
        code: "nickname_is_another_employees_name",
        message: `Nickname "${params.nickname}" is ${owners.join(", ")}'s real name, not ${params.hrId}'s. A nickname is the name every screen shows, so importing this would rename someone. This normally means a column in the file is shifted by a row — fix the file, or clear this nickname cell if the two people genuinely share a name.`,
      },
    ],
    warnings: [],
  };
}
