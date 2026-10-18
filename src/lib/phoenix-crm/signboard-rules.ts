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
type NameWord = { word: string; core: string | null };

/** What is left of a compound once its head and tail are taken off — never empty. */
function compoundCore(parts: readonly string[]): string {
  let rest = [...parts];
  while (rest.length > 1 && COMPOUND_HEADS.has(rest[0])) rest = rest.slice(1);
  while (rest.length > 1 && COMPOUND_TAILS.has(rest[rest.length - 1])) rest = rest.slice(0, -1);
  return rest.join("");
}

/** A person's name as the signboard check counts it: folded, untitled, each compound one word. */
function personNameWords(text: string): NameWord[] {
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

/** Is this word of the customer's name among the words read off one candidate? */
function nameWordIsThere(wanted: NameWord, read: readonly NameWord[]): boolean {
  return read.some(
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
    return opening !== undefined && customerWords.some((name) => nameWordIsThere(name, [opening]));
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
 * professor's title, `personNameWords` above — applied to both sides alike.
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
    placeAxis ? distinctiveWords(text).map((word) => ({ core: null, word })) : personNameWords(text);
  const customerWords = wordsOf(input.customerName ?? "").filter((name) => name.word.length > 1);
  const wantedWords = customerWords.filter((name) => name.word.length >= 3);
  if (wantedWords.length === 0) return { matches: null, score: null };
  // A name of three tokens or more survives losing one; two tokens must both be there.
  const allowedMisses = wantedWords.length >= 3 ? 1 : 0;

  let best: number | null = null;
  let matched = false;
  for (const [index, candidate] of haystacks.entries()) {
    const read = wordsOf(candidate);
    if (read.length === 0) continue;
    const missing = wantedWords.filter((name) => !nameWordIsThere(name, read)).length;
    // On the person axis the allowance is never spent on his given name standing behind another
    // man's: a name read off the sign opens on one of HIS words, and the sign's whole text carries
    // his words as one run that opens on his given name (`readsTheCustomersName`).
    const isTheName = placeAxis || readsTheCustomersName(customerWords, read, allowedMisses, index >= preferred.length);
    if (missing <= allowedMisses && isTheName) matched = true;
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
  input: { customerName: string | null; listType: PhoenixCrmListType },
): { matches: boolean | null; score: number | null } {
  const sameScript = signNamesCustomer({
    customerName: input.customerName,
    listType: input.listType,
    personNames: sign.personNames,
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
  });

  const fallback = chooseSignboard(signs, input.listType);

  // 1 · NO SIGNBOARD AT ALL, said confidently — the owner's first ruling, unchanged.
  if (input.signPresent === false && !anythingRead) return record(fallback, "no_name", "sign_no_name", null);

  // 2 · ANY sign that names him is a match.
  let best: number | null = null;
  for (const sign of signs) {
    const { matches, score } = signNamesCustomerOnSign(sign, input);
    if (score !== null) best = best === null ? score : Math.max(best, score);
    if (matches === true) return record(sign, "match", null, score ?? best);
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
  const spent = exhausted && check.verdict === "unjudged" && check.reason === "unreadable";
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
 * and three re-reads (owner, 2026-10-17, "re-read up to 3 times"). Counted on the place's own
 * `signboard_check.attempts`, the door's read being the first.
 */
export const SIGNBOARD_HELD_MAX_READS = 4;

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
 * a lost call, like a missing key, spends nothing and the place waits; the photo that cannot be opened
 * at all is `no_bytes`, which is a read that answered, and spends one.
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
