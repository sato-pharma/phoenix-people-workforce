import { isMatchableName, normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { addressWords, compileArabicWord, type PlaceWord } from "@/lib/geo/arabic-place-match";
import { jaccardSimilarity, nameTokens } from "@/lib/pharmacy-master/pharmacy-matching";
import { distinctiveWords } from "@/lib/phoenix-crm/google-place-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Does the photo show WHO the customer is?
//
// THE MODULE VALIDATED A LOCATION WHILE THE OWNER GRADED AN IDENTIFICATION, and only the first was
// ever built. Of 643 places validated in the five days from 03 Oct 2026, 233 photos were good, 231
// weak and 179 failed — street shots with no building in them, blank walls, a photo of a paper
// timetable, a photo taken from inside a moving car. The accuracy gate (both readings within
// PLACE_MAX_ACCURACY_METERS) was working the whole time and is not the problem: nothing anywhere
// asked the photograph to show whose doorway it is. The one identity check that existed, the Google
// listing comparison, is AM-only by `googleCheckApplies`, so 561 of the 643 (87%) had none at all.
//
// Owner, 2026-10-08: require the customer's name always, no exception for a building with no
// nameplate; frame the signboard in the camera; read the captured picture before accepting it; then
// validate or send it for review.
//
// 🔴 "NEVER A PERSON — AM SIGN / PM SIGN" (his own words, same day, asked directly). A hospital signs
// ITSELF, not the people who hold clinics inside it. So an AM capture is judged against the account
// name on his own list row and is NEVER judged against a person's name, and an AM signboard that
// names nobody is a MATCH — not a `no_name`. A PM capture is judged against the person. Getting this
// backwards would hold close to every hospital validation in the company, which is a different
// feature and not the one he asked for.
//
// IT ADVISES ON ONE AXIS AND GATES ON ANOTHER, deliberately. A confident negative HOLDS the place
// exactly as a Google mismatch holds it — saved, the customer left under To validate, one review row
// raised, the rep reading only that the system is checking. NO SIGNAL NEVER HOLDS: it saves and
// validates as before and records WHY it could not judge, because holding on the absence of an
// answer would hold every validation in the field the moment the provider is slow or the key lapses.
//
// 🔴 THE WORD "doctor" CANNOT APPEAR IN ANY STRING IN THIS FILE, nor "account", "doctors" or
// "accounts" — tests/phoenix-crm-am-pm-words.test.ts sweeps this whole tree with stripComments and
// refuses them inside any quoted string. "customer", "clinic" and "practice" are the words. Do not
// add an exception; the sweep is why the module's vocabulary is consistent in front of a rep.
//
// Invisible by rule: nothing here names a model, and `nameScore` is stored for later analysis and
// never rendered. The pure/server split is the house one — this file does the judging and holds no
// I/O; src/lib/phoenix-crm/server/signboard-check.ts fetches the bytes and calls the model.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SignboardVerdictKind =
  /** The signboard names the customer this place was validated for. */
  | "match"
  /** The signboard names somebody else. A held place and a review row. */
  | "other_name"
  /**
   * No name the capture can be judged on: the photo shows no signboard at all (either list), or a PM
   * signboard carries no person's name. Held the same way. Never given to an AM signboard that names
   * nobody — that is a match.
   */
  | "no_name"
  /**
   * No answer was obtained. NEVER a pass. At the door it HOLDS since 2026-10-17 (`signboardDoorHolds`)
   * and the system re-reads it; it never holds on the integrity board (`signboardHoldsForReview`).
   */
  | "unjudged";

export type SignboardCheckReason =
  /** No key is configured in this environment. */
  | "no_api_key"
  /** The photo could not be read back out of the bucket. */
  | "no_bytes"
  /** An answer came back but carried nothing usable, or either name folded away to nothing. */
  | "unreadable"
  /** The call failed, timed out, or the image could not be decoded. */
  | "call_failed"
  /** The place is already held for another reason, so no call was made at all. */
  | "held_elsewhere"
  /** The signboard names somebody else. */
  | "sign_other_name"
  /** A PM signboard with no person's name on it. */
  | "sign_no_name"
  /**
   * The sign names somebody in the other script and this customer's name cannot be pinned across the
   * two, so there is nothing to compare. Never re-read: tomorrow's answer is the same one.
   */
  | "not_comparable"
  /**
   * The model could not read this frame, and it has now been given every attempt it gets
   * (`SIGNBOARD_MAX_READ_ATTEMPTS`). Terminal — the one reason that means *we tried*, as opposed to
   * `unreadable`, which now means *we will try again*.
   */
  | "unreadable_final"
  /**
   * Nothing about this place can ever be read: a pharmacy, or a customer name that folds away to
   * nothing. Terminal, and deliberately NOT `unreadable` — it is the photo that is fine here.
   */
  | "name_unusable"
  /**
   * A verdict that would have put a name on the owner's board was reached once and the second read of
   * the same frame did not agree with it. Retryable: one of the two readings is right.
   */
  | "unconfirmed";

/**
 * What the reader says stops the customer's own nameplate being read in this photograph — asked with
 * every blind read since 2026-10-18, and the words a rep is given to fix it (`signboardRetakeAdvice`).
 *
 * 🔴 IT WAS ADDED BECAUSE A STORED "NOT READABLE" SAID NOTHING ABOUT THE PHOTO. On 18 Oct 2026, 532
 * places were filed unreadable; read again by Claude, some were clear plates the old reader could not
 * read, and the rest a hospital front, a blank door, a blurred street. Only this field tells the two
 * apart without a person opening every photo.
 */
export type SignboardPhotoProblem =
  /** The signs that matter are legible. */
  | "none"
  /** No nameplate or lettered sign of a practice at all: a street, a wall, a bare door, a vehicle. */
  | "no_plate"
  /** Only a building's, a hospital's or another trade's sign — no plate of the practice itself. */
  | "building_sign_only"
  /** A plate is there but too small in the frame to read. */
  | "too_far"
  | "blurred"
  | "dark_or_glare"
  /** The plate runs out of the frame. */
  | "cut_off"
  /** Calligraphic or decorative lettering the reader cannot follow. */
  | "stylised"
  /**
   * The scene is on its side or upside down — a phone held sideways — and no upright reading of it was
   * made. Never the reader's own answer: set by `server/signboard-check.ts` from the reader's `upright`
   * word, when there was no time (the door) or no answer to turning it (2026-10-18).
   */
  | "sideways";

export const SIGNBOARD_PHOTO_PROBLEMS: readonly SignboardPhotoProblem[] = [
  "none",
  "no_plate",
  "building_sign_only",
  "too_far",
  "blurred",
  "dark_or_glare",
  "cut_off",
  "stylised",
  "sideways",
];

/** An answer outside the list is no answer — never a guess at which problem it meant. */
export function parseSignboardPhotoProblem(value: unknown): SignboardPhotoProblem | null {
  const raw = String(value ?? "").trim().toLowerCase();
  return (SIGNBOARD_PHOTO_PROBLEMS as readonly string[]).includes(raw) ? (raw as SignboardPhotoProblem) : null;
}

/**
 * "New signboard photo needed" — the place's photo does not show the customer's name, so the only fix is
 * a new photograph from the rep at that door (owner, 2026-10-18: "fix all the unreadable"). Kept on the
 * place's own `signboard_check`, so the rep's list and the Super Admin's board read one record.
 */
export type SignboardRetakeRequest = {
  requestedAt: string;
  problem: SignboardPhotoProblem | null;
  /** The sentence the rep reads: what to photograph differently. */
  advice: string;
};

export type PhoenixCrmSignboardCheck = {
  verdict: SignboardVerdictKind;
  /** Why, for every verdict but `match`. Null on a match. */
  reason: SignboardCheckReason | null;
  /** What the signboard reads, verbatim, in its own script. Arabic stays Arabic. */
  signText: string | null;
  /** The names on the signboard that read as PEOPLE. */
  personNames: string[];
  /** The names on the signboard that read as PLACES — a hospital, a centre, a unit. */
  placeNames: string[];
  /**
   * EVERY sign the reader saw in the photograph, not just the one judged. The four false holds of
   * 2026-10-09 were all a second sign in the frame, so the others are kept as the evidence of what
   * was chosen and why — and the review queue shows them beside the verdict.
   */
  signs: PhoenixCrmSign[];
  /** 0–1. Stored for analysis, NEVER rendered. */
  nameScore: number | null;
  /** One sentence a Super Admin can act on. */
  note: string | null;
  checkedAt: string;
  /**
   * How much of the image was cropped off the bottom before it was read, so a stored verdict can be
   * understood on its own years later without re-deriving the stamp arithmetic below.
   */
  croppedFraction: number | null;
  /**
   * How many times a verdict has been recorded for this place, this one included.
   *
   * 🔴 IT IS WHAT MAKES A RE-READ BOUNDED RATHER THAN ENDLESS. Measured on the first night,
   * 2026-10-09: of 60 places read, **4** produced an answer, 42 came back `unreadable` and 14 lost
   * their model call — and `unreadable` was terminal, so those 42 were parked for ever. They are
   * worth another look because legibility is not a property of the photograph: the same frame read
   * `other_name` at 18:12 and `unreadable` at 18:34, and another read `unjudged` at 18:35 and a clear
   * nameplate at 18:48. So an unread frame is tried `SIGNBOARD_MAX_READ_ATTEMPTS` times and then
   * recorded `unreadable_final`, which no backlog query takes.
   *
   * A row written before this field existed reads as 1 — it has had its first attempt.
   */
  attempts: number;
  /** What the reader said stops the name being read. Absent on a check written before 2026-10-18. */
  problem?: SignboardPhotoProblem | null;
  /**
   * True when the strong reader itself answered this read — never a fallback after a lost call. An
   * `unreadable` it answers is final at once (`signboardNextAttempt`): the same photo read again by the
   * same reader is the cost the owner stopped on 2026-10-18, not a second chance.
   */
  strongRead?: boolean;
  /** Set when the rep has been asked for a new photograph of this place. */
  retake?: SignboardRetakeRequest | null;
  /**
   * Hourly runs in a row that read other held places but never got an answer for this one
   * (`heldSignboardLostReadToKeep`). Gone with the next read that answers, which replaces the check.
   */
  lostReads?: number;
};

// ── The stamp band ──────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE CUSTOMER'S NAME IS BURNED INTO THE STORED PHOTO BEFORE THE UPLOADED FILE EXISTS.
// place-editor.tsx passes `title={`Phoenix CRM customer: ${customerName}`}` into
// buildEvidenceStampLines, which makes it the FIRST caption, drawn at the TOP of drawStamp's caption
// box; and live-photo-capture.tsx creates its one and only Blob AFTER drawStamp has already mutated
// the canvas. So reading the stored object directly would read the name off Phoenix's own caption
// and report a match on a photograph of a blank wall — a guaranteed false pass, every time.
//
// The band is therefore cropped off before the image is read, from drawStamp's OWN arithmetic
// applied to the DECODED image's own dimensions. 🔴 Never from a number the browser sends: at 1280
// wide the title's baseline sits 266 px above the bottom edge, so clamping a forged-small height to
// a one-line minimum still leaves the name in frame, and a forged number buys exactly the false pass
// this crop exists to prevent.
//
// Measured against the two canvas shapes getCompressedEvidenceCanvasSize produces (longest side
// 1280), with the frame guide's own bottom edge at 0.44 of the height:
//
//   portrait  720 x 1280  fontSize 16  lineHeight 22  pad 12  band 200 px  0.156 -> clamped 0.18
//   landscape 1280 x 720  fontSize 28  lineHeight 39  pad 21  band 354 px        0.49
//
// which is why SIGNBOARD_FRAME_NOTE's box sits HIGH in the viewfinder: the frame is what makes this
// crop free in both orientations, with 38 points of clearance in portrait and 7 in landscape.
// Moving that box down silently crops signboards off, and
// tests/phoenix-crm-signboard-check.test.ts asserts the clearance in both shapes so it cannot.

/**
 * A bound, not a measurement. The captions are the title (which wraps on a long name), "Photo
 * taken:", the address, the territory, the coordinates (the address wraps too) and "Location
 * captured:". Eight covers every shape seen; being generous here costs picture area and nothing else,
 * where being mean costs a false pass.
 */
export const SIGNBOARD_STAMP_WORST_CASE_LINES = 8;
/** A one-line band is ~0.06 of a portrait frame, and no real stamp is ever that short. */
export const SIGNBOARD_CROP_MIN_FRACTION = 0.18;
/** Past this the crop would be eating the picture, so stop and let the prompt's own guard carry it. */
export const SIGNBOARD_CROP_MAX_FRACTION = 0.6;

/**
 * What fraction of the bottom of a stored place photo is Phoenix's own caption box.
 *
 * 🔴 This restates `drawStamp` in src/components/phoenix-crm/live-photo-capture.tsx line for line.
 * The two must agree, and the test compares both canvas shapes against the frame guide, so a change
 * to one without the other goes red rather than quietly cropping a signboard away.
 */
export function stampBandFraction(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return SIGNBOARD_CROP_MAX_FRACTION;
  }
  const fontSize = Math.max(16, Math.round(width * 0.022));
  const lineHeight = Math.round(fontSize * 1.38);
  const pad = Math.round(fontSize * 0.75);
  const band = SIGNBOARD_STAMP_WORST_CASE_LINES * lineHeight + pad * 2;
  const fraction = band / height;
  if (fraction < SIGNBOARD_CROP_MIN_FRACTION) return SIGNBOARD_CROP_MIN_FRACTION;
  if (fraction > SIGNBOARD_CROP_MAX_FRACTION) return SIGNBOARD_CROP_MAX_FRACTION;
  return Math.round(fraction * 10000) / 10000;
}

