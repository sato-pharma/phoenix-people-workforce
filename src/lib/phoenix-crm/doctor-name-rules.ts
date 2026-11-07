import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import {
  COMPOUND_HEADS,
  COMPOUND_TAILS,
  nameWordIsThere,
  PLATE_TITLES,
  personNameWords,
  type NameWord,
} from "@/lib/phoenix-crm/signboard-rules";

/**
 * 🔴 A CLINIC DOCTOR'S NAME IS HIS FIRST, MIDDLE AND LAST NAME — THREE FIELDS, ALL REQUIRED (owner,
 * 2026-11-07: "drs name in clinic or polyclinic u will make the name field 3 fields required … first
 * midle and last"). Measured the same day on production: 1,223 PM doctors a rep added himself carried
 * one or two words ("طارق", "احمد", "عمر حردان"), 618 of them already validated. AM accounts, a
 * hospital or a centre on the morning list, and pharmacies keep their one name field.
 *
 * 🔴 A DOCTOR A REP ADDED WITH A SHORT NAME IS BLOCKED — never planned and never visited — until the rep
 * writes the full name (owner's choice, "Rep-added, all statuses"). The SFE's imported list is NOT
 * blocked: its names came from the old system, not from the rep. A full name waiting for the Super
 * Admin's decision unblocks him, so the rep is never held up by the wait.
 *
 * 🔴 THE FULL NAME IS HELD AGAINST THE SIGNBOARD OR TIMETABLE ALREADY READ FOR HIM, "DO NOT STRICT
 * REJECTION OR FOOLISH APPROVALS": 60% or more is saved, under 40% is refused, and in between it waits
 * for the Super Admin. The percentage is counted over the words the BOARD shows, because "some
 * signboards have only 2 names and i asking for 3" — a two-name plate matching both is 100%. A board
 * showing one word cannot confirm three (50%, so it waits), and a name whose given name is not on the
 * board never passes on its father's and family name alone.
 */

export type DoctorNameParts = { first: string; middle: string; last: string };

export const EMPTY_DOCTOR_NAME: DoctorNameParts = { first: "", middle: "", last: "" };

export const DOCTOR_NAME_FIELDS: ReadonlyArray<{ key: keyof DoctorNameParts; label: string }> = [
  { key: "first", label: "First name" },
  { key: "middle", label: "Middle name" },
  { key: "last", label: "Last name" },
];

/** A full name saved at once. */
export const FULL_NAME_APPROVE_AT = 60;
/** Below this the name is refused; between the two it waits for the Super Admin. */
export const FULL_NAME_REFUSE_BELOW = 40;

/** What the rep reads when the name does not match the board. His own fix, never who checked. */
export const FULL_NAME_REFUSED =
  "This name does not match the name on the doctor's signboard. Write the doctor's first, middle and last name as the sign shows them.";

/** What the plan and Add visit say about a blocked doctor: the way out, in his own words. */
export function fullNameNeededSentence(name: string): string {
  return `${name} needs a full name first. Open this doctor in your list, tap Change the details and write the first, middle and last name.`;
}

/** The short label beside a blocked doctor in a picker. */
export const FULL_NAME_NEEDED_TAG = "Needs the full name";

// Words that name a place, never a person — "مستشفي" and "عيادة كيان" were typed as doctors' names.
// Folded the way `normalizeContactName` folds them (ة→ه, ى→ي, lower case).
const PLACE_WORDS: ReadonlySet<string> = new Set([
  "مستشفي",
  "مستشفيات",
  "عياده",
  "عيادات",
  "مركز",
  "صيدليه",
  "مستوصف",
  "حضانه",
  "حضانات",
  "جمعيه",
  "بوليكلينك",
  "بولي",
  "مجمع",
  "طوارئ",
  "طواري",
  "وحده",
  "تعاقد",
  "شركه",
  "مخزن",
  "معمل",
  "hospital",
  "clinic",
  "polyclinic",
  "center",
  "centre",
  "pharmacy",
  "lab",
]);

