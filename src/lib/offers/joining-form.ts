import { EGYPT_GOVERNORATES } from "@/lib/geo/egypt-locations";
import { isMedicalRepJobTitle } from "@/lib/crm/medical-rep";
import type { OfferStatus } from "@/lib/offers/types";

/**
 * The candidate's joining form — the page the offer email's Accept button opens (owner,
 * 2026-10-08). PURE: what the form asks, how an answer is checked, and when the form may be filled.
 * The I/O is in ./joining-form-service.ts.
 *
 * ── Submit IS the acceptance ──
 * "The acceptance is considered acceptance when he filled the data and submit." Opening the link
 * changes nothing (a mail scanner opens every link), and a half-filled form is not a yes. Pressing
 * Submit with every field valid creates the employee record and marks the offer accepted, in that
 * order, once.
 *
 * ── What he types, and what he only reads ──
 * He READS what the offer and its seat already settle: name, HR ID, job, department, line, area,
 * region, manager, hiring date, contract type, Sato email and the salary lines. He TYPES only what
 * nobody at the company can know: mobile, private email, national ID, gender, date of birth,
 * education and where he lives. Declining is not on the page at all — the email tells him to reply.
 */

/** Sales offers must name their organogram seat (owner, 2026-10-08: "for sales team only, medical reps or district managers, seat is required"). */
const DISTRICT_MANAGER_TITLE = /\bdistrict\s+(sales\s+)?manager\b|\bdsm\b|\bdistrict\s+manager\b/i;

export function offerRequiresSeat(title: string | null | undefined): boolean {
  const value = String(title ?? "").trim();
  if (!value) return false;
  return isMedicalRepJobTitle(value) || DISTRICT_MANAGER_TITLE.test(value);
}

/**
 * Payment mode is fixed by title (owner, 2026-10-08): the field force — Medical Representatives and
 * District Managers, Senior included — is paid in two parts, every other title in one part. Without
 * this the record took Add Employee's "two parts" default, wrong for every office joiner.
 */
export function joiningFormPaymentMode(title: string | null | undefined): "one_part" | "two_parts" {
  return offerRequiresSeat(title) ? "two_parts" : "one_part";
}

export const OFFER_SEAT_REQUIRED_MESSAGE =
  "A Medical Representative or District Manager offer must name its seat in the organogram before it is sent, so the joining form can place the new hire in it.";

/**
 * Every offer leaves with a start date (owner, 2026-10-08, after one went out without one and its
 * joining-form button could only say "being confirmed"). The joining form records it as the new
 * hire's first day and refuses to make a record without it, so a letter with no date would hand the
 * candidate a button that can never work.
 */
export const OFFER_START_DATE_REQUIRED_MESSAGE =
  "An offer must have a start date before it is sent, so the joining form can record the new hire's first day.";

export type JoiningFormState =
  | "open"
  | "submitted"
  | "withdrawn"
  | "declined"
  | "not_sent"
  | "being_updated"
  | "seat_unavailable"
  | "start_date_pending";

/**
 * Whether the form may be filled. The token only says the link is genuine; this is the authority.
 * An offer HR already marked accepted by hand (a candidate who replied "yes") still takes the form,
 * until a record has been made from it.
 */
export function joiningFormState(input: {
  employeeHrId: string | null;
  requiresSeat: boolean;
  /** Above 0 once HR has updated the offer (owner, 2026-11-10). Absent reads as never updated. */
  revision?: number;
  seatOpen: boolean;
  status: OfferStatus;
}): JoiningFormState {
  if (input.employeeHrId) return "submitted";
  if (input.status === "withdrawn") return "withdrawn";
  if (input.status === "declined") return "declined";
  // Waiting for the HR Manager is not sent either (owner, 2026-11-10): nothing reached the candidate.
  // An offer HR is UPDATING went out once, so the candidate holds a link: it says the offer is being
  // updated, and the old terms cannot be accepted while new ones are being written.
  if (input.status === "draft" || input.status === "pending_approval") {
    return input.revision && input.revision > 0 ? "being_updated" : "not_sent";
  }
  if (input.requiresSeat && !input.seatOpen) return "seat_unavailable";
  return "open";
}