// ── The name ────────────────────────────────────────────────────────────────────────────────────

// 🔴 ONE NAME, TWO SPELLINGS: THE SPACE INSIDE A COMPOUND, AND THE PROFESSOR'S TITLE. Filed on the
// owner's integrity board at 03:37 Cairo on 11 Oct 2026, after two readings agreed: ابراهيم عبدالشافى
// on the list, and a plate read CLEARLY as "الأستاذ الدكتور / إبراهيم عبد الشافى". One person, held as
// another, because the fold keeps each script's spaces where they are — the list's one word
// عبدالشافي was missing from a sign that wrote it as two, and a two-word name may miss nothing.
//
// The same space also made FALSE matches. عبد and ابو fold to three letters, so each counted as a
// word of the name and spent the allowance a long name gets: د.هشام ابو الدهب was MATCHED on a plate
// reading "د/ هشام أحمد أبو الوفا" because هشام and ابو were both there — a different family. So a
// compound is ONE word on both sides — its head (عبد, ابو) takes the next word, its tail (الدين,
// الله) joins the word before it — and the quorum counts it once, whichever way it was written.
//
// 🔴 BUT A READER THAT DROPS THE HEAD HAS STILL READ THE NAME, and joining alone threw that away. The
// same replay held two such plates: "الله عفيفي" for عبد الله عفيفي, and "النعماني نار" for النعماني
// ابو نار — joined strictly, the first turned from a match into a FLAG on the owner's board, filed by
// the other doctors' plates in the same frame. So a compound's CORE (عبدالشافي → الشافي, ابونار →
// نار, نورالدين → نور) also answers for it when it stands ALONE on the other side, in either
// direction — and only alone: the الله inside جاد الله is not عبد الله.
//
// The title half is the shared fold's own list (د, دكتور, الدكتور, prof and the rest), plus the one
// honorific every professor's plate starts with and that list does not carry: الأستاذ. On the sign it
// is harmless — only the CUSTOMER's words are counted — but on a list row it would be a word of the
// name, and "الأستاذ الدكتور محمد علي" would spend its allowance on علي and match any professor
// called محمد. Measured the same day: 0 of 9,215 PM list rows carry it, so this changes nothing
// today and guards the next import.
//
// 🔴 PERSON NAMES ONLY. A facility's quorum is `distinctiveWords`, stemmed, and none of the 389 stored
// readings replayed on 12 Oct 2026 moved on the PLACE axis; joining there would also take the
// allowance off "مستشفى ابو كبير المركزي", whose three words today may lose one.
//
// 🔴 These are WORD steps on top of `normalizeContactName`, never a third character fold, and they
// stay here: the shared fold also keys `public.phoenix_crm_fold_name`, which the duplicate and
// customer-name checks read, and joining compounds there would move every one of those keys.

/** The two words that open an Arabic compound name, as the fold writes them — عبد الشافي, ابو الفتوح. */
const COMPOUND_HEADS: ReadonlySet<string> = new Set(["عبد", "ابو"]);
/** The two words that close one — نور الدين, جاد الله. Neither is a family name on its own. */
const COMPOUND_TAILS: ReadonlySet<string> = new Set(["الدين", "الله"]);
/** Honorifics `normalizeContactName` keeps, folded the way it folds them. */
const PLATE_TITLES: ReadonlySet<string> = new Set([
  "استاذ",
  "الاستاذ",
  "استاذه",
  "الاستاذه",
  "بروفيسور",
  "البروفيسور",
]);

/** One word of a person's name. `core` is set only on a compound: the part that says WHICH one. */
export type NameWord = { word: string; core: string | null };

/** What is left of a compound once its head and tail are taken off — never empty. */
function compoundCore(parts: readonly string[]): string {
  let rest = [...parts];
  while (rest.length > 1 && COMPOUND_HEADS.has(rest[0])) rest = rest.slice(1);
  while (rest.length > 1 && COMPOUND_TAILS.has(rest[rest.length - 1])) rest = rest.slice(0, -1);
  return rest.join("");
}

/** A person's name as the signboard check counts it: folded, untitled, each compound one word. */
export function personNameWords(text: string): NameWord[] {
  const groups: string[][] = [];
  let open = false;
  for (const word of normalizeContactName(text).split(" ")) {
    if (word.length === 0 || PLATE_TITLES.has(word)) continue;
    const last = groups[groups.length - 1];
    if (last && (open || COMPOUND_TAILS.has(word))) {
      // "ابو عبد الله" is one name: a head swallowed by an open compound keeps it open.
      open = open && COMPOUND_HEADS.has(word);
      last.push(word);
      continue;
    }
    groups.push([word]);
    open = COMPOUND_HEADS.has(word);
  }
  return groups.map((parts) => ({ word: parts.join(""), core: parts.length > 1 ? compoundCore(parts) : null }));
}

// 🔴 A NAME IS WRITTEN WITH AND WITHOUT ITS ال, AND THAT IS STILL ONE NAME — on any word of it, the
// given name too (الحسن on the list, حسن on the plate: one place of the 1,217). Re-reading the
// places the door left unconfirmed, 18 Oct 2026, the strong reader read three plates clearly that
// named the customer and were not matched: "أيمن البدوى" for ايمن بدوي, "عبير محمد راوي" for عبير
// الراوي, "إبراهيم عبد الله العفيفي" for إبراهيم عفيفي. So a plain word answers for the same word
// with ال in front, either way round. Only ال, and only on a word that keeps three letters without
// it: a letter the reader got wrong is NOT forgiven — "محمد ابو العنيين" on a plate reading "مجدي أبو
// العينين" is another doctor, and a guided reader handed a near-miss copied it 8 times in 40.

/** A word without the ال in front of it, when what is left is still a name. */
function withoutArticle(word: string): string {
  return word.startsWith("ال") && word.length >= 5 ? word.slice(2) : word;
}

// 🔴 THE OWNER'S SPELLING RULINGS, 18 Oct 2026, asked one by one after measuring each on the stored
// readings against 20 other customers' names per confirmed place (about 32,000 tries):
//   · ؤ is و and ئ is ي — فؤاد and فواد, ناشئ and ناشي are one name (2 more confirms, 1 more stranger).
//   · ذ, ز and د are one letter, and ح and خ are one — "أحمد ذكي" for احمد دكى, "أبو حشبة" for ابوخشبه
//     (6 more confirms, no new stranger).
// Compared word against word, Arabic on both sides: the cross-script compiler never sees it. 🔴 LONG
// VOWELS ARE NOT FORGIVEN — dropping them merged محمود with محمد and سعيد with سعد, and stranger matches
// went from 52 to 220. Nor is any other letter: "محمد ابو العنيين" against "مجدي أبو العينين" is still
// another doctor.
const SAME_LETTER: ReadonlyArray<readonly [RegExp, string]> = [
  [/ؤ/g, "و"],
  [/ئ/g, "ي"],
  [/[ذز]/g, "د"],
  [/خ/g, "ح"],
];

/** A word as the comparison reads it: each pair the owner ruled the same written one way. */
export function spelledOneWay(word: string): string {
  return SAME_LETTER.reduce((text, [letter, as]) => text.replace(letter, as), word);
}

/**
 * 🔴 A TIMETABLE THAT WRITES ONLY THE FIRST NAME NAMES HIM WHEN NOBODY ELSE ON IT SHARES THAT NAME
 * (owner, 2026-10-24, asked as a choice: "Count it if unique"). Polyclinic boards list their staff as
 * "د/ صلاح", "سوزى", "ماريان" — read 24 Oct 2026 on three of Ali Mohamed Shehata's held seatings, where
 * the full-name quorum could only ever half-match. So: some entry on the board is his given name ALONE,
 * and no other entry begins with that given name. Two people the board calls by the same first name stay
 * held, and so does a board the reader transcribed nothing from. TIMETABLES ONLY — a signboard names one
 * person in full, and `isMatchableName`'s "a single word is not evidence" still holds everywhere else;
 * here the evidence is the board of the building he stood in, not the word.
 */
export function boardNamesGivenNameAlone(customerName: string | null, personNames: readonly string[]): boolean {
  const key = (word: NameWord) => spelledOneWay(withoutArticle(word.word));
  const wanted = personNameWords(customerName ?? "");
  if (wanted.length === 0) return false;
  const given = key(wanted[0]);
  const entries = personNames.map((name) => personNameWords(name)).filter((words) => words.length > 0);
  const alone = entries.filter((words) => words.length === 1 && key(words[0]) === given);
  if (alone.length === 0) return false;
  return entries.every((words) => key(words[0]) !== given || words.length === 1);
}

/** Is this word of the customer's name among the words read off one candidate? */
function nameWordIsThere(given: NameWord, read: readonly NameWord[]): boolean {
  const oneWay = (name: NameWord): NameWord => ({
    core: name.core === null ? null : spelledOneWay(name.core),
    word: spelledOneWay(name.word),
  });
  const wanted = oneWay(given);
  return read.map(oneWay).some(
    (candidate) =>
      candidate.word === wanted.word ||
      // The reader dropped the head or the tail: "الله عفيفي" for عبد الله عفيفي.
      (wanted.core !== null && candidate.core === null && candidate.word === wanted.core) ||
      // The list dropped it: اسامه العيلة for a plate reading "اسامة ابراهيم ابو العيلة".
      (wanted.core === null && candidate.core === wanted.word) ||
      // One side wrote the ال and the other did not: البدوى on the plate, بدوي on the list.
      (wanted.core === null && candidate.core === null && withoutArticle(candidate.word) === withoutArticle(wanted.word)),
  );
}

// 🔴 A THREE-WORD NAME MAY LOSE ONE WORD, AND IT MUST NEVER BE HIS GIVEN NAME LOST BEHIND ANOTHER.
// Judging the 341 places the strong reader confirmed on 18 Oct 2026 again, from their own readings,
// against names that are NOT the customer's — 20 strangers, and his surname under other given names —
// 106 also matched one, in three shapes the bag of words could not see: his
// father's and family name behind another given name ("وائل محمد بلحة" passed on a plate reading
// "احمد محمد بلحة"), his given name standing as somebody else's father ("محمد الشحري" on "أحمد محمد
// الشحرى"), and his words gathered from two names on one notice ("مجدى عبد العزيز" from "الدكتور
// مجدى" and "الدكتور / محمود عبدالعزيز"). So a person name the reader split out must OPEN on one of
// his words — it may still have lost the given name to the plate's damage ("د / ... عبد النبي
// الخولي") — and the sign's whole text must carry his words, in his order, as one run that opens on
// his given name, with at most two other words between two of his. Requiring the given name outright
// was scored and refused: it lost three plates whose given name was simply unreadable. Replayed: 335
// of the 341 stand and the decoys they also match fall from 106 to 71. Of the six that leave, four
// are plates whose name opens on another given name, read in part ("مجاهد علي ضاهر" for محمد على
// ضاهر, "سينا ناجح زاخر" for مينا ناجح زاخر), one is the notice above and one a hospital filed on the
// PM list; each goes to the Super Admin's Approve, as a misread letter does.

