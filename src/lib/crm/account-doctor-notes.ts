/**
 * The doctors a rep names in his AM visit comment, each with the speciality the comment gives him — the Weekly
 * Sheet's account depth (owner, 2026-11-08, Dr. Hany Saad's seventh need: "at least 3 doctors of each speciality
 * — Pediatrics, Internal / GP, ENT — inside every account"; asked how to know the doctors: "check from their
 * comments if you find good, if not pull the data you can").
 *
 * A visit to an AM account records the account, not the doctors met, so the comment is the only place they are
 * written. Of 2,362 AM visits in the 28 days to 8 November 2026, 1,288 named a doctor or a speciality, in shapes
 * like these (names here invented):
 *
 *   عياده الباطنه            ← a heading: the doctors under it are Internal Medicine
 *   د. احمد سامي              ← a doctor
 *   د. محمد فريد ود. هاني     ← two doctors on one line
 *   د ناهد ent                ← a doctor and his speciality on one line
 *   د امل د سلمي اطفال        ← two doctors sharing the speciality written after them
 *   Dr. Kamal Fahmy will start prescribing …
 *
 * Pure — no database — so every shape is pinned by a test. GP and "ممارس" join Internal Medicine, as Dr. Hany
 * wrote; surgery, urology, neurology, chest and every other speciality are read and kept OUT of the three
 * columns. A doctor whose speciality the comment never gives is counted in none of them. A comment naming no
 * doctor says so — it never reads as zero doctors met.
 */

export type DoctorFamily = "pediatrics" | "internal" | "ent" | "other";

export type DoctorMention = {
  /** The name as the comment wrote it, folded ("د. أحمد سامي" → "احمد سامي"). */
  name: string;
  /** The speciality the comment gives him, or null when it gives none. */
  family: DoctorFamily | null;
};

export const DOCTOR_FAMILY_LABEL: Record<Exclude<DoctorFamily, "other">, string> = {
  pediatrics: "Pediatrics",
  internal: "Internal Medicine / GP",
  ent: "ENT",
};

/** One letter for each way an Arabic letter is written, no diacritics, no tatweel, Latin in lower case. */
export function foldCommentText(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ‎‏؜]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase();
}

/**
 * Speciality words, folded. Each is matched as a whole word or as the start of one — "الباطنه", "باطنة",
 * "والأنف" all fold to a match — with the Arabic article and the conjunction allowed in front.
 */
const FAMILY_WORDS: ReadonlyArray<readonly [DoctorFamily, RegExp]> = [
  ["pediatrics", /^(?:و?ال)?(?:اطفال|بيديا|حضان)|^(?:ped|peds|pedia|pediatric|pediatrics|paediatrics|nicu)$/],
  ["internal", /^(?:و?ال)?(?:باطن|ممارس)|^(?:im|internal|gp|family)$/],
  ["ent", /^(?:و?ال)?(?:انف|حنجر)|^ent$/],
  [
    "other",
    /^(?:و?ال)?(?:جراح|مسالك|صدر|صدريه|نيورو|اعصاب|عظام|جلديه|جلدي|قلب|رمد|نسا|كلي|اورام|هضمي|جهاز|اسنان|تخدير|طوارئ|رعايه|نفسي)|^(?:surgery|surgeon|uro|urology|chest|neuro|neurology|cns|cardio|cardiology|derma|ortho|gyn|obgyn|gastro|psych|psychiatry|onco|icu)$/,
  ],
];

/** The family of one word, or null when it names none. */
export function familyOfWord(word: string): DoctorFamily | null {
  const folded = foldCommentText(word).replace(/[^\p{L}]/gu, "");
  if (!folded) return null;
  for (const [family, pattern] of FAMILY_WORDS) if (pattern.test(folded)) return family;
  return null;
}

/** Words that end a name: verbs, prepositions and the words around a doctor that are not his name. */
const NAME_STOP = new Set(
  [
    "و", "ع", "علي", "عن", "في", "ف", "مع", "من", "الي", "بخصوص", "عشان", "لان", "او", "ثم", "تم", "كمان", "برضو",
    "وعد", "وعدت", "وعدوا", "قال", "قالت", "قالي", "قالتلي", "قالتلنا", "قالنا", "كلمته", "كلمتها", "كلمت", "كلمناه",
    "اتكلمت", "اتكلمنا", "بيكتب", "بتكتب", "يكتب", "تكتب", "كتب", "كتبت", "هيكتب", "هتكتب", "هيكتبوا", "رحب", "رحبت",
    "فاكر", "فاكره", "عارف", "عارفه", "متابعه", "زياره", "عياده", "قسم", "رئيس", "استشاري", "اخصائي", "مدير", "الموجود",
    "will", "is", "was", "has", "have", "and", "the", "said", "wrote", "about", "interested", "prescribing", "prescribes",
    "promised", "started", "start", "agreed", "asked", "on", "for", "to", "with", "at", "in", "of",
  ].map(foldCommentText),
);

function isNameWord(word: string): boolean {
  const folded = foldCommentText(word).replace(/[^\p{L}]/gu, "");
  if (folded.length < 2) return false;
  if (NAME_STOP.has(folded)) return false;
  if (familyOfWord(folded)) return false;
  // A verb in the future or the present ("هيكتب", "بيكتب"), a phrase with a preposition ("بالتيبوفورتين",
  // "للدولابكتين", "والتاكيد") — never part of a name.
  if (/^(?:بال|لل|وال|هي|هت|بي|بت|كلم)/.test(folded)) return false;
  return true;
}

/**
 * Where each doctor mention starts on a folded line: "د", "د.", "دكتور", "دكتوره", "الدكتور(ه)", "dr", "dr." —
 * at the start of the line, after a space or a mark, or after a lone conjunction ("ود. هاني"). The "و" must
 * itself start a word, so the end of "محمود" is never read as a doctor.
 */