export const JOINING_FORM_STATE_MESSAGE: Record<Exclude<JoiningFormState, "open">, { body: string; title: string }> = {
  declined: {
    body: "This offer was recorded as declined. If that is not right, please reply to the offer email and our HR team will help.",
    title: "This offer was declined",
  },
  not_sent: {
    body: "This offer has not been issued yet. Please use the link in the offer email you receive.",
    title: "This offer is not open yet",
  },
  being_updated: {
    body: "Our HR team is updating your offer. You will receive the updated offer by email shortly; please use the button in that email.",
    title: "Your offer is being updated",
  },
  seat_unavailable: {
    body: "Our HR team needs to confirm your position before you can complete this form. They will contact you shortly — you can also reply to the offer email.",
    title: "Your position is being confirmed",
  },
  // An offer sent before a start date was required: no first day, so no record can be made yet.
  start_date_pending: {
    body: "Our HR team needs to confirm your start date before you can complete this form. They will contact you shortly — you can also reply to the offer email.",
    title: "Your start date is being confirmed",
  },
  submitted: {
    body: "Your joining form has been received and your employee record is ready. Our HR team will be in touch before your first day.",
    title: "You have already completed this form",
  },
  withdrawn: {
    body: "This offer is no longer open. If you have questions, please reply to the offer email.",
    title: "This offer has been withdrawn",
  },
};

export const JOINING_FORM_EDUCATION_OPTIONS = [
  "Pharmacy",
  "Science",
  "Veterinary Medicine",
  "Medicine",
  "Dentistry",
  "Commerce",
  "Business Administration",
  "Arts",
  "Law",
  "Engineering",
  "Other",
] as const;

export const JOINING_FORM_GENDER_OPTIONS = [
  { label: "Male", value: "male" },
  { label: "Female", value: "female" },
] as const;

/** The 27 governorates. `value` is the Arabic spelling the Employee Master stores in residence_city. */
export const JOINING_FORM_GOVERNORATES = EGYPT_GOVERNORATES.map((g) => ({ label: `${g.name} · ${g.arabic}`, value: g.arabic }));

export type JoiningFormAnswers = {
  birthDate: string;
  education: string;
  educationOther: string;
  fullName: string;
  fullNameAr: string;
  gender: string;
  mobileNumber: string;
  nationalId: string;
  personalEmail: string;
  residenceAddress: string;
  residenceArea: string;
  residenceAreaOther: string;
  residenceCity: string;
};

export type JoiningFormField = keyof JoiningFormAnswers;

export type JoiningFormClean = {
  birthDate: string;
  education: string;
  fullName: string;
  /** The name in Arabic as the national ID writes it — the name every hiring paper prints. */
  fullNameAr: string;
  gender: "female" | "male";
  mobileNumber: string;
  nationalId: string;
  personalEmail: string;
  residenceAddress: string;
  residenceArea: string;
  residenceCity: string;
};

export const JOINING_FORM_OTHER_AREA = "__other__";

const ARABIC_LETTER = /[ء-ي]/u;
const LATIN_LETTER = /[A-Za-z]/;

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Arabic-Indic and Persian digits → ASCII, so a number typed on an Arabic keyboard still reads. */
export function asciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * What an Egyptian national ID says about its holder, or null when it is not a well-formed one.
 *
 * 14 digits: century (2 = 1900s, 3 = 2000s), YYMMDD, a two-digit governorate of birth, a serial
 * whose last digit is odd for a man and even for a woman, and a check digit. The Employee Master
 * already treats birth_date as derived from the ID (`employees-null-columns-that-are-not-gaps`), so
 * the form pre-fills both and refuses an answer that contradicts the ID he typed.
 */
export function readEgyptianNationalId(raw: string): { birthDate: string; gender: "female" | "male" } | null {
  const id = asciiDigits(String(raw ?? "")).replace(/\D/g, "");
  if (!/^[23]\d{13}$/.test(id)) return null;
  const century = id[0] === "2" ? 1900 : 2000;
  const year = century + Number(id.slice(1, 3));
  const month = Number(id.slice(3, 5));
  const day = Number(id.slice(5, 7));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const birthDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const gender = Number(id[12]) % 2 === 1 ? "male" : "female";
  return { birthDate, gender };
}

/** An Egyptian mobile in its dialable 11-digit form (`01XXXXXXXXX`), or null. */
export function normalizeEgyptianMobile(raw: string): string | null {
  let digits = asciiDigits(String(raw ?? "")).replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("20") && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith("1")) digits = `0${digits}`;
  return /^01[0125]\d{8}$/.test(digits) ? digits : null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Age in whole years on a given day — a joiner under 18 or over 70 is a typo, not a hire. */