/**
 * Words a plate puts in front of the name that are never a given name: the practice's own kind, and
 * the lone letter "أ.د" leaves once the fold has taken its د. Nothing else is skipped — "مي" is a
 * given name of two letters.
 */
const PLATE_LEAD_WORDS: ReadonlySet<string> = new Set(["مركز", "عياده", "عيادات", "مستشفي", "مجمع"]);

/** The quorum's floor: a word of the name under three letters is never one the quorum asks for. */
function nameWordCountsInQuorum(name: NameWord): boolean {
  return name.word.length >= 3;
}

/**
 * Does this candidate say HIS name, rather than carrying his words inside somebody else's?
 *
 * `customerWords` is every word of the name, a two-letter given name included — the quorum's
 * three-letter floor would let "مي احمد" open on احمد and take any احمد's plate.
 */
function readsTheCustomersName(
  customerWords: readonly NameWord[],
  read: readonly NameWord[],
  allowedMisses: number,
  isSignText: boolean,
): boolean {
  if (customerWords.length === 0) return false;
  if (!isSignText) {
    const opening = read.find((word) => word.word.length > 1 && !PLATE_LEAD_WORDS.has(word.word));
    if (opening === undefined) return false;
    // 🔴 A GIVEN NAME UNDER THE QUORUM'S FLOOR MUST BE THE NAME'S OPENING WORD (code review, 19 Oct 2026).
    // The floor leaves "مي" out of the words the quorum asks for, so if the opening could be any of her
    // words, nothing anywhere would ask for her given name and "مي احمد" matched "د/ احمد سامي" on her
    // father's name alone. A longer given name the plate's damage took still matches, as above.
    if (!nameWordCountsInQuorum(customerWords[0])) return nameWordIsThere(customerWords[0], [opening]);
    return customerWords.some((name) => nameWordIsThere(name, [opening]));
  }
  for (let start = 0; start < read.length; start += 1) {
    if (!nameWordIsThere(customerWords[0], [read[start]])) continue;
    let at = start;
    let missed = 0;
    for (const name of customerWords.slice(1)) {
      const step = read.slice(at + 1, at + 4).findIndex((word) => nameWordIsThere(name, [word]));
      if (step < 0) {
        missed += 1;
        continue;
      }
      at += 1 + step;
    }
    if (missed <= allowedMisses) return true;
  }
  return false;
}

/**
 * The short forms an AM list writes for a name its building spells out in full (owner, 2026-10-19,
 * choosing "teach the matcher" over approving them one by one): the list's "صدر منوف" is the board's
 * "مستشفى الأمراض الصدرية بمنوف", its "كهربا بشتيل" the electricity company's "… الكهرباء … بشتيل".
 * Each pair is written one way on BOTH sides, after the stem, so the quorum is unchanged. Two more from
 * reading the Not readable tab by eye the same day: a company's plural is written both ways (the list's
 * "تعاقد المقاولين العرب" is the board's "المقاولون العرب"), and the list spells النفسية as "النفسه".
 */
const PLACE_SHORT_FORMS: ReadonlyMap<string, string> = new Map([
  ["صدريه", "صدر"],
  ["كهرباء", "كهربا"],
  ["مقاولون", "مقاولين"],
  ["نفسه", "نفسيه"],
]);

/**
 * Words an AM list puts in front of a company it holds a CONTRACT with — "تعاقد المقاولين العرب" — and
 * no board ever carries. They say what the list row is, never which company, so they are dropped.
 */
const PLACE_LIST_WORDS: ReadonlySet<string> = new Set(["تعاقد"]);

function placeNameHasListWord(name: string | null, placeAxis: boolean): boolean {
  return placeAxis && distinctiveWords(name ?? "").some((word) => PLACE_LIST_WORDS.has(word));
}

/** The words of a place's name the signboard comparison counts: `distinctiveWords`, short forms one way. */
function placeWordsOnSign(text: string): string[] {
  return [...new Set(distinctiveWords(text).filter((word) => !PLACE_LIST_WORDS.has(word)).map((word) => PLACE_SHORT_FORMS.get(word) ?? word))];
}

/**
 * 🔴 WORDS THAT NEVER SAY WHICH PLACE BESIDE THE PHOTO'S BRICK. Replayed on 2026-10-19 before the first
 * apply: "مستشفي صحة بشتيل" matched a health-campaign poster from Asyum on صحة plus the brick, and
 * "جامعة اكتوبر" matched any board saying جامعة in 6th of October City, which holds several
 * universities. Each is one word of the list name that a poster or a neighbour carries as easily.
 *
 * 🔴 AND NO WORD THAT SAYS WHAT KIND OF PLACE IT IS (code review, 19 Oct 2026). "مستشفى المنيا الجامعي"
 * matched "مستشفى النور الجامعي" photographed in the brick المنيا, and "مستشفى بنها التعليمي" a board
 * reading only "التعليمي" in بنها: the brick gave the town, and the level word every other hospital in
 * town can carry was taken for the name. These are the level, ownership and kind words the AM list
 * repeats across dozens of names (counted on production that day: المركزي 61, الخاص 53, التخصصي 35,
 * الصحي 29, الطبي 25, التأمين 25, الجامعي 22 …). A SPECIALTY is not one of them — صدر and حميات name
 * the one chest or fever hospital a town has, and the stored readings confirmed beside the brick on
 * them (مستشفى حميات منوف, مستشفي صدر أشمون) are the right buildings. Beside a brick the sign must carry
 * a word of the name that is none of these; without a brick nothing here applies.
 */
const NEVER_WHICH_BESIDE_A_BRICK: ReadonlySet<string> = new Set(
  placeWordsOnSign(
    [
      "صحة صحه جامعة جامعه",
      "المركزي الخاص التخصصي الصحي الطبي التأمين الجامعي التعليمي الدولي العسكري الاسلامي النموذجي الاستثماري",
      "مركز المركز دار مستوصف معهد وحدة شركة مصنع الجديدة",
    ].join(" "),
  ),
);

/** A hospital on the list never matches a board that calls itself a clinic and not a hospital. */
function kindsClash(customerName: string, signText: string): boolean {
  return /مستشف|hospital/i.test(customerName) && /عياد|clinic/i.test(signText) && !/مستشف|hospital/i.test(signText);
}

/**
 * Is the customer's name on this signboard?
 *
 * 🔴 FOLDED WITH `normalizeContactName` AND NOTHING ELSE. This repository holds six Arabic folds and
 * five of them are wrong for this job. It is the only one that strips the honorifics (its
 * TITLE_TOKENS carries د, دكتور, الدكتور, dr, prof and the rest), and a signboard reading "د. أحمد
 * سمير" against a list row reading "أحمد سمير" is the single commonest shape here —
 * `normalizeArabicPharmacyName` would call that a partial match on a coin toss. It also already has
 * a SQL twin, `public.phoenix_crm_fold_name`, which tests/phoenix-crm-customer-name-fold.test.ts
 * compares against it literally, so a THIRD fold is the precise drift that test exists to refuse.
 * On a PERSON's name two WORD steps sit on top of it, never a character fold — the compound and the
 * professor's title, `personNameWords` above — applied to both sides alike. The one letter step is the
 * owner's own list of letters that are the same (`spelledOneWay`), and it is applied only where two
 * words are compared, so the fold and its SQL twin stay one.
 *
 * `listingIsAccount` in google-place-rules.ts is the near miss: its stemWord and KIND_WORDS are
 * built for facility names and would stem a person's. Its QUORUM is sound, though, and is borrowed —
 * every folded token of three characters or more must appear on the signboard, except that a name of
 * three tokens or more may lose one, which is what lets a signboard drop a grandfather's name
 * without letting a bare "أحمد" match a stranger.
 *
 * Returns `matches: null` whenever either side folds away to nothing, following the direct-order
 * reader's own rule: an absence is not a mismatch, and the two must never be shown the same way.
 */
export function signNamesCustomer(input: {
  customerName: string | null;
  listType: PhoenixCrmListType;
  personNames: readonly string[];
  placeNames: readonly string[];
  signText: string | null;
  /** The brick the photo's own GPS put the place in — on the place axis it may answer for the TOWN word. */
  photoBrick?: string | null;
}): { matches: boolean | null; score: number | null } {
  const wanted = normalizeContactName(input.customerName);
  if (!wanted) return { matches: null, score: null };

  // 🔴 The owner's AM/PM rule, in code: AM reads the PLACE names, PM reads the PEOPLE. The whole
  // signboard text is the fallback for both, because a model that did not split the names cleanly
  // has still transcribed them.
  const preferred = input.listType === "PM" ? input.personNames : input.placeNames;
  const haystacks = [...preferred, ...(input.signText ? [input.signText] : [])];
  if (haystacks.length === 0) return { matches: null, score: null };

  // 🔴 ON THE PLACE AXIS THE QUORUM IS COUNTED ON THE DISTINCTIVE WORDS, AND THIS COST A FALSE MATCH.
  // Measured 2026-10-09, re-reading the one flag of that night that was CORRECT: مستشفى المنشاوى
  // العام against a board reading مستشفى طنطا العام came back MATCHED, because a three-token name may
  // lose one and the two it kept were "مستشفى" and "العام" — the words that say WHAT the place is,
  // which every general hospital in Egypt shares. It had only ever been held because the board was in
  // English and the fold could not compare scripts at all; the moment the reader returned the Arabic
  // board too, the allowance handed away the one word that identifies it. `distinctiveWords` is the
  // module's own answer to this (its KIND_WORDS carries مستشفي, عام, hospital, general, clinic,
  // centre) and the Google listing comparison has counted its quorum that way all along — only the
  // n-1 half of that rule was borrowed here. The PERSON axis keeps `normalizeContactName`, because
  // stemming a person's name is what the header of this file warns against.
  const placeAxis = input.listType !== "PM";
  // `wanted` being non-empty already proves the name is there; `?? ""` is what says so to the compiler.
  const wordsOf = (text: string): NameWord[] =>
    placeAxis ? placeWordsOnSign(text).map((word) => ({ core: null, word })) : personNameWords(text);
  const customerWords = wordsOf(input.customerName ?? "").filter((name) => name.word.length > 1);
  const wantedWords = customerWords.filter(nameWordCountsInQuorum);
  if (wantedWords.length === 0) return { matches: null, score: null };
  // A name of three tokens or more survives losing one; two tokens must both be there. 🔴 NOT a contract
  // row whose list word was dropped: the words left are the company and its TOWN, and losing the company
  // matched "تعاقد الكهرباء كفر الشيخ" on the Kafr El Sheikh fever hospital's board (replayed 2026-10-19).
  const allowedMisses = wantedWords.length >= 3 && !placeNameHasListWord(input.customerName, placeAxis) ? 1 : 0;
  // 🔴 THE PHOTO'S OWN BRICK ANSWERS FOR THE TOWN, NEVER FOR THE PLACE (owner, 2026-10-19: "brick counts",
  // under his rule that the evidence photo's GPS is the primary source of trust). "كهربا المرج" is North
  // Cairo Electricity's board photographed in the brick المرج: the company is on the sign and the town is
  // where the photo was taken. A word the brick supplies spends the whole allowance, and something on the
  // sign itself must still say WHICH place — a board that matched on the town alone would match every
  // building in it.
  const brickWords = placeAxis && input.photoBrick ? wordsOf(input.photoBrick) : [];

  let best: number | null = null;
  let matched = false;
  for (const [index, candidate] of haystacks.entries()) {
    const read = wordsOf(candidate);
    if (read.length === 0) continue;
    const onSign = wantedWords.filter((name) => nameWordIsThere(name, read));
    const fromBrick = wantedWords.filter((name) => !nameWordIsThere(name, read) && nameWordIsThere(name, brickWords));
    const missing = wantedWords.length - onSign.length - fromBrick.length;
    // With the brick's help, the sign's own word must say WHICH place (never صحة or جامعة), and the
    // sign must not call itself a clinic when the list holds a hospital ("عيادة النصر الشاملة" is not
    // مستشفى النصر in Helwan). The WHOLE reading is asked, because the place name the reader split out
    // ("النصر") has already lost the word عيادة.
    const signSaysWhich =
      fromBrick.length === 0 ||
      (onSign.some((name) => !nameWordIsThere(name, brickWords) && !NEVER_WHICH_BESIDE_A_BRICK.has(name.word)) &&
        !kindsClash(input.customerName ?? "", haystacks.join(" ")));
    // On the person axis the allowance is never spent on his given name standing behind another
    // man's: a name read off the sign opens on one of HIS words, and the sign's whole text carries
    // his words as one run that opens on his given name (`readsTheCustomersName`).
    const isTheName = placeAxis || readsTheCustomersName(customerWords, read, allowedMisses, index >= preferred.length);
    if (missing <= (fromBrick.length > 0 ? 0 : allowedMisses) && signSaysWhich && isTheName) matched = true;
    const score = jaccardSimilarity(nameTokens(candidate), nameTokens(input.customerName));
    best = best === null ? score : Math.max(best, score);
  }

  if (best === null) return { matches: null, score: null };
  return { matches: matched, score: Math.round(best * 100) / 100 };
}