// A bare "د" or "dr" must be followed by a space — "دخلنا" and "drug" are not doctors.
// "لدكتوره دعاء" (to Dr. Doaa) is a doctor; the attached "ل" is allowed before the full word only, so "ولد" never is.
const DOCTOR_TITLE = /(?:^|[\s,،/()\-–:;|]+)و?(?:ل?(?:ال)?دكتوره|ل?(?:ال)?دكتور|د\.|د(?=\s)|dr\.|dr(?=\s))\s*/gu;

/** A speciality word anywhere in this text — the first one, or null. */
function firstFamilyIn(text: string): DoctorFamily | null {
  for (const word of text.split(/[\s,،/()\-–:;|.]+/)) {
    const family = familyOfWord(word);
    if (family) return family;
  }
  return null;
}

/** The one family a line speaks of when it names exactly one, or null for none or several. */
function soleFamilyIn(text: string): DoctorFamily | null {
  const families = new Set<DoctorFamily>();
  for (const word of text.split(/[\s,،/()\-–:;|.]+/)) {
    const family = familyOfWord(word);
    if (family) families.add(family);
  }
  return families.size === 1 ? [...families][0] : null;
}

/** The doctors one comment names, in the order it names them. */
export function doctorMentionsIn(comment: string | null | undefined): DoctorMention[] {
  const mentions: DoctorMention[] = [];
  let heading: DoctorFamily | null = null;
  for (const rawLine of foldCommentText(comment ?? "").split(/\r?\n|\s*\|\|\s*/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const starts: Array<{ at: number; nameAt: number }> = [];
    for (const match of line.matchAll(DOCTOR_TITLE)) starts.push({ at: match.index ?? 0, nameAt: (match.index ?? 0) + match[0].length });
    if (starts.length === 0) {
      // A line naming no doctor and one speciality is a heading for the doctors under it ("عياده الباطنه").
      // One naming several ("عياده الاطفال والصدريه والانف") heads nothing.
      const family = soleFamilyIn(line);
      if (family || /عياد|قسم|clinic|dep/.test(line)) heading = family;
      continue;
    }
    const prefixFamily = soleFamilyIn(line.slice(0, starts[0].at));
    const segments = starts.map((start, index) => line.slice(start.nameAt, starts[index + 1]?.at ?? line.length));
    const found: Array<{ name: string; own: DoctorFamily | null; bare: boolean }> = [];
    for (const segment of segments) {
      const words = segment.split(/[\s,،/()\-–:;|.]+/).filter(Boolean);
      const nameWords: string[] = [];
      for (const word of words) {
        if (nameWords.length === 2 || !isNameWord(word)) break;
        nameWords.push(word.replace(/[^\p{L}]/gu, ""));
      }
      if (nameWords.length === 0) continue;
      // `bare`: the segment is the name alone — "د امل" in "د امل د سلمي اطفال" — so it shares the next one's speciality.
      found.push({ bare: words.length <= nameWords.length, name: nameWords.join(" "), own: firstFamilyIn(words.slice(nameWords.length).join(" ")) });
    }
    for (let index = found.length - 1; index >= 0; index -= 1) {
      const entry = found[index];
      const shared = entry.own ?? (entry.bare ? (found[index + 1]?.own ?? null) : null);
      if (!entry.own && shared) entry.own = shared;
    }
    for (const entry of found) mentions.push({ family: entry.own ?? prefixFamily ?? heading, name: entry.name });
  }
  return mentions;
}

export type AccountDoctorDepth = {
  /** Distinct doctors named in the week's comments for this account, per column. */
  pediatrics: number;
  internal: number;
  ent: number;
  /** Every distinct doctor named, whatever his speciality. */
  named: number;
  /** Three or more in each of the three columns. */
  met: boolean;
  /** The week's comments for this account name no doctor at all — said in words, never a zero. */
  noDoctorsWritten: boolean;
};

/** The minimum Dr. Hany set per speciality per account. */
export const DOCTORS_PER_SPECIALITY = 3;

/**
 * One account's week: the comments of every AM visit to it, folded into distinct doctors per column. A name
 * written once with a family and once without ("احمد" and "احمد · باطنه") is one doctor, of that family; a
 * one-word name and a two-word name opening with it ("امل" and "امل فتحي") are one doctor.
 */
export function accountDoctorDepth(comments: ReadonlyArray<string | null | undefined>): AccountDoctorDepth {
  const byName = new Map<string, DoctorFamily | null>();
  for (const comment of comments) {
    for (const mention of doctorMentionsIn(comment)) {
      byName.set(mention.name, byName.get(mention.name) ?? mention.family);
      if (mention.family && !byName.get(mention.name)) byName.set(mention.name, mention.family);
    }
  }
  // A one-word name that opens a longer name of the same account is that doctor.
  for (const name of [...byName.keys()]) {
    if (name.includes(" ")) continue;
    const longer = [...byName.keys()].find((other) => other !== name && other.startsWith(`${name} `));
    if (!longer) continue;
    const family = byName.get(name) ?? null;
    if (family && !byName.get(longer)) byName.set(longer, family);
    byName.delete(name);
  }
  const count = (family: DoctorFamily) => [...byName.values()].filter((value) => value === family).length;
  const pediatrics = count("pediatrics");
  const internal = count("internal");
  const ent = count("ent");
  return {
    ent,
    internal,
    met: pediatrics >= DOCTORS_PER_SPECIALITY && internal >= DOCTORS_PER_SPECIALITY && ent >= DOCTORS_PER_SPECIALITY,
    named: byName.size,
    noDoctorsWritten: byName.size === 0,
    pediatrics,
  };
}