function ageOn(birthIso: string, onIso: string): number | null {
  const birth = Date.parse(`${birthIso}T00:00:00Z`);
  const on = Date.parse(`${onIso}T00:00:00Z`);
  if (!Number.isFinite(birth) || !Number.isFinite(on)) return null;
  const b = new Date(birth);
  const o = new Date(on);
  let age = o.getUTCFullYear() - b.getUTCFullYear();
  if (o.getUTCMonth() < b.getUTCMonth() || (o.getUTCMonth() === b.getUTCMonth() && o.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

/**
 * Check every answer, and say what is wrong next to the field it belongs to. Server-side this is
 * the gate; the page runs the same function so the candidate sees the same sentence before he
 * presses Submit.
 */
export function validateJoiningForm(
  raw: Partial<Record<JoiningFormField, unknown>>,
  context: { residenceAreaOptions: readonly string[]; todayIso: string },
): { errors: Partial<Record<JoiningFormField, string>>; value: JoiningFormClean | null } {
  const errors: Partial<Record<JoiningFormField, string>> = {};

  const fullName = text(raw.fullName, 120);
  if (fullName.split(" ").filter(Boolean).length < 2) errors.fullName = "Please write your full name, at least your first and second name.";

  // The Arabic name is the one every hiring paper prints — the contract, Form 1 and the rest refuse
  // to print without it — and nobody at the company can type it more reliably than he can from his
  // own card. Three names at least, because an Egyptian ID always carries his, his father's and his
  // grandfather's; Arabic letters only, so the English name cannot be pasted in twice.
  const fullNameAr = text(raw.fullNameAr, 160);
  if (!fullNameAr || !ARABIC_LETTER.test(fullNameAr) || LATIN_LETTER.test(fullNameAr)) {
    errors.fullNameAr = "Please write your full name in Arabic letters, exactly as it is on your national ID card.";
  } else if (fullNameAr.split(" ").filter(Boolean).length < 3) {
    errors.fullNameAr = "Please write your full Arabic name as on your card — at least your name, your father's and your grandfather's.";
  }

  const mobileNumber = normalizeEgyptianMobile(text(raw.mobileNumber, 40));
  if (!mobileNumber) errors.mobileNumber = "Please write an Egyptian mobile number, 11 digits starting with 01.";

  const personalEmail = text(raw.personalEmail, 160).toLowerCase();
  if (!EMAIL_SHAPE.test(personalEmail)) errors.personalEmail = "Please write a valid email address.";
  else if (personalEmail.endsWith("@satopharma.com")) errors.personalEmail = "Please write your own private email, not a Sato Pharma address.";

  const nationalIdDigits = asciiDigits(text(raw.nationalId, 40)).replace(/\D/g, "");
  const fromId = readEgyptianNationalId(nationalIdDigits);
  if (!fromId) errors.nationalId = "Please write your 14-digit national ID number exactly as it is on your card.";

  const gender = text(raw.gender, 10).toLowerCase();
  if (gender !== "male" && gender !== "female") errors.gender = "Please choose your gender.";
  else if (fromId && fromId.gender !== gender) errors.gender = "This does not match your national ID number. Please check both.";

  const birthDate = text(raw.birthDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(Date.parse(`${birthDate}T00:00:00Z`))) {
    errors.birthDate = "Please choose your date of birth.";
  } else if (fromId && fromId.birthDate !== birthDate) {
    errors.birthDate = "This does not match your national ID number. Please check both.";
  } else {
    const age = ageOn(birthDate, context.todayIso);
    if (age === null || age < 18 || age > 70) errors.birthDate = "Please check your date of birth.";
  }

  const educationChoice = text(raw.education, 60);
  const educationOther = text(raw.educationOther, 120);
  let education = "";
  if (!educationChoice || !(JOINING_FORM_EDUCATION_OPTIONS as readonly string[]).includes(educationChoice)) {
    errors.education = "Please choose your education.";
  } else if (educationChoice === "Other") {
    if (educationOther.length < 2) errors.educationOther = "Please write your faculty or degree.";
    education = educationOther;
  } else {
    education = educationChoice;
  }

  const areaChoice = text(raw.residenceArea, 120);
  const areaOther = text(raw.residenceAreaOther, 120);
  let residenceArea = "";
  if (context.residenceAreaOptions.length > 0 && areaChoice !== JOINING_FORM_OTHER_AREA) {
    if (!context.residenceAreaOptions.includes(areaChoice)) errors.residenceArea = "Please choose the area you live in.";
    else residenceArea = areaChoice;
  } else {
    const typed = context.residenceAreaOptions.length > 0 ? areaOther : areaChoice || areaOther;
    if (typed.length < 2) {
      if (context.residenceAreaOptions.length > 0) errors.residenceAreaOther = "Please write the area you live in.";
      else errors.residenceArea = "Please write the area you live in.";
    }
    residenceArea = typed;
  }

  const residenceCity = text(raw.residenceCity, 60);
  if (!JOINING_FORM_GOVERNORATES.some((g) => g.value === residenceCity)) errors.residenceCity = "Please choose the city (governorate) you live in.";

  const residenceAddress = text(raw.residenceAddress, 300);
  if (residenceAddress.length < 5) errors.residenceAddress = "Please write your home address.";

  if (Object.keys(errors).length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      birthDate,
      education,
      fullName,
      fullNameAr,
      gender: gender as "female" | "male",
      mobileNumber: mobileNumber as string,
      nationalId: nationalIdDigits,
      personalEmail,
      residenceAddress,
      residenceArea,
      residenceCity,
    },
  };
}

function nameWords(value: string | null | undefined): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z؀-ۿ\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

/** Two names are one person when every word of the shorter is in the longer, and they share two or more. */
export function sameJoinerName(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = nameWords(a);
  const right = nameWords(b);
  if (left.length < 2 || right.length < 2) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  const pool = new Set(long);
  return short.every((word) => pool.has(word));
}

// ── The national ID photos (owner, 2026-10-08: "make in the form also required to upload a photo of
// his national ID") ──────────────────────────────────────────────────────────────────────────────
// Front AND back: the back carries the address, profession and marital status HR's copy is for, and
// the Hiring Documents store already expects an ID to arrive as two photographs.
//
// THE LIMIT IS THE PROXY'S, NOT THE BUCKET'S. This public route stays behind the proxy, which cuts any
// body at 10 MB (proxy.ts, `proxyClientMaxBodySize`). Three photos (the two ID sides and the optional
// photo) at 3 MB plus the answers stay under it; the page shrinks each photo on the phone first, so a
// real one arrives well below. Images only — the page asks for a photograph, and the buckets take JPG,
// PNG and WEBP.

export const JOINING_FORM_PHOTO_FIELDS = ["idFront", "idBack"] as const;

export type JoiningFormPhotoField = (typeof JOINING_FORM_PHOTO_FIELDS)[number];

/**
 * The candidate's photo (owner, 2026-10-08: "upload a photo for him", OPTIONAL by his ruling). It
 * becomes the new record's Phoenix profile photo and is filed on Hiring Documents under the
 * "(6) personal photos" slot WITHOUT ticking it — that slot asks for six prints, and HR still
 * collects them. Called just "Photo" on the page, never "personal photo" (his words).
 */
export const JOINING_FORM_FACE_PHOTO_FIELD = "photo" as const;

export type JoiningFormUploadField = JoiningFormPhotoField | typeof JOINING_FORM_FACE_PHOTO_FIELD;

export const JOINING_FORM_PHOTO_MAX_BYTES = 3 * 1024 * 1024;

export const JOINING_FORM_PHOTO_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * What the page says when a phone hands it a photo it cannot open at all — not even after trying it as
 * HEIC (6 Nov 2026: a candidate's gallery photo of the card's back reached the page as a broken tile
 * and "Please choose a photo — a JPG, PNG or WEBP image", which told her nothing she could act on).
 * The camera always gives the page a JPEG, so that is the way out it names.
 */
export const JOINING_FORM_PHOTO_UNREADABLE = "This photo could not be opened on this phone. Please take the photo again with the camera.";

const PHOTO_MISSING: Record<JoiningFormPhotoField, string> = {
  idBack: "Please add a photo of the back of your national ID card.",
  idFront: "Please add a photo of the front of your national ID card.",
};

type PhotoFacts = { contentType: string; size: number };

/** A photograph, and small enough to pass the proxy — or what is wrong with it. */
function photoProblem(photo: PhotoFacts): string | undefined {
  if (!JOINING_FORM_PHOTO_TYPES.includes(photo.contentType.trim().toLowerCase())) {
    return "Please choose a photo — a JPG, PNG or WEBP image.";
  }
  if (photo.size > JOINING_FORM_PHOTO_MAX_BYTES) {
    return "This photo is too large. Please take it again, or choose a smaller one.";
  }
  return undefined;
}

/** Present, a photograph, and small enough to pass the proxy. Keyed by field, like the answers. */
export function validateJoiningIdPhotos(
  photos: Partial<Record<JoiningFormPhotoField, PhotoFacts | null | undefined>>,
): Partial<Record<JoiningFormPhotoField, string>> {
  const errors: Partial<Record<JoiningFormPhotoField, string>> = {};
  for (const field of JOINING_FORM_PHOTO_FIELDS) {
    const photo = photos[field];
    const problem = !photo || photo.size <= 0 ? PHOTO_MISSING[field] : photoProblem(photo);
    if (problem) errors[field] = problem;
  }
  return errors;
}

/** The optional photo: nothing to say when there is none, the same checks as the ID when there is. */
export function validateJoiningFacePhoto(photo: PhotoFacts | null | undefined): string | undefined {
  return !photo || photo.size <= 0 ? undefined : photoProblem(photo);
}