// ── More than one signboard in the frame ────────────────────────────────────────────────────────
//
// 🔴 ONE PHOTOGRAPH, SEVERAL SIGNS, AND THE READER USED TO HAND BACK ONE BAG OF NAMES. Read off
// production on 2026-10-09, the five places this check had held: FOUR of the five holds were wrong,
// and not one of them was wrong about a letter.
//
//   رضوان محمد           "DOKANAT / BANAT EL BALAD / WOMEN'S & KIDS' STYLE" — the clothes shop beside
//                        the practice, because it is the biggest and clearest board in the frame.
//   اسلام عبدالعال        "Clin ic 4" — a room sign — with its own note saying the Arabic above it was
//                        "not clear enough to transcribe confidently". The nameplate was never read.
//   احمد صباح الشعراوي   "دكتور أحمد الشرباوي", noting the board was unclear beyond that one line.
//   محمد فرج             "محمد فريد" off one line, the others "not confidently readable" — and NO board
//                        text stored at all, so the flag carried no evidence of itself.
//   مستشفى المنشاوى العام "TANTA GENERAL HOSPITAL". The one true hold of the five.
//
// So the reader returns EVERY sign it can see — each with its own text, names, box, legibility and
// whether it looks medical — and the choosing happens HERE, under three rules:
//
//   1. 🔴 ANY SIGN THAT NAMES THE CUSTOMER IS A MATCH. A practice plate beside a clothes shop is
//      still the practice; an Egyptian doorway carries four boards and the largest is rarely the one.
//   2. 🔴 A HOLD NEEDS A SIGN THAT WAS READ CLEARLY. When nothing in the frame was, the verdict is
//      `unjudged` and the night reads it again — the module's own safety property (no answer never
//      holds) one level down: a PARTIAL answer is not an answer either. It un-files three of the
//      four above on its own.
//   3. 🔴 A FLAG CARRIES ITS OWN EVIDENCE OR IT IS NOT A FLAG. محمد فرج was held with `signText`
//      null: nothing of the board could be put in front of the person adjudicating it.
//
// Legibility and kind come from the reader as fields. They are NEVER inferred from its prose note —
// three of the four hedges above were sitting in that note, and parsing prose would make the verdict
// depend on which language the note came back in.

/** How much of one sign the reader could actually read. Only `clear` may hold a place. */
export type SignboardLegibility = "clear" | "partial" | "unreadable";

/**
 * What the sign is for. `other` is the clothes shop — the only value that can take a sign OUT of the
 * running; `unknown` counts as possibly the practice's own, because a reader unsure which trade a
 * board belongs to is not evidence that the place is not a practice.
 */
export type SignboardKind = "medical" | "other" | "unknown";

/** One signboard in the photograph. */
export type PhoenixCrmSign = {
  /** Verbatim, in its own script. */
  text: string | null;
  personNames: string[];
  placeNames: string[];
  /** Where it sits in the READ image, as fractions of width and height. Null when none was given. */
  box: { left: number; top: number; width: number; height: number } | null;
  legibility: SignboardLegibility;
  kind: SignboardKind;
};

const HAS_ARABIC = /[؀-ۿ]/;
const HAS_LATIN = /[A-Za-z]/;

/** Is there anything on this sign to judge at all? */
function signCarriesAName(sign: PhoenixCrmSign): boolean {
  return sign.text !== null || sign.personNames.length > 0 || sign.placeNames.length > 0;
}

/** A practice's own sign sorts before another trade's, and an unsure one sits between them. */
function tradeRank(sign: PhoenixCrmSign): number {
  return sign.kind === "medical" ? 0 : sign.kind === "unknown" ? 1 : 2;
}

function boxArea(sign: PhoenixCrmSign): number {
  if (!sign.box) return 0;
  return Math.max(0, sign.box.width) * Math.max(0, sign.box.height);
}

/**
 * The Arabic words of a name, compiled into the English spellings they accept.
 *
 * 🔴 AM AND PM TAKE DIFFERENT FOLDS, for the reason the header of this file gives: `distinctiveWords`
 * stems a facility name correctly ("مستشفى" and "عام" say WHAT it is, never WHICH one) and would stem
 * a person's; `normalizeContactName` strips the honorifics and nothing else. `compileArabicWord`
 * takes the article off either way, so المنشاوى and منشاوى compile to the same pattern.
 */
type CompiledName = {
  /** The words that pinned. */
  words: PlaceWord[];
  /** How many words of the name were worth pinning at all. */
  total: number;
  /**
   * True when EVERY word pinned — the only state in which a cross-script reading may HOLD a place.
   * One word that cannot be pinned does not stop a match (the quorum below allows a long name to
   * lose one), but it does stop a flag, because a word that cannot be expressed in Latin letters
   * cannot be shown to be ABSENT from a Latin sign.
   */
  pinnable: boolean;
};

/** A second ال inside a word, after the article at the front has been taken off. */
const INNER_ARTICLE = /^(?:ال|أل)?.*ال/u;

function compiledNameWords(name: string, listType: PhoenixCrmListType): CompiledName {
  const tokens = (
    listType === "PM" ? normalizeContactName(name).split(" ").filter(Boolean) : distinctiveWords(name)
  ).filter((token) => token.length >= 3);
  const words: PlaceWord[] = [];
  let pinnable = tokens.length > 0;
  for (const token of tokens) {
    // 🔴 THE عبد COMPOUND IS THE COMPILER'S BLIND SPOT, measured 2026-10-09: عبدالعال compiles to a
    // pattern demanding the inner article's alif as a literal "a", while English writes that syllable
    // "abdel" — so "Dr Islam Abdelaal" fails a pattern it should satisfy. Every word with a SECOND ال
    // inside it has the same shape (عبدالرحمن, نورالدين), so none of them is counted either way.
    // 🔴 Do NOT "fix" this by loosening `compileArabicWord`: that table carries the whole of Egypt's
    // brick geography and is pinned by the geo module's own tests.
    if (INNER_ARTICLE.test(token.replace(/^(?:ال|أل)/u, "")) || INNER_ARTICLE.test(token.slice(2))) {
      pinnable = false;
      continue;
    }
    const one = compileArabicWord(token);
    if (!one) {
      pinnable = false;
      continue;
    }
    words.push(one);
  }
  return { pinnable, total: tokens.length, words };
}

/**
 * Can this customer's name be pinned in Latin letters at all?
 *
 * 🔴 ONLY A PINNABLE NAME MAY BE HELD ON A SIGN IN THE OTHER SCRIPT. A cross-script reading is
 * allowed to find a MATCH on the quorum below, and is never allowed to file a flag on a name whose
 * own spelling this scheme cannot express — "it is not here" and "I cannot write it down" are not
 * the same sentence, and the second one is the module's `unjudged`.
 */
export function nameIsPinnableAcrossScripts(customerName: string | null, listType: PhoenixCrmListType): boolean {
  if (!customerName || !HAS_ARABIC.test(customerName)) return false;
  const compiled = compiledNameWords(customerName, listType);
  return compiled.pinnable && compiled.words.length > 0;
}

/** Does any name on this sign's judged axis use the customer's own script? */
export function signSharesCustomerScript(
  sign: PhoenixCrmSign,
  input: { customerName: string | null; listType: PhoenixCrmListType },
): boolean {
  if (!input.customerName) return false;
  const customerIsArabic = HAS_ARABIC.test(input.customerName);
  const preferred = input.listType === "PM" ? sign.personNames : sign.placeNames;
  const candidates = [...preferred, ...(sign.text ? [sign.text] : [])];
  return candidates.some((candidate) => HAS_ARABIC.test(candidate) === customerIsArabic);
}

/**
 * Does an Arabic name and a Latin one name the same customer?
 *
 * 🔴 WITHOUT THIS, A HOSPITAL THAT SIGNS ITSELF IN ENGLISH CAN NEVER MATCH ITS OWN ARABIC LIST ROW.
 * `normalizeContactName` and `normalizeName` both leave each script where it is, deliberately — so
 * مستشفى المنشاوى العام against "EL MENSHAWY GENERAL HOSPITAL" scores 0 and is held for its SCRIPT
 * rather than for its name. The compiler is the house one, `compileArabicWord` in
 * src/lib/geo/arabic-place-match.ts, written for exactly this split in Egypt's own geography data —
 * never a transliteration table of this module's own.
 *
 * The quorum is always counted on the CUSTOMER's words, in either direction: every word of his name
 * must be on the sign, and a name of three words or more may lose one. A sign is free to carry extra
 * words — "عيادات", "Dr", a floor, a telephone number — and usually does.
 *
 * 🔴 IT ANSWERS FALSE RATHER THAN GUESSING, AND ONE SHAPE IT CANNOT PIN IS THE عبد COMPOUND.
 * Measured 2026-10-09: عبدالعال compiles to a pattern demanding the article's alif as a literal "a",
 * while English writes that syllable "abdel" — so اسلام عبدالعال against "Dr Islam Abdelaal" answers
 * false, and the place is then decided by LEGIBILITY rather than by this. That is the safe direction:
 * a false negative here only ever withholds a match, never invents one, and the alternative — pinning
 * on اسلام alone — is precisely the shared-first-name match this module refuses everywhere else. Do
 * not "fix" it by loosening `compileArabicWord`; it is pinned by the geo module's own tests and that
 * table carries Egypt's whole brick geography.
 */
export function nameMatchesAcrossScripts(input: {
  customerName: string;
  candidate: string;
  listType: PhoenixCrmListType;
}): boolean {
  const customerIsArabic = HAS_ARABIC.test(input.customerName);
  const candidateIsArabic = HAS_ARABIC.test(input.candidate);
  // Same script on both sides is the fold's own job, and it has already answered.
  if (customerIsArabic === candidateIsArabic) return false;

  const arabicSide = customerIsArabic ? input.customerName : input.candidate;
  const latinSide = customerIsArabic ? input.candidate : input.customerName;
  if (!HAS_LATIN.test(latinSide)) return false;

  const compiled = compiledNameWords(arabicSide, input.listType);
  const latinWords = addressWords(latinSide);
  if (compiled.words.length === 0 || latinWords.length === 0) return false;

  // Whichever side is Arabic holds the patterns; the CUSTOMER's own side holds the quorum, in either
  // direction. A name of three words or more may lose one — and a word that could not be pinned at
  // all spends exactly that allowance, never less.
  if (customerIsArabic) {
    const satisfied = compiled.words.filter((word) =>
      latinWords.some((candidate) => word.pattern.test(candidate)),
    ).length;
    const misses = compiled.total - satisfied;
    return misses <= (compiled.total >= 3 ? 1 : 0);
  }
  const satisfied = latinWords.filter((candidate) =>
    compiled.words.some((word) => word.pattern.test(candidate)),
  ).length;
  const misses = latinWords.length - satisfied;
  return misses <= (latinWords.length >= 3 ? 1 : 0);
}

