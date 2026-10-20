/**
 * Employee Master: type the national ID and the fields it already states fill themselves.
 *
 * The 14-digit Egyptian ID encodes the date of birth (digits 2-7, century from digit 1), the
 * governorate of registration (digits 8-9) and the sex (digit 13). `parseEgyptianNationalId` is the
 * one reader of that layout — it returns null on anything it cannot fully account for — and this
 * module only decides what the Employee Master FORM does with a reading.
 *
 * The rule is the reader's own: fill a blank, never overwrite an answer. A value HR typed stays
 * where it is even when the ID disagrees, because one of the two is a typo and nothing here can
 * know which; the form says the ID reads differently and offers the ID's value as a click.
 * The one value that may be replaced without asking is one the PREVIOUS reading of the ID placed
 * there — so correcting a mistyped ID moves the date it had filled, and nothing HR wrote.
 */

import { parseEgyptianNationalId } from "@/lib/hiring-pack/national-id";

/** The four form fields this module reads and writes. All are plain strings in the form state. */
export type NationalIdFormFields = {
  nationalId: string;
  gender: string;
  birthDate: string;
  birthPlace: string;
};

export type NationalIdDerivedField = "gender" | "birthDate" | "birthPlace";

const DERIVED_FIELDS: readonly NationalIdDerivedField[] = ["gender", "birthDate", "birthPlace"];

/** What the ID states, in the exact spelling the form stores. Null where the ID states nothing. */
export type NationalIdReading = {
  gender: string;
  birthDate: string;
  /** The governorate in Arabic, as the form's Birth Place already holds it. Null for "born abroad". */
  birthPlace: string | null;
};

export function readNationalIdForForm(nationalId: string | null | undefined): NationalIdReading | null {
  const facts = parseEgyptianNationalId(nationalId);
  if (!facts) return null;
  return {
    gender: facts.sex,
    birthDate: facts.birthDate,
    // Born abroad (code 88) carries no governorate — the person has to say where.
    birthPlace: facts.governorateEn === null ? null : facts.governorateAr,
  };
}

/**
 * The form after the national ID box changed to `nextNationalId`.
 *
 * A field is filled when it is blank, or when it still holds exactly what the previous reading of
 * the ID put there. An ID that is incomplete or unreadable changes nothing but the ID itself, so
 * deleting a digit never wipes the date.
 */
export function applyNationalIdRead<T extends NationalIdFormFields>(form: T, nextNationalId: string): T {
  const previous = readNationalIdForForm(form.nationalId);
  const next = readNationalIdForForm(nextNationalId);
  const patch: Partial<NationalIdFormFields> = { nationalId: nextNationalId };

  if (next) {
    for (const field of DERIVED_FIELDS) {
      const wanted = next[field];
      if (wanted === null) continue;
      const current = form[field].trim();
      const placedByPreviousReading = previous !== null && previous[field] === current;
      if (current === "" || placedByPreviousReading) patch[field] = wanted;
    }
  }

  return { ...form, ...patch };
}

/** One line under a field: it was read from the ID, or the ID reads something else. */
export type NationalIdNote = {
  field: NationalIdDerivedField;
  kind: "fromId" | "differs";
  text: string;
  /** What the ID states — the value a "use it" click writes. */
  value: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `1994-07-03` → `3 July 1994`. Locale-free on purpose: the same words on every machine. */
export function longIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * The notes to print under the gender, birth date and birth place boxes.
 *
 * Birth Place is free text that usually carries the district after the governorate
 * ("الدقهلية - ميت غمر"), so it only ever gets a "read from the ID" note or an offer to fill a
 * blank — a typed place is never reported as a disagreement.
 */
export function nationalIdNotes(form: NationalIdFormFields): NationalIdNote[] {
  const reading = readNationalIdForForm(form.nationalId);
  if (!reading) return [];

  const notes: NationalIdNote[] = [];

  if (form.gender === reading.gender) {
    notes.push({ field: "gender", kind: "fromId", text: "Read from the national ID.", value: reading.gender });
  } else {
    notes.push({ field: "gender", kind: "differs", text: `The national ID reads ${reading.gender}.`, value: reading.gender });
  }

  if (form.birthDate === reading.birthDate) {
    notes.push({ field: "birthDate", kind: "fromId", text: "Read from the national ID.", value: reading.birthDate });
  } else {
    notes.push({
      field: "birthDate",
      kind: "differs",
      text: `The national ID reads ${longIsoDate(reading.birthDate)}.`,
      value: reading.birthDate,
    });
  }

  if (reading.birthPlace !== null) {
    const place = form.birthPlace.trim();
    if (place === reading.birthPlace) {
      notes.push({ field: "birthPlace", kind: "fromId", text: "Governorate read from the national ID — add the district if you wish.", value: reading.birthPlace });
    } else if (place === "") {
      notes.push({ field: "birthPlace", kind: "differs", text: `The national ID reads ${reading.birthPlace}.`, value: reading.birthPlace });
    }
  }

  return notes;
}