const ARABIC_LETTERS = /^[ء-ي٠-٩ٮ-ۓۺ-ۿً-ٰٟـ]+$/;
const LATIN_LETTERS = /^[A-Za-z'-]+$/;

function cleanPart(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Why one field is not a name, or null. A compound written with a space (عبد العزيز, نور الدين) is one
 * name; any other space means two names in one field.
 */
export function doctorNamePartProblem(value: unknown, label: string): string | null {
  const part = cleanPart(value);
  if (!part) return `Write the doctor's ${label.toLowerCase()}.`;
  const words = personNameWords(part);
  if (words.length === 0) return `Write the ${label.toLowerCase()} without Dr or د.`;
  if (words.length > 1) return `Write one name in ${label}. Use the other boxes for the rest of the name.`;
  const raw = part.split(" ");
  for (const word of raw) {
    const plain = word.replace(/[.‏‎]/g, "");
    if (!plain) continue;
    if (!ARABIC_LETTERS.test(plain) && !LATIN_LETTERS.test(plain)) return `${label} can hold letters only.`;
    if (LATIN_LETTERS.test(plain) && !/[aeiouy]/i.test(plain)) return `${label} does not look like a name. Write it as the sign shows it.`;
  }
  const folded = normalizeContactName(part);
  if (folded.replace(/\s/g, "").length < 2) return `${label} is too short to be a name.`;
  if (/(.)\1\1/u.test(folded.replace(/\s/g, ""))) return `${label} does not look like a name. Write it as the sign shows it.`;
  if (folded.split(" ").some((word) => PLACE_WORDS.has(word))) {
    return `${label} names a place, not a doctor. Write the doctor's own name.`;
  }
  return null;
}

/** The three fields as one name, or why not. */
export function doctorFullNameProblem(parts: DoctorNameParts): string | null {
  for (const field of DOCTOR_NAME_FIELDS) {
    const problem = doctorNamePartProblem(parts[field.key], field.label);
    if (problem) return problem;
  }
  return null;
}

export function joinDoctorName(parts: DoctorNameParts): string {
  return [parts.first, parts.middle, parts.last].map(cleanPart).filter(Boolean).join(" ");
}

/** The words of a name as the plate check counts them: untitled, each compound one word. */
export function doctorNameWordCount(name: string | null | undefined): number {
  return personNameWords(name ?? "").length;
}

/** Parse the three fields a caller sent, or — from a caller one release behind — a whole name. */
export function parseDoctorFullName(
  nameParts: unknown,
  name: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (nameParts && typeof nameParts === "object") {
    const body = nameParts as Record<string, unknown>;
    const parts: DoctorNameParts = { first: cleanPart(body.first), middle: cleanPart(body.middle), last: cleanPart(body.last) };
    const problem = doctorFullNameProblem(parts);
    return problem ? { ok: false, error: problem } : { ok: true, value: joinDoctorName(parts) };
  }
  const whole = cleanPart(name);
  if (doctorNameWordCount(whole) < 3) return { ok: false, error: "Write the doctor's first, middle and last name." };
  return { ok: true, value: whole };
}

/**
 * A name split into the three boxes, to open the edit on what he already wrote: the leading title off,
 * a compound kept together, the last word in Last and a missing word left empty for him to fill.
 */
export function splitDoctorName(name: string | null | undefined): DoctorNameParts {
  const tokens = cleanPart(name)
    .replace(/^(?:د\s*[./\\]\s*|dr\.?\s*)/i, "")
    .split(" ")
    .filter(Boolean);
  const groups: string[][] = [];
  let open = false;
  for (const token of tokens) {
    const folded = normalizeContactName(token);
    if (!folded || PLATE_TITLES.has(folded)) continue;
    const last = groups[groups.length - 1];
    if (last && (open || COMPOUND_TAILS.has(folded))) {
      open = open && COMPOUND_HEADS.has(folded);
      last.push(token);
      continue;
    }
    groups.push([token]);
    open = COMPOUND_HEADS.has(folded);
  }
  const words = groups.map((group) => group.join(" "));
  if (words.length === 0) return { ...EMPTY_DOCTOR_NAME };
  if (words.length === 1) return { first: words[0], middle: "", last: "" };
  if (words.length === 2) return { first: words[0], middle: "", last: words[1] };
  return { first: words[0], middle: words[1], last: words.slice(2).join(" ") };
}

/**
 * Is this doctor blocked from the plan and Add visit until his full name is written? A PM doctor the
 * rep added himself, still on the list, with fewer than three names and no full name waiting for the
 * Super Admin.
 */
export function doctorNeedsFullName(customer: {
  listType: unknown;
  origin: unknown;
  status: unknown;
  name: unknown;
  fullNameHeld?: unknown;
}): boolean {
  if (String(customer.listType ?? "").toUpperCase() !== "PM") return false;
  if (customer.origin !== "new") return false;
  if (customer.status === "dropped") return false;
  if (typeof customer.fullNameHeld === "string" && customer.fullNameHeld.trim()) return false;
  return doctorNameWordCount(String(customer.name ?? "")) < 3;
}

/** The person names a stored signboard or timetable reading holds — what the full name is held against. */
export function boardNamesOf(reading: unknown): string[] {
  if (!reading || typeof reading !== "object") return [];
  const body = reading as Record<string, unknown>;
  const names: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) names.push(value.trim());
  };
  if (Array.isArray(body.personNames)) body.personNames.forEach(add);
  if (Array.isArray(body.signs)) {
    for (const sign of body.signs) {
      if (sign && typeof sign === "object" && Array.isArray((sign as Record<string, unknown>).personNames)) {
        ((sign as Record<string, unknown>).personNames as unknown[]).forEach(add);
      }
    }
  }
  // A signboard whose reader split out no person name still carries its whole text. A timetable's whole
  // text is never used: it lists many doctors, and their words would add up to anybody's name.
  if (names.length === 0) add(body.signText);
  return names;
}