/** Does THIS sign name the customer — in his own script, or across the two? */
export function signNamesCustomerOnSign(
  sign: PhoenixCrmSign,
  input: { customerName: string | null; listType: PhoenixCrmListType; photoBrick?: string | null },
): { matches: boolean | null; score: number | null } {
  const sameScript = signNamesCustomer({
    customerName: input.customerName,
    listType: input.listType,
    personNames: sign.personNames,
    photoBrick: input.photoBrick ?? null,
    placeNames: sign.placeNames,
    signText: sign.text,
  });
  if (sameScript.matches === true || !input.customerName) return sameScript;

  const preferred = input.listType === "PM" ? sign.personNames : sign.placeNames;
  for (const candidate of [...preferred, ...(sign.text ? [sign.text] : [])]) {
    if (nameMatchesAcrossScripts({ candidate, customerName: input.customerName, listType: input.listType })) {
      return { matches: true, score: sameScript.score };
    }
  }
  return sameScript;
}

/**
 * Which sign the stored record shows, when none of them named the customer.
 *
 * 🔴 NEVER THE LARGEST BOARD ON A PM CAPTURE. The plate carrying a person's name is the practice's
 * own, and it is routinely the smallest thing in the photograph — the clothes shop that held رضوان
 * محمد was both the biggest and the most legible sign in the frame. An AM capture is the other way
 * round: a hospital's own board IS the big one, so there the largest sign naming a PLACE wins.
 */
export function chooseSignboard(
  signs: readonly PhoenixCrmSign[],
  listType: PhoenixCrmListType,
): PhoenixCrmSign | null {
  if (signs.length === 0) return null;
  const clear = signs.filter((sign) => sign.legibility === "clear" && signCarriesAName(sign));
  const pool = clear.length > 0 ? clear : signs.filter(signCarriesAName);
  if (pool.length === 0) return signs[0] ?? null;

  if (listType === "PM") {
    const named = pool.filter((sign) => sign.personNames.length > 0);
    if (named.length > 0) {
      // A practice's plate before another trade's board, and then the SMALLEST — at an Egyptian door
      // the nameplate is the small plate and the big board above it belongs to the building or to the
      // neighbour.
      return [...named].sort(
        (left, right) => tradeRank(left) - tradeRank(right) || boxArea(left) - boxArea(right),
      )[0];
    }
    const medical = pool.filter((sign) => sign.kind !== "other");
    return medical[0] ?? pool[0];
  }

  const places = pool.filter((sign) => sign.placeNames.length > 0);
  const ranked = places.length > 0 ? places : pool;
  return [...ranked].sort((left, right) => boxArea(right) - boxArea(left))[0];
}

/**
 * Which sign is worth cropping out of the frame and reading again.
 *
 * 🔴 NOT THE SAME QUESTION AS `chooseSignboard`, AND GETTING THEM CONFUSED HELD رضوان محمد A SECOND
 * TIME. That photograph holds a clothes shop read CLEARLY and, above it, a practice board read only
 * in part — "مركز الدكتور رضوان القصصي". `chooseSignboard` prefers a sign that was read clearly,
 * because that is the sign worth QUOTING; the sign worth READING AGAIN is the opposite one, the one
 * that defeated the reader and that would answer the question if it had not.
 *
 * So: a sign that answers the question being asked (a PERSON for PM, a PLACE for AM) first, then the
 * one NOT already read clearly, then a practice's own board over another trade's, and then the
 * biggest — it has the most letters to recover. Only a sign with a box can be cropped at all.
 */
export function chooseSignToReadAgain(
  signs: readonly PhoenixCrmSign[],
  listType: PhoenixCrmListType,
): PhoenixCrmSign | null {
  const answers = (sign: PhoenixCrmSign): number =>
    (listType === "PM" ? sign.personNames.length > 0 : sign.placeNames.length > 0) ? 0 : 1;
  const unread = (sign: PhoenixCrmSign): number => (sign.legibility === "clear" ? 1 : 0);
  const candidates = signs.filter((sign) => sign.box !== null);
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (left, right) =>
      answers(left) - answers(right) ||
      unread(left) - unread(right) ||
      tradeRank(left) - tradeRank(right) ||
      boxArea(right) - boxArea(left),
  )[0];
}

// ── A board too full for one answer ─────────────────────────────────────────────────────────────
//
// 🔴 A HOSPITAL'S BOARD OF FORTY PLATES DID NOT FIT IN ONE ANSWER, AND IT WAS A LOST CALL FOR EVER
// (2026-10-18). The one-off read of the old places left two places of one rep unanswered: both photos
// are the same wall of about forty plates, د. طلعت فواد among them, and Claude ran out of room before
// it finished listing them (max_tokens) on all four calls. A lost call is read again every night, so
// that photo would have been paid for nightly and never read. The door is now told to photograph
// exactly this board inside a hospital. So a whole-photo read that runs out of room is read again in
// four overlapping quarters, side by side, and every plate's box is put back into the whole photo.

/** How far two neighbouring quarters overlap: a plate smaller than this is whole in one of them. */
export const SIGNBOARD_PART_OVERLAP = 0.2;

/** One part of the photo, as fractions of the whole image. */
export type SignboardPart = { left: number; top: number; width: number; height: number };

/** The four overlapping quarters a board too full for one answer is read in. */
export function signboardQuarters(): SignboardPart[] {
  const size = (1 + SIGNBOARD_PART_OVERLAP) / 2;
  const far = 1 - size;
  return [
    { height: size, left: 0, top: 0, width: size },
    { height: size, left: far, top: 0, width: size },
    { height: size, left: 0, top: far, width: size },
    { height: size, left: far, top: far, width: size },
  ];
}

/**
 * Ask every reader AT ONCE and keep the answer of the FIRST ONE IN THE LIST that gives one: a later
 * reader's answer is used only once every reader before it has come back empty, however early it
 * arrived — or once `settleAfterMs` has passed with it in hand, when the readers before it are given up
 * on. A reader that throws counts as empty. The moment the answer is settled, every read still running
 * is stopped through `signal`, so a read nobody needs any more never runs on into a failure row.
 *
 * The door's first look (`hedgedAnswer` in `server/signboard-check.ts`): the fast reader is already
 * reading when the strong one runs long.
 */
export function firstInListToAnswer<R, T>(
  readers: readonly R[],
  ask: (reader: R, signal: AbortSignal) => Promise<T | null>,
  settleAfterMs?: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const stop = new AbortController();
    // undefined: still reading. null: came back empty.
    const answers: (T | null | undefined)[] = readers.map(() => undefined);
    let late = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (value: T | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop.abort();
      resolve(value);
    };
    const decide = () => {
      for (const answer of answers) {
        if (answer === undefined) {
          // Before the deadline a reader still reading outranks every answer behind it.
          if (!late) return;
          continue;
        }
        if (answer !== null) return settle(answer);
      }
      // Late with nothing in hand: the readers still reading are left to answer or run out themselves.
      if (!answers.includes(undefined)) settle(null);
    };

    readers.forEach((reader, index) => {
      Promise.resolve()
        .then(() => ask(reader, stop.signal))
        .then(
          (answer) => {
            answers[index] = answer ?? null;
            decide();
          },
          () => {
            answers[index] = null;
            decide();
          },
        );
    });
    if (settleAfterMs !== undefined) {
      timer = setTimeout(() => {
        late = true;
        decide();
      }, Math.max(0, settleAfterMs));
    }
    decide();
  });
}

/**
 * How long the four quarter reads get once a whole-photo answer ran out of room: what the PLACE has left,
 * capped like any one call — never what the whole read's own cap left over.
 *
 * 🔴 ON THE LEFTOVER, A FULL BOARD WAS NEVER READ IN THE HELD RE-READ (20 Oct 2026). Sonnet filled its
 * answer in 13.7–15.7 s of the 20 s per-call cap, the quarters got the 4.3–6.3 s left and timed out —
 * each pair summed to exactly 20,000 ms, with 25 s of the place's 45 s still unspent — and after three
 * such lost reads the place went to the Super Admin unread. The place's own deadline already bounds what
 * a place costs; the per-call cap only stops one hung call from eating the fallback's time.
 */
export function signboardPartsTimeoutMs(placeLeftMs: number, callCapMs: number): number {
  return Math.max(0, Math.min(placeLeftMs, callCapMs));
}

/** Did the reader fail because its answer did not fit — the one failure that reading in parts cures? */
export function readerRanOutOfRoom(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /max_tokens|max_output_tokens/i.test(message);
}

/** What one part's reading carries, before the reader that answered is added back. */
export type SignboardPartReading = {
  signs: PhoenixCrmSign[];
  signPresent: boolean | null;
  note: string | null;
  problem: SignboardPhotoProblem | null;
  turn: "clockwise" | "counterclockwise" | "upside_down" | null;
};

/**
 * The four parts' readings as one reading of the whole photo. Each sign's box is put back into the
 * whole image; a plate the overlap shows twice is listed twice, which no rule minds — any sign that
 * names him is a match, and a flag needs one clear sign. The reader's word on the photo stands only
 * where the parts agree: "none" when any part found a legible plate, a turn only when all four say it.
 */
export function mergeSignboardParts(
  readings: readonly SignboardPartReading[],
  parts: readonly SignboardPart[],
): SignboardPartReading {
  const signs = readings.flatMap((reading, index) =>
    reading.signs.map((sign) => {
      const part = parts[index];
      if (!sign.box || !part) return { ...sign };
      return {
        ...sign,
        box: {
          height: sign.box.height * part.height,
          left: part.left + sign.box.left * part.width,
          top: part.top + sign.box.top * part.height,
          width: sign.box.width * part.width,
        },
      };
    }),
  );
  const problems = readings.map((reading) => reading.problem);
  const turns = readings.map((reading) => reading.turn);
  const notes = readings.map((reading) => reading.note).filter((note): note is string => Boolean(note));
  return {
    note: ["A board of many plates, read in four parts.", ...notes].join(" "),
    problem: problems.includes("none") ? "none" : (problems.find((problem) => problem !== null) ?? null),
    signPresent: readings.some((reading) => reading.signPresent === true)
      ? true
      : readings.length > 0 && readings.every((reading) => reading.signPresent === false)
        ? false
        : null,
    signs,
    turn: turns.length > 0 && turns.every((turn) => turn !== null && turn === turns[0]) ? turns[0] : null,
  };
}

/**
 * Turn every sign in the photograph into one verdict.
 *
 * The owner's two rulings are untouched: a confident "no signboard of any kind" still holds, and an
 * AM signboard that names nobody is still a match. What changed is everything between — which sign is
 * read, and what a partially-read frame is allowed to conclude.
 */
export function judgeSignboards(input: {
  customerName: string | null;
  listType: PhoenixCrmListType;
  signPresent: boolean | null;
  signs: readonly PhoenixCrmSign[];
  note: string | null;
  croppedFraction: number;
  /** The reader's own word on what stops the name being read; kept, never judged on. */
  problem?: SignboardPhotoProblem | null;
  /** The brick the photo's GPS resolved to — the town word of an AM name (`signNamesCustomer`). */
  photoBrick?: string | null;
}): PhoenixCrmSignboardCheck {
  const signs = [...input.signs];
  const anythingRead = signs.some(signCarriesAName);

  const record = (
    chosen: PhoenixCrmSign | null,
    verdict: SignboardVerdictKind,
    reason: SignboardCheckReason | null,
    nameScore: number | null,
  ): PhoenixCrmSignboardCheck => ({
    attempts: 1,
    checkedAt: new Date().toISOString(),
    croppedFraction: input.croppedFraction,
    nameScore,
    note: input.note,
    personNames: chosen ? [...chosen.personNames] : [],
    placeNames: chosen ? [...chosen.placeNames] : [],
    reason,
    signText: chosen?.text ?? null,
    signs,
    verdict,
    ...(input.problem !== undefined ? { problem: input.problem } : {}),
  });

  const fallback = chooseSignboard(signs, input.listType);

  // 1 · NO SIGNBOARD AT ALL, said confidently — the owner's first ruling, unchanged.
  if (input.signPresent === false && !anythingRead) return record(fallback, "no_name", "sign_no_name", null);

  // 2 · ANY sign that names him is a match — 🔴 UNLESS THE READER SAYS THE PHOTO HOLDS NO NAMEPLATE AT
  //     ALL, ON A PM CAPTURE (owner, 2026-10-18: a paper photo is sent back for a nameplate). Four places
  //     had confirmed that way: two prescription pads held in the hand, a printed clinic schedule, and a
  //     street seen through a car windscreen — a name on paper travels with the rep and proves no
  //     doorway. It is the photo's fault, so it is asked for again (`signboardAsksForAPhoto`). AM keeps
  //     his own rule: a hospital signs itself.
  const paperOnly = input.listType === "PM" && input.problem === "no_plate";
  let best: number | null = null;
  for (const sign of signs) {
    const { matches, score } = signNamesCustomerOnSign(sign, input);
    if (score !== null) best = best === null ? score : Math.max(best, score);
    if (matches === true) return paperOnly ? record(sign, "unjudged", "unreadable", score ?? best) : record(sign, "match", null, score ?? best);
  }

  // 3 · Nothing in the frame was read CLEARLY, so nothing in it can hold the place.
  const clearNamed = signs.filter((sign) => sign.legibility === "clear" && signCarriesAName(sign));
  if (clearNamed.length === 0) return record(fallback, "unjudged", "unreadable", best);

  // 4 · THE AM HALF OF "NEVER A PERSON": an AM frame whose clear signs name no place at all is a
  //     match — the hospital signs its departments, or only the people holding clinics inside it.
  if (input.listType !== "PM" && clearNamed.every((sign) => sign.placeNames.length === 0)) {
    return record(fallback, "match", null, best);
  }

  // 5 · 🔴 SOMETHING IN THE FRAME DEFEATED THE READER, AND NOTHING IT DID READ ANSWERS THE QUESTION
  //     BEING ASKED — a PERSON for PM, a PLACE for AM. The sign that would have answered is exactly
  //     the one it could not read, so the photograph has not been judged yet. This is the rule that
  //     un-files رضوان محمد (a clothes shop read clearly beside a faded practice board) and
  //     اسلام عبدالعال (a room sign read clearly under an Arabic nameplate it could not transcribe):
  //     both carry a PLACE name on a PM capture, which says nothing about whose doorway it is.
  const couldNotRead = signs.some((sign) => sign.legibility !== "clear");
  const answersTheQuestion = clearNamed.filter((sign) =>
    input.listType === "PM" ? sign.personNames.length > 0 : sign.placeNames.length > 0,
  );
  if (couldNotRead && answersTheQuestion.length === 0) return record(fallback, "unjudged", "unreadable", best);

  // 5b · Every sign read clearly belongs to another trade while something else could not be read:
  //      the practice's own board is the one that was missed.
  if (couldNotRead && clearNamed.every((sign) => sign.kind === "other")) {
    return record(fallback, "unjudged", "unreadable", best);
  }

  // 5c · 🔴 A FLAG IS NEVER FILED ACROSS TWO SCRIPTS ON A NAME THIS SCHEME CANNOT WRITE DOWN. Every
  //      sign that answers the question names in the other script, none matched, and the customer's
  //      own name does not pin in Latin letters — "it is not here" and "I cannot write it down" are
  //      different sentences. The first may hold (مستشفى المنشاوى العام against "TANTA GENERAL
  //      HOSPITAL" pins منشاوى and is a true flag); the second never does.
  if (
    answersTheQuestion.length > 0 &&
    answersTheQuestion.every((sign) => !signSharesCustomerScript(sign, input)) &&
    !nameIsPinnableAcrossScripts(input.customerName, input.listType)
  ) {
    return record(fallback, "unjudged", "not_comparable", best);
  }

  // 6 · A clear sign names somebody else — or, on PM, names no person at all, which is the owner's
  //     "no nameplate" case and is held rather than accepted.
  const namesNobody = input.listType === "PM" && clearNamed.every((sign) => sign.personNames.length === 0);
  // 🔴 A FLAG CARRIES ITS OWN EVIDENCE, and it is step 3 that guarantees it rather than a check here:
  // `signCarriesAName` is what makes a sign eligible to be clear-and-named at all, so a frame whose
  // only clear sign holds no text and no names cannot reach this line. A guard here would be dead
  // code pretending to be a safety net — محمد فرج was held with `signText` null because its board was
  // read in PART, which step 3 is what refuses.
  return record(
    fallback,
    namesNobody ? "no_name" : "other_name",
    namesNobody ? "sign_no_name" : "sign_other_name",
    best,
  );
}

/** One sign, for a reader that answered in the old single-signboard shape. */
export function asOneSign(input: {
  signText: string | null;
  personNames: readonly string[];
  placeNames: readonly string[];
}): PhoenixCrmSign {
  return {
    box: null,
    kind: "unknown",
    legibility: "clear",
    personNames: [...input.personNames],
    placeNames: [...input.placeNames],
    text: input.signText,
  };
}

/** A pharmacy is not validated against a person or a practice, so it is not asked this question. */
export function signboardApplies(listType: PhoenixCrmListType): boolean {
  return listType !== "Pharmacy";
}

/**
 * The same value with every character `jsonb` REFUSES taken out of its strings.
 *
 * 🔴 ONE SUCH CHARACTER THREW A WHOLE VERDICT AWAY, SILENTLY. Postgres rejects the NUL and a
 * surrogate left without its pair outright, `recordPlaceSignboard` swallows its error by design, and
 * the place then stays in the nightly backlog for ever — re-read every night, never recorded. A model
 * transcribing a damaged or half-lit signboard emits both. Both are DROPPED rather than replaced: they
 * carry no meaning in a transcription, and a replacement character would read as something the sign
 * said. Everything else — Arabic, an emoji, an unmatched quote — is kept exactly as it was read.
 */