function oneBoardScore(typed: readonly NameWord[], board: readonly NameWord[]): number {
  if (typed.length === 0 || board.length === 0) return 0;
  const counted = Math.max(2, Math.min(board.length, typed.length));
  const matched = Math.min(board.filter((word) => nameWordIsThere(word, typed)).length, counted);
  let score = (matched / counted) * 100;
  // His father's and family name behind another given name is another doctor.
  if (!nameWordIsThere(typed[0], board)) score = Math.min(score, 50);
  return Math.round(score);
}

/** How far the full name matches what was read off his board, 0–100; null when nothing was read. */
export function fullNameMatchPercent(fullName: string, boardNames: readonly string[]): number | null {
  const typed = personNameWords(fullName);
  const boards = boardNames.map((name) => personNameWords(name)).filter((words) => words.length > 0);
  if (typed.length === 0 || boards.length === 0) return null;
  return Math.max(...boards.map((board) => oneBoardScore(typed, board)));
}

export type FullNameRuling = "save" | "hold" | "refuse";

/**
 * Save, hold for the Super Admin, or refuse. With nothing read off a board: a doctor not validated yet
 * is saved, because his door will hold the name against the sign; a validated one waits for the Super
 * Admin, because nothing else will ever look.
 */
export function fullNameRuling(percent: number | null, validated: boolean): FullNameRuling {
  if (percent === null) return validated ? "hold" : "save";
  if (percent >= FULL_NAME_APPROVE_AT) return "save";
  if (percent < FULL_NAME_REFUSE_BELOW) return "refuse";
  return "hold";
}

/**
 * A clinic doctor's full name that matched his signboard 40–59%, or a validated doctor whose board was
 * never read — waiting for a person (owner, 2026-11-07, doctor-name-rules.ts). The same people decide it
 * as decide Place checks: the Super Admin and the SFE Manager. The rep is never told it waits; the doctor
 * is not blocked meanwhile.
 */
export type HeldFullName = {
  customerId: string;
  currentName: string;
  fullName: string;
  /** How far it matched the board, 0–100; null when nothing was read off one. */
  percent: number | null;
  boardNames: string[];
  repName: string;
  heldAt: string;
  isTest: boolean;
};