export function jsonbSafe<T>(value: T): T {
  const clean = (text: string): string =>
    text
      .replace(/\u0000/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1");
  return JSON.parse(
    JSON.stringify(value, (_key, inner) => (typeof inner === "string" ? clean(inner) : inner)),
  ) as T;
}

/**
 * "No answer was obtained, and here is why" — the record every absence takes.
 *
 * 🔴 IT IS STILL WRITTEN, and that is the point: without it the place row cannot tell NOT CHECKED
 * from CHECKED AND CLEAN, which is the distinction the nightly photo sweep's own rules insist on for
 * the same reason. It is the shape the server builds on a missing key, missing bytes or a failed
 * call, and the shape a place held for another reason takes so no second model call is ever paid for.
 */
export function signboardUnjudged(
  reason: SignboardCheckReason,
  croppedFraction: number | null = null,
): PhoenixCrmSignboardCheck {
  return {
    attempts: 1,
    checkedAt: new Date().toISOString(),
    croppedFraction,
    nameScore: null,
    note: null,
    personNames: [],
    placeNames: [],
    reason,
    signs: [],
    signText: null,
    verdict: "unjudged",
  };
}

/**
 * How many times one frame is read before the answer "nobody can read this" is made final.
 *
 * Three, not more: the first night's 42 unreadable frames cost 42 calls, and three attempts each is
 * 126 across the whole backlog — a one-off price paid once per place, never a loop. The counter lives
 * on the row (`attempts`), so a night that crashes cannot reset it.
 */
export const SIGNBOARD_MAX_READ_ATTEMPTS = 3;

/**
 * The next check to store for a place that has been read before.
 *
 * It carries the attempt count forward and, when the model has now had every attempt it gets and
 * still could not read the frame, moves the reason from `unreadable` (which the backlog re-reads) to
 * `unreadable_final` (which it does not). 🔴 THE TERMINAL REASON IS WHAT STOPS THE LOOP, not the
 * counter — a backlog query over a JSON number is exactly the kind of filter that reads as empty
 * when it is wrong, so the stopping condition is a value a human can see in the row.
 */
export function signboardNextAttempt(
  check: PhoenixCrmSignboardCheck,
  priorAttempts: number,
): PhoenixCrmSignboardCheck {
  const attempts = Math.max(1, priorAttempts) + 1;
  const exhausted = attempts >= SIGNBOARD_MAX_READ_ATTEMPTS;
  // 🔴 THE STRONG READER'S "UNREADABLE" IS FINAL AT ONCE (owner, 2026-10-18: re-reading the same photo
  // is "a total wasting of money"). The three attempts were bought for a cheap reader that misread
  // plates a person reads at a glance; the same photo read again by the same strong reader is the same
  // answer, paid for again. Only a fallback's answer — after the strong one lost its call — keeps a try.
  const spent = (exhausted || check.strongRead === true) && check.verdict === "unjudged" && check.reason === "unreadable";
  return { ...check, attempts, reason: spent ? "unreadable_final" : check.reason };
}

/**
 * What the database keeps when a signboard HOLDS the place — the review row's evidence.
 *
 * 🔴 IT LANDS IN A COLUMN LITERALLY NAMED `google`, AND THE NAME IS WRONG RATHER THAN THE CODE.
 * `phoenix_crm_validation_reviews.google` was added when the Google listing comparison was the only
 * thing that could hold a place; it is generically "the evidence the system judged on", and the one
 * review row per place (its UNIQUE index on `place_id`) is the only slot there is. Renaming it would
 * be a migration across two 300-line security-definer functions, the queue loader and its board, for
 * no behaviour at all — so `verdict: "signboard"` says which detector spoke and this comment says the
 * column name is a leftover. Do not "fix" the record into the Google shape to match the column.
 */
export function signboardHoldRecord(
  check: PhoenixCrmSignboardCheck,
  point: { lat: number; lon: number; accuracyMeters: number | null; source: string },
): Record<string, unknown> {
  return {
    verdict: "signboard",
    reason: check.reason,
    checkedAt: check.checkedAt,
    signText: check.signText,
    personNames: check.personNames,
    placeNames: check.placeNames,
    note: check.note,
    nameScore: check.nameScore,
    croppedFraction: check.croppedFraction,
    signs: check.signs,
    point: { lat: point.lat, lon: point.lon, accuracyMeters: point.accuracyMeters, source: point.source },
    // The queue renders Google's candidate listings from this key. A signboard hold has none, and an
    // empty list is what the loader already treats as "nothing to show" — never a missing key.
    listings: [],
  };
}

/**
 * One signboard, judged. `judgeSignboards` above is the real rule set; this is the one-sign door
 * through it, kept because a reader that answered in the old shape — and `schedule-rules.ts`, which
 * reads a TIMETABLE and has one photograph of one sheet by definition — has exactly one sign.
 *
 * 🔴 The AM half of the owner's rule is in there as well as in `signNamesCustomer`: a capture that is
 * not PM is never given `no_name`, however empty `personNames` is. A hospital that signs itself and
 * nobody else is exactly right, and the check must say so.
 */
export function judgeSignboard(input: {
  customerName: string | null;
  listType: PhoenixCrmListType;
  signPresent: boolean | null;
  signText: string | null;
  personNames: readonly string[];
  placeNames: readonly string[];
  note: string | null;
  croppedFraction: number;
}): PhoenixCrmSignboardCheck {
  return judgeSignboards({
    croppedFraction: input.croppedFraction,
    customerName: input.customerName,
    listType: input.listType,
    note: input.note,
    signPresent: input.signPresent,
    signs: [asOneSign(input)],
  });
}

/**
 * Is this verdict a CONFIDENT NEGATIVE — a sign read clearly that names somebody else, or no person at a
 * PM door?
 *
 * 🔴 It was the DOOR's hold until 2026-10-17, and `unjudged` was false here in every one of its reasons:
 * the key has run out of credits twice in this system's life, and a hold on the absence of an answer
 * would have stopped every validation in the field. The door asks `signboardDoorHolds` below since the
 * owner's "Hold; re-read; else you decide"; this stays the narrower question — the verdicts that name a
 * negative — and an `unjudged` is still never one.
 */
export function signboardHoldsForReview(check: PhoenixCrmSignboardCheck): boolean {
  return check.verdict === "other_name" || check.verdict === "no_name";
}

/**
 * Does the DOOR save this place held, waiting on the system and then on the Super Admin?
 *
 * 🔴 EVERYTHING BUT A MATCH, SINCE 2026-10-17 (owner: *"how come any unreadable should be not
 * validated, should be wait until the system check and I manual approve or reject"*, answered "Hold;
 * re-read; else you decide"). Before that day an unreadable frame was VALIDATED, and the cheap reader
 * confirmed 1 of 30 production photos a person reads at a glance — so 79% of the places in use had no
 * confirmation at all. A lost call and a missing key hold too (his answer for a reading service that is
 * down: *"try to reread, try to fix, try to fall back on other way. If you couldn't read them, then
 * hold for manual review"*).
 *
 * The 2026-10-08 reason never to hold on an absence — the key ran dry twice and would have held every
 * validation in the field — is answered by WHAT a hold is now, not by refusing to hold: the rep is
 * saved and reads "the system is checking", and `server/signboard-holds.ts` re-reads every held place
 * and approves the confirmed ones itself, so a day with no key is a day of held places that settle once
 * the key is back. `signboardHoldsForReview` above still answers the narrower question the integrity
 * board asks (a confident negative).
 *
 * A place another check already holds (`held_elsewhere`) is not held twice: one review row, one decision.
 * A name with nothing to compare (`name_unusable`) is not held either — no reading can ever answer it,
 * so a hold would only spend every re-read on a question that does not exist.
 */
export function signboardDoorHolds(check: PhoenixCrmSignboardCheck): boolean {
  if (check.verdict === "match") return false;
  return check.reason !== "held_elsewhere" && check.reason !== "name_unusable";
}

/**
 * How many times the system reads a HELD place before it is the Super Admin's alone: the door's read
 * and ONE re-read. Counted on the place's own `signboard_check.attempts`, the door's read being the first.
 *
 * 🔴 IT WAS 4 UNTIL 2026-10-18 (owner, 2026-10-17, "re-read up to 3 times"), AND THE OWNER STOPPED IT THE
 * NEXT DAY: one held photo cost typically 10 and at most 13 answered model calls, on a photograph that
 * never changes between reads. The one re-read keeps what earned its place — its second look and the
 * guided spot check confirmed one more of the 21 replayed photos than the door alone — and a photo
 * still not confirmed after it is fixed by a NEW photo (the door's scanner, the rep's retake), never by
 * reading the old one again.
 */
export const SIGNBOARD_HELD_MAX_READS = 2;

/**
 * Reads recorded on a place's stored `signboard_check`: none is 0, and a check written before the count
 * existed has had exactly one. The one reading of the count, for the re-read's queue and the board alike.
 */
export function signboardReadsRecorded(stored: unknown): number {
  if (!stored || typeof stored !== "object") return 0;
  const attempts = Number((stored as Record<string, unknown>).attempts ?? 0);
  return Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

/**
 * Is the system still reading this held place — a door signboard hold with reads left? The board says
 * so on the row, and the Super Admin is told it is his only once it is not (`server/signboard-holds.ts`).
 */
export function signboardHoldStillReading(input: { pending: boolean; signboardHold: boolean; isTest: boolean; stored: unknown }): boolean {
  return input.pending && input.signboardHold && !input.isTest && signboardReadsRecorded(input.stored) < SIGNBOARD_HELD_MAX_READS;
}

/**
 * Does any sign in this reading carry the customer's NAME — not merely a verdict of `match`?
 *
 * 🔴 THE DIFFERENCE IS THE OWNER'S AM RULE, AND IT MATTERS ONLY WHERE A READING WAS STEERED. An AM
 * frame whose clear signs name no place at all is a `match` (`judgeSignboards` step 4) — right for a
 * hospital that signs its departments, and a blind reader cannot be steered into it. The guided read
 * was TOLD the name, and measured on 40 production photos (2026-10-17) it wrote a decoy name it was
 * handed on 8 of 40 near-miss decoys, both AM hospitals among them; so its answer is accepted only
 * when a BLIND close look at the spot it pointed to reads the name itself — and step 4 would accept a
 * close look that read nothing but "صيدلية".
 */
export function signboardReadsCustomerName(
  signs: readonly PhoenixCrmSign[],
  input: { customerName: string | null; listType: PhoenixCrmListType },
): boolean {
  return signs.some((sign) => signNamesCustomerOnSign(sign, input).matches === true);
}

/**
 * What a held place's re-read concludes for the hold (owner, 2026-10-17).
 *
 *   approve — a reading confirmed the customer: the system approves the hold itself;
 *   again    — no confirmation yet, and the place has reads left;
 *   done     — no confirmation after every read it gets: it is the Super Admin's to decide, and he is
 *              told now rather than at the door.
 */
export function heldSignboardOutcome(check: PhoenixCrmSignboardCheck, readsSoFar: number): "approve" | "again" | "done" {
  if (check.verdict === "match") return "approve";
  return readsSoFar >= SIGNBOARD_HELD_MAX_READS ? "done" : "again";
}

/**
 * Did a held place's re-read READ anything — or did the reader never answer?
 *
 * 🔴 A LOST CALL IS NO READ, AND SPENDING ONE ON IT EMPTIES THE WHOLE QUEUE ONTO THE SUPER ADMIN. On
 * 18 Oct 2026 at 01:00 Cairo the AI account ran out of credit mid-way through the night's re-read of
 * the unreadable places — 241 of them came back `call_failed`, and production's own calls failed from
 * the same minute. Counted as reads, every place the door held that day would have spent its four in
 * the after-reply read and three hourly runs, been filed "every read spent", and paged him once each,
 * for photographs nobody had looked at — and then never been read again once the credit was back. So
 * a lost call, like a missing key, spends nothing and the place waits; the photo that cannot be decoded
 * at all is `no_bytes`, which is a read that answered, and spends one. A photo the bucket did not hand
 * back is a lost call too, and one place that keeps losing them is counted (`HELD_SIGNBOARD_MAX_LOST_READS`).
 */
export function heldSignboardReadHappened(check: PhoenixCrmSignboardCheck): boolean {
  return !(check.verdict === "unjudged" && (check.reason === "call_failed" || check.reason === "no_api_key"));
}

/** Unread places, with not one read answering, after which the hourly run stops: the reader is down. */
export const HELD_SIGNBOARD_READER_DOWN_AFTER = 3;

/**
 * Is the reader down, on this run's evidence? Only when NOTHING has answered: one photo whose every call
 * times out must not stop the queue behind it, and a reader that answered once is up.
 */
export function heldSignboardReaderIsDown(run: { unread: number; answered: number }): boolean {
  return run.answered === 0 && run.unread >= HELD_SIGNBOARD_READER_DOWN_AFTER;
}

/**
 * Hourly runs in a row whose re-read of ONE held place went unanswered while the same run read others,
 * after which that place is the Super Admin's.
 *
 * 🔴 A LOST CALL STILL SPENDS NOTHING, BUT ONE PHOTO CAN NO LONGER LOSE EVERY CALL FOR EVER (code review,
 * 19 Oct 2026). A dense board whose quarters run the readers out of room, or a photo the bucket will not
 * hand back, came back unread every hour: it never spent its re-read, stayed first in the oldest-first
 * queue, was paid for every hour, and he was never told. Counted only when the run READ another place —
 * a reader that is down answers nobody, so an outage still spends nothing — and reset by the first read
 * that answers, so three is three hours in a row on which this photo alone was the trouble.
 */
export const HELD_SIGNBOARD_MAX_LOST_READS = 3;

/** Unanswered re-reads in a row recorded on a held place's stored check; 0 when none. */
export function heldSignboardLostReads(stored: unknown): number {
  if (!stored || typeof stored !== "object") return 0;
  const lost = Number((stored as Record<string, unknown>).lostReads ?? 0);
  return Number.isFinite(lost) && lost > 0 ? Math.floor(lost) : 0;
}

/**
 * What to keep on a held place an hourly run could not read: the stored check with one more lost read,
 * or, at `HELD_SIGNBOARD_MAX_LOST_READS`, that check with every read spent — `done`, his to decide. Null
 * when the run read nothing at all (the reader is down) or there is no stored check to carry the count.
 */
export function heldSignboardLostReadToKeep(
  stored: unknown,
  runAnswered: number,
): { check: PhoenixCrmSignboardCheck; done: boolean } | null {
  if (runAnswered <= 0 || !stored || typeof stored !== "object") return null;
  const check = stored as PhoenixCrmSignboardCheck;
  const lostReads = heldSignboardLostReads(stored) + 1;
  if (lostReads < HELD_SIGNBOARD_MAX_LOST_READS) return { check: { ...check, lostReads }, done: false };
  return { check: { ...heldSignboardCheckToKeep(check, SIGNBOARD_HELD_MAX_READS, "done"), lostReads }, done: true };
}

/**
 * The check kept on the place row after a held re-read: the read itself, its count, and — on the last
 * read of a frame nobody could read — the terminal `unreadable_final`, so the row says "every read was
 * spent" in words a human can see (`SIGNBOARD_UNJUDGED_TEXT` on the board).
 */
export function heldSignboardCheckToKeep(
  read: PhoenixCrmSignboardCheck,
  reads: number,
  outcome: "approve" | "again" | "done",
): PhoenixCrmSignboardCheck {
  const spent = outcome === "done" && read.verdict === "unjudged" && read.reason === "unreadable";
  return { ...read, attempts: reads, reason: spent ? "unreadable_final" : read.reason };
}

/** A one-token name is not evidence of anything, here as everywhere else in this repository. */
export function signboardNameIsUsable(customerName: string | null): boolean {
  return isMatchableName(normalizeContactName(customerName));
}

// ── The signboard scanner at the door (2026-10-18) ──────────────────────────────────────────────
//
// 🔴 THE SIGNBOARD IS READ AT THE DOOR LIKE THE TIMETABLE: A PHOTO THAT DOES NOT SHOW A READABLE NAME
// IS REFUSED ON THE SPOT WITH WHAT TO FIX, 3 TRIES, THEN SAVED AND HELD. The owner's timetable rule of
// 2026-10-17 ("3 tries then held to confirmation by admin"), carried to the signboard on 2026-10-18
// after the audit of 532 places filed "Not readable": every one of them had been ACCEPTED at the door
// and found unreadable afterwards, when the rep had left and only a new photo could fix it. 10 reps
// carried half of them — a habit of photographing the street or the hospital front, which a refusal
// with the reason teaches in one visit.

/** The code a refused signboard photo is raised with; the rep's screen returns to the photo step on it. */
export const SIGNBOARD_RETAKE_CODE = "phoenix_crm_photo_signboard_retake";

/** Photos the door refuses before it saves and holds instead. The timetable's number, his. */
export const SIGNBOARD_DOOR_MAX_TRIES = 3;

/** The two refusal reasons the tries are counted under, as `phoenix_crm_refused_readings` stores them. */
export type SignboardRetakeReason = "signboard_unreadable" | "signboard_no_plate";

export type SignboardDoorAction =
  | { kind: "save" }
  | { kind: "hold"; tries: number }
  | { kind: "retake"; reason: SignboardRetakeReason; message: string; nextTry: number };

/**
 * Does this reading ask the rep for another photograph — is the PHOTO what stops the name being read?
 *
 * A read that ANSWERED and found no name it can use: no nameplate at a PM door (`no_name`), or nothing
 * read (`unreadable`) where the reader names something a new photo can fix — too far, blurred, dark,
 * cut off, no plate. Never `other_name` — a clear plate naming somebody else
 * is evidence, held for the Super Admin, not a bad photo — and never the absence of an answer
 * (`call_failed`, `no_api_key`, `no_bytes`): refusing on those would stop every validation in the field
 * the day the reader is down.
 *
 * 🔴 AND NEVER A PHOTO THE READER CALLS LEGIBLE (2026-10-18, the dry run's 20 photos opened by eye). A
 * clear plate reading "د. محمد زكي" for محمد ذكي, a clear board reading "مركز الدكتور رضوان التخصصي" for
 * رضوان محمد: the reader said `none`, the name did not confirm, and a new photograph of the same plate
 * reads the same. Nor decorative lettering (`stylised`): the one-off pass read "دكتور سلامة السيد البيودي"
 * twice off a clear board for سلامة اللبودي — one letter wrong, the same on every photo of that plate.
 * Nor an AM place's building sign — on an AM capture the building's sign IS the photo (the owner's AM
 * rule), so "building sign only" is not a fault there. All three go to the Super Admin.
 * A reading with no word on the problem (an older or fallback read) still asks, as before.
 */
export function signboardAsksForAPhoto(check: PhoenixCrmSignboardCheck, listType: PhoenixCrmListType): boolean {
  if (check.verdict === "no_name") return true;
  if (check.verdict !== "unjudged" || (check.reason !== "unreadable" && check.reason !== "unreadable_final")) return false;
  const problem = check.problem ?? null;
  if (problem === "none") return false;
  if (problem === "stylised") return false;
  if (problem === "building_sign_only" && listType !== "PM") return false;
  return true;
}

/**
 * The sentence the rep reads: what to photograph differently, by what the reader said was wrong.
 *
 * 🔴 "customer", never the word the owner uses in chat — tests/phoenix-crm-am-pm-words.test.ts refuses
 * it in any string of this tree, as `schedule-rules.ts`'s own advice records.
 */
export function signboardRetakeAdvice(check: Pick<PhoenixCrmSignboardCheck, "verdict" | "problem" | "signs">): string {
  if (check.verdict === "no_name" && check.signs.length === 0) {
    return "This photo does not show the customer's nameplate. Photograph the nameplate or signboard that carries the customer's name.";
  }
  switch (check.problem) {
    case "no_plate":
      return "This photo does not show the customer's nameplate. Photograph the nameplate or signboard that carries the customer's name.";
    case "building_sign_only":
      return "This photo shows the building's sign, not the customer's own nameplate. Photograph the plate at the clinic's own door, or the board inside that lists the clinics.";
    case "too_far":
      return "The nameplate is too far away to read. Step closer so the name fills the box.";
    case "blurred":
      return "The photo is blurred. Hold the phone still and take it again.";
    case "dark_or_glare":
      return "The nameplate is too dark or a reflection covers it. Use the light or step to one side, and take it again.";
    case "cut_off":
      return "Part of the nameplate is cut off. Fit the whole nameplate inside the box.";
    case "stylised":
      return "The lettering on this sign cannot be read. Photograph a plate that shows the customer's name in plain letters, close and straight on.";
    case "sideways":
      return "This photo is on its side. Hold the phone upright, with the nameplate inside the box, and take it again.";
    default:
      return check.verdict === "no_name"
        ? "The sign in this photo does not show the customer's name. Photograph the nameplate that carries the name."
        : "The customer's name cannot be read in this photo. Step closer, hold the phone straight and put the nameplate inside the box.";
  }
}

/**
 * What the door does with one reading of the signboard, given how many photos of this customer's
 * signboard this rep has had refused today (Cairo visit day).
 *
 *   save   — the name is read; or a place another check already holds, or a name nothing can be
 *            compared to (`signboardDoorHolds` false) — exactly as before the scanner;
 *   retake — no readable name in the photo, and tries are left: refused with the advice and the try;
 *   hold   — the third photo still fails, or anything else that is not a match (another name, a lost
 *            call): saved and held, and the system re-reads it once (`server/signboard-holds.ts`).
 */
export function signboardDoorAction(
  check: PhoenixCrmSignboardCheck,
  earlierTries: number,
  listType: PhoenixCrmListType,
): SignboardDoorAction {
  if (check.verdict === "match") return { kind: "save" };
  const tried = Math.max(0, Math.floor(Number.isFinite(earlierTries) ? earlierTries : 0));
  if (signboardAsksForAPhoto(check, listType)) {
    if (tried + 1 >= SIGNBOARD_DOOR_MAX_TRIES) return { kind: "hold", tries: tried + 1 };
    const nextTry = tried + 2;
    return {
      kind: "retake",
      message: `${signboardRetakeAdvice(check)} Try ${nextTry} of ${SIGNBOARD_DOOR_MAX_TRIES}.`,
      nextTry,
      reason: check.verdict === "no_name" ? "signboard_no_plate" : "signboard_unreadable",
    };
  }
  return signboardDoorHolds(check) ? { kind: "hold", tries: tried + 1 } : { kind: "save" };
}

/**
 * The key a rep's refused signboard photos are counted under: the customer when he has a row, else the
 * folded name a new customer is being added under. Null when there is nothing to count against.
 */
export function signboardRefusalKey(input: { placeId?: string | null; customerId: string | null; customerName: string | null }): string | null {
  if (input.placeId) return `place:${input.placeId.toLowerCase()}`;
  if (input.customerId) return `customer:${input.customerId.toLowerCase()}`;
  const folded = normalizeContactName(input.customerName);
  return folded ? `name:${folded}` : null;
}

// ── The places filed "Not readable" before the scanner (2026-10-18) ────────────────────────────

/**
 * What the one-off read of an old place's photo does with the place:
 *
 *   confirm — the name is read: the place is confirmed, and a held one is approved by the system;
 *   flag    — a clear plate names somebody else: filed for the Super Admin once a second reading agrees;
 *   retake  — the PHOTO stops the name being read (`signboardAsksForAPhoto`): final for the reader, and
 *             the rep is asked for a new photo of that door with the reason;
 *   keep    — an answer no new photo changes: a legible sign whose name did not confirm, an AM
 *             building's sign, a name that cannot be compared across scripts. Written final, and the
 *             Super Admin's to judge on the board;
 *   lost    — the reader never answered: nothing is written, and the place keeps its old record.
 */
export type SignboardBacklogOutcome = "confirm" | "flag" | "retake" | "keep" | "lost";

export function signboardBacklogOutcome(check: PhoenixCrmSignboardCheck, listType: PhoenixCrmListType): SignboardBacklogOutcome {
  if (check.verdict === "match") return "confirm";
  if (check.verdict === "other_name") return "flag";
  if (check.reason === "call_failed" || check.reason === "no_api_key") return "lost";
  // The photo cannot be opened at all: only a new one can ever be read.
  if (check.reason === "no_bytes") return "retake";
  return signboardAsksForAPhoto(check, listType) ? "retake" : "keep";
}

/** The retake request kept on the place: when, why, and the sentence the rep reads. */
export function signboardRetakeRequest(
  check: Pick<PhoenixCrmSignboardCheck, "verdict" | "problem" | "signs">,
  now: Date = new Date(),
): SignboardRetakeRequest {
  return { advice: signboardRetakeAdvice(check), problem: check.problem ?? null, requestedAt: now.toISOString() };
}

/**
 * The check kept on an old place after its one read. 🔴 AN UNREADABLE PHOTO IS WRITTEN
 * `unreadable_final` — which no backlog, night or held re-read ever takes — and NEVER `unreadable`,
 * which the deployed night pass would read again: this record has to stop the reads whichever build
 * is serving when it is written. That holds for a legible sign kept for the Super Admin (`keep`) as
 * much as for one sent back: the same photo read again reads the same.
 */
export function signboardBacklogCheckToKeep(
  read: PhoenixCrmSignboardCheck,
  priorAttempts: number,
  outcome: SignboardBacklogOutcome,
  now: Date = new Date(),
): PhoenixCrmSignboardCheck {
  const attempts = Math.max(1, priorAttempts) + 1;
  const unread = read.verdict === "unjudged" && (read.reason === "unreadable" || read.reason === "no_bytes");
  if (outcome !== "retake") return { ...read, attempts, reason: unread ? "unreadable_final" : read.reason, retake: null };
  const reason = read.verdict === "unjudged" ? "unreadable_final" : read.reason;
  return { ...read, attempts, reason, retake: signboardRetakeRequest(read, now) };
}

/**
 * A stored reading judged again under today's rules — NO model call — and the one change it makes, or
 * null. 🔴 ONLY TWO CHANGES ARE EVER WRITTEN (owner's rulings, 2026-10-18): a place whose stored plate
 * now names the customer is confirmed (فؤاد/فواد, ذكي/زكي), and a PM confirm whose photo the reader said
 * holds no nameplate at all is sent back for one (a prescription, a paper schedule). Every other
 * difference a re-judge might find is left exactly as it is — the stored record does not keep
 * `sign_present`, so a verdict that leaned on it must not be redrawn from what is stored.
 */
export function signboardRejudge(
  stored: PhoenixCrmSignboardCheck,
  input: { customerName: string; listType: PhoenixCrmListType; photoBrick?: string | null },
  now: Date = new Date(),
): { outcome: "confirm" | "retake"; check: PhoenixCrmSignboardCheck } | null {
  if (!Array.isArray(stored.signs) || stored.signs.length === 0) return null;
  const again = judgeSignboards({
    croppedFraction: stored.croppedFraction ?? 0,
    customerName: input.customerName,
    listType: input.listType,
    note: stored.note ?? null,
    photoBrick: input.photoBrick ?? null,
    problem: stored.problem ?? null,
    signPresent: null,
    signs: stored.signs,
  });
  // Not a read: the photo's count and the time it was read stay as stored. A row written before
  // `attempts` existed has had one.
  const kept = { attempts: Number.isFinite(stored.attempts) && stored.attempts > 0 ? stored.attempts : 1, checkedAt: stored.checkedAt };
  if (stored.verdict !== "match" && again.verdict === "match") {
    return { check: { ...stored, ...again, ...kept, retake: null }, outcome: "confirm" };
  }
  if (stored.verdict === "match" && input.listType === "PM" && stored.problem === "no_plate" && again.verdict !== "match") {
    const unread: PhoenixCrmSignboardCheck = { ...stored, ...again, ...kept, reason: "unreadable_final", verdict: "unjudged" };
    return { check: { ...unread, retake: signboardRetakeRequest(unread, now) }, outcome: "retake" };
  }
  return null;
}

/**
 * How far from the place's frozen point a retaken signboard photo may be: a visit's own 500 m line,
 * widened by the photo's claimed radius up to a place's 250 m — so an iPhone handing the camera an
 * approximate position is not refused at the right door, and a photo from across town still is.
 */
export const SIGNBOARD_RETAKE_MAX_METERS = 500;
export const SIGNBOARD_RETAKE_MAX_SLACK_METERS = 250;

export function signboardRetakeIsAtThePlace(distanceMeters: number, accuracyMeters: number | null): boolean {
  if (!Number.isFinite(distanceMeters)) return false;
  const slack = accuracyMeters !== null && Number.isFinite(accuracyMeters) && accuracyMeters > 0 ? Math.min(accuracyMeters, SIGNBOARD_RETAKE_MAX_SLACK_METERS) : 0;
  return distanceMeters <= SIGNBOARD_RETAKE_MAX_METERS + slack;
}

/** Is this place waiting on a new signboard photo from its rep? */
export function signboardRetakeWaiting(stored: unknown): SignboardRetakeRequest | null {
  if (!stored || typeof stored !== "object") return null;
  const retake = (stored as Record<string, unknown>).retake;
  if (!retake || typeof retake !== "object") return null;
  const raw = retake as Record<string, unknown>;
  const advice = typeof raw.advice === "string" && raw.advice.trim() ? raw.advice : null;
  if (!advice) return null;
  return {
    advice,
    problem: parseSignboardPhotoProblem(raw.problem),
    requestedAt: typeof raw.requestedAt === "string" ? raw.requestedAt : "",
  };
}
