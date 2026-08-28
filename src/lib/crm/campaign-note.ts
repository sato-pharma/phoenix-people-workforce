/**
 * Pull the DOCTOR, the SPECIALITY and the CLINIC/ACCOUNT apart, out of one campaign comment.
 *
 * A campaign (prospection) visit is the one CRM visit type iReports360 sends with no account at all
 * — the rep types everything he saw into a single free-text `comment`. Measured on production
 * 2026-08-28 over 31,622 campaign rows carrying a note (26,077 of them distinct), the vendor's own
 * Doctor / Speciality / Clinic columns are empty for every one of them, and the note holds all three
 * glued together:
 *
 *   "د/محمد ابوالعنين IM مستشفى التيسير"     -> doctor + speciality + hospital, on ONE line
 *   "مستشفي كهرباء ٢٦ يوليو … عيادة جمال عبد الناصر"  -> NOT a doctor at all: a hospital, with its
 *                                                       own address inside its name
 *   "احمد سمير خطاب GB"                        -> the speciality is written into the name
 *   "شركة المياة بالمنيل · تم تسليم عرض السعر"  -> a company, then the actual remark
 *
 * The owner's instruction, 2026-08-28: *"you must be able to separate the doctor name, the
 * speciality and the clinic. The first one is not a doctor, it is a hospital, and its address is
 * mentioned in its name. You will find another doctor whose speciality is mentioned in his name,
 * which is GB. You must be able to identify this."* Both of his examples are real rows and both are
 * pinned in the tests.
 *
 * WHAT THIS IS NOT. It is not a second speciality vocabulary. `contact-taxonomy.ts` is the ONE
 * authority for what a CRM speciality value means, and every alias below resolves INTO one of its
 * canonical values — a test asserts that, so the two cannot drift. A token this file cannot resolve
 * (GB, 11 rows) is reported as written and left for the owner to name, never guessed; that is the
 * same refusal to invent a value that taxonomy module was written for.
 *
 * Rules first, on purpose: this pass is free, deterministic and testable, and it settles the great
 * majority of notes. What it cannot split is handed to the cheap model in `campaign-note-assist.ts`
 * — the same gpt-5.4-nano tier the rest of the app uses — under the same anti-fabrication gate.
 */

import { KNOWN_SP_SPECIALITIES } from "@/lib/crm/contact-taxonomy";

/** A place or an organisation the rep called on — the "Clinic / Account" half of the note. */
export type CampaignAccountKind =
  | "hospital"
  | "clinic"
  | "pharmacy"
  | "laboratory"
  | "medical centre"
  | "company"
  | "warehouse";

export type CampaignSpeciality = {
  /**
   * The canonical `contact-taxonomy` value, or null when this file does not know the token.
   * Null is a real answer and is shown as written — see the module note on GB.
   */
  canonical: string | null;
  /** Exactly the characters the rep typed, so nothing on screen is a word he did not write. */
  written: string;
};

export type CampaignPerson = { name: string; speciality: CampaignSpeciality | null };
export type CampaignAccount = { kind: CampaignAccountKind; name: string };

export type CampaignNoteReading = {
  /** Everyone the note names, in the order written. A day's campaign note routinely holds several. */
  people: CampaignPerson[];
  /** Every place or organisation the note names, in the order written. */
  accounts: CampaignAccount[];
  /** What the rep actually reported — the sentence, kept whole. Never truncated. */
  remark: string | null;
  /** Segments the rules could not classify. This is the model's input, and nothing else is. */
  unread: string[];
};

/**
 * A rep writes the speciality a dozen ways: an English abbreviation, the English word, the Arabic
 * word, and a misspelling of any of them ("neouro" appears on production). Each alias maps onto a
 * value `contact-taxonomy` already knows, so this table adds spellings and never adds a speciality.
 *
 * Keys are already normalised (see {@link normalizeToken}): no diacritics, alef/ya/ta-marbuta
 * folded, lowercased. Arabic writes ENT as three words and internal medicine four different ways,
 * so multi-word aliases are matched as a phrase across consecutive tokens.
 */
const SPECIALITY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // internal medicine — 2,641 rows carry the Arabic form, 954 the abbreviation
  ["im", "internal medicine"],
  ["internal", "internal medicine"],
  ["internal medicine", "internal medicine"],
  ["باطنه", "internal medicine"],
  ["باطنا", "internal medicine"],
  ["باطني", "internal medicine"],
  ["باطنيه", "internal medicine"],
  // ENT — 1,006 Latin rows; the Arabic is written with and without the conjunction
  ["ent", "ent"],
  ["انف واذن", "ent"],
  ["انف و اذن", "ent"],
  ["انف اذن", "ent"],
  // paediatrics
  ["ped", "pediatrics"],
  ["peds", "pediatrics"],
  ["pedia", "pediatrics"],
  ["pediatrics", "pediatrics"],
  ["اطفال", "pediatrics"],
  // neurology — "neouro" is the rep spelling, on production
  ["neuro", "neurology"],
  ["neouro", "neurology"],
  ["neurology", "neurology"],
  ["مخ واعصاب", "neurology"],
  ["مخ و اعصاب", "neurology"],
  ["اعصاب", "neurology"],
  // The English word, written in Arabic letters — "محمد الخطيب نيورو" is a production note.
  ["نيورو", "neurology"],
  // chest
  ["chest", "chest"],
  ["صدر", "chest"],
  ["صدريه", "chest"],
  // general practice
  ["gp", "general practitioner"],
  ["general practitioner", "general practitioner"],
  // urology
  ["uro", "urology"],
  ["urology", "urology"],
  ["مسالك", "urology"],
  // surgery
  ["general surgery", "general surgery"],
  ["جراحه", "general surgery"],
  ["جراحه عامه", "general surgery"],
  // the rest of the SP list, where a rep writes it out
  ["cardio", "cardiology"],
  ["cardiology", "cardiology"],
  ["قلب", "cardiology"],
  ["ortho", "orthopedic surgery"],
  ["orthopedic surgery", "orthopedic surgery"],
  ["عظام", "orthopedic surgery"],
  ["derma", "dermatologist"],
  ["dermatology", "dermatologist"],
  ["جلديه", "dermatologist"],
  // GIT is how a rep writes the gastroenterologist the taxonomy already holds.
  ["git", "gastroenterologist"],
  ["gastro", "gastroenterologist"],
  ["جهاز هضمي", "gastroenterologist"],
  ["ophtha", "ophthalmologist"],
  ["ophthalmology", "ophthalmologist"],
  ["عيون", "ophthalmologist"],
  ["psych", "psychiatry"],
  ["psychiatry", "psychiatry"],
  ["نفسيه", "psychiatry"],
  ["nephro", "nephrology"],
  ["nephrology", "nephrology"],
  ["كلى", "nephrology"],
  ["حميات", "tropical medicine"],
  ["tropical medicine", "tropical medicine"],
];

/**
 * Tokens that are unmistakably a speciality but that this file will NOT name.
 *
 * "GB" is written beside a doctor's name 11 times on production, once as literally "تخصص gb"
 * ("speciality: gb"), so what it IS is not in doubt — only what it MEANS. `contact-taxonomy` has no
 * matching value, and its own rule is that an unknown value is surfaced rather than folded into a
 * bucket. So it comes back with `canonical: null` and the note's own characters, and the owner names
 * it once, in a sheet, the way he names every other business fact.
 *
 * GYNAECOLOGY IS THE SECOND, AND IT IS A BIGGER FINDING THAN GB. Reps write "Manal hamza gyna" and
 * "Amna elsayed gyna" — both real August rows — but `contact-taxonomy`'s SP list has NO gynaecology
 * value at ALL, so there is nothing correct to map it onto. Guessing one would put a speciality on a
 * manager's screen that the CRM cannot store, and folding it into "general practitioner" would be
 * plainly wrong. It is surfaced as written until the owner decides whether the SP list should gain
 * the value — a decision about his vocabulary, not this parser's.
 */
const UNNAMED_SPECIALITY_TOKENS = new Set(["gb", "gyna", "gynae", "gyn", "gynecology", "gynaecology", "obs", "نسا", "نساء وتوليد"]);

/**
 * Whole words that say what KIND of place a segment names.
 *
 * Matched as WHOLE tokens, which is not fussiness: "معملش check in" ("he couldn't check in") and
 * "معملش اوردر" ("he didn't order") both contain معمل, and a substring match reads a rep's apology
 * for a network failure as a visit to a laboratory. Both rows are real; they were 2 of the first 2
 * laboratory-keyword rows sampled.
 */
const ACCOUNT_KEYWORDS: ReadonlyArray<readonly [string, CampaignAccountKind]> = [
  ["مستشفي", "hospital"],
  ["مستشفى", "hospital"],
  ["hospital", "hospital"],
  ["عياده", "clinic"],
  ["clinic", "clinic"],
  ["صيدليه", "pharmacy"],
  ["صيدلية", "pharmacy"],
  ["صيدلي", "pharmacy"],
  ["pharmacy", "pharmacy"],
  ["معمل", "laboratory"],
  ["معامل", "laboratory"],
  ["مختبر", "laboratory"],
  ["lab", "laboratory"],
  ["مركز", "medical centre"],
  ["centre", "medical centre"],
  ["center", "medical centre"],
  ["شركه", "company"],
  ["شركة", "company"],
  ["مصنع", "company"],
  ["بنك", "company"],
  ["company", "company"],
  ["مخزن", "warehouse"],
  ["مخازن", "warehouse"],
];

/** How a rep marks a person: "د/نيللي", "د ماجي", "دكتور محمد", "Dr Ibrahim". */
const DOCTOR_MARKERS = new Set(["د", "دكتور", "دكتوره", "دكاتره", "dr", "doctor", "doctors"]);

/** Words that only ever introduce something else, and are never part of the name that follows. */
const LEADING_NOISE = new Set(["تخصص", "زياره", "زيارة", "visiting", "visit", "تم"]);

const ARABIC_DIACRITICS = /[ً-ْٰـ]/g;

/**
 * Fold the orthographic variation that makes Arabic disagree with itself, so a lookup is about the
 * word rather than which hamza the rep happened to type. Same folding the campaign account matcher
 * already applies, for the same reason.
 */
function normalizeToken(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
}

const SPECIALITY_BY_ALIAS = new Map(SPECIALITY_ALIASES);
const KIND_BY_KEYWORD = new Map(ACCOUNT_KEYWORDS.map(([word, kind]) => [normalizeToken(word), kind]));
/** The longest alias, in words — how far ahead a phrase match has to look. */
const MAX_ALIAS_WORDS = Math.max(...SPECIALITY_ALIASES.map(([alias]) => alias.split(" ").length));

/** Every canonical value this file can produce, so a test can hold it against the authority. */
export const CAMPAIGN_SPECIALITY_CANONICALS: readonly string[] = Array.from(
  new Set(SPECIALITY_ALIASES.map(([, canonical]) => canonical)),
);

/**
 * Resolve a speciality string that came from somewhere other than the tokeniser — the model assist,
 * say — through the SAME alias table, so a speciality is canonicalised once and in one place. An
 * alias this file does not know comes back as written, never as a guess.
 */
export function resolveSpeciality(written: string | null | undefined): CampaignSpeciality | null {
  const text = String(written ?? "").trim();
  if (!text) return null;
  const key = text.split(/\s+/).map(normalizeToken).filter(Boolean).join(" ");
  if (!key) return null;
  return { canonical: SPECIALITY_BY_ALIAS.get(key) ?? null, written: text };
}

/** True when the canonical vocabulary above is still a subset of the taxonomy's own. */
export function campaignSpecialitiesAreKnownToTaxonomy(): boolean {
  const known = new Set(KNOWN_SP_SPECIALITIES);
  return CAMPAIGN_SPECIALITY_CANONICALS.every((value) => known.has(value));
}

type Token = { start: number; end: number; text: string; key: string };

/**
 * Split a segment into words, keeping each word's offsets so a name can be returned as a VERBATIM
 * slice of what the rep wrote rather than reassembled from pieces.
 *
 * A doctor marker is regularly glued to the name ("د/نيللي رافت"), so a token that begins with one
 * is emitted as two: the marker, and the remainder at its true offset.
 */
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    const raw = match[0];
    const start = match.index;
    const glued = /^([^\s\/.ـ]+)[\/.]([^\s].*)$/u.exec(raw);
    if (glued && DOCTOR_MARKERS.has(normalizeToken(glued[1]))) {
      tokens.push({ start, end: start + glued[1].length, text: glued[1], key: normalizeToken(glued[1]) });
      const restStart = start + raw.length - glued[2].length;
      tokens.push({ start: restStart, end: start + raw.length, text: glued[2], key: normalizeToken(glued[2]) });
      continue;
    }
    // A bare marker still carries its punctuation ("د." / "Dr."); strip it for the lookup only.
    const key = normalizeToken(raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    tokens.push({ start, end: start + raw.length, text: raw, key });
  }
  return tokens;
}

/** The speciality starting at `index`, longest phrase first, or null. */
function specialityAt(tokens: readonly Token[], index: number): { speciality: CampaignSpeciality; length: number } | null {
  for (let size = Math.min(MAX_ALIAS_WORDS, tokens.length - index); size >= 1; size -= 1) {
    const slice = tokens.slice(index, index + size);
    const phrase = slice.map((token) => token.key).join(" ");
    const canonical = SPECIALITY_BY_ALIAS.get(phrase);
    if (canonical) {
      return { length: size, speciality: { canonical, written: phraseText(slice) } };
    }
  }
  if (UNNAMED_SPECIALITY_TOKENS.has(tokens[index].key)) {
    return { length: 1, speciality: { canonical: null, written: tokens[index].text } };
  }
  return null;
}

function phraseText(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join(" ");
}

/** A verbatim slice of the segment, from the first token to the last. */
function slice(segment: string, tokens: readonly Token[], from: number, to: number): string {
  if (to <= from) return "";
  return segment.slice(tokens[from].start, tokens[to - 1].end).trim();
}

/**
 * A segment the rules did not classify is either the rep's REMARK or something they simply could not
 * read. The difference matters: a remark belongs on screen untouched, an unread segment is what the
 * model gets asked about. Length is the honest discriminator — "prospiction" is not a sentence and
 * "عرفته ان اللاكتو بقا متوفر في الصيدليه من جديد" is.
 */
const REMARK_MIN_WORDS = 5;

/** Read one campaign comment. Pure, free, and never throws — a note it cannot read yields empties. */
export function readCampaignNote(comment: string | null | undefined): CampaignNoteReading {
  const reading: CampaignNoteReading = { accounts: [], people: [], remark: null, unread: [] };
  const note = String(comment ?? "").trim();
  if (!note) return reading;

  const remarks: string[] = [];

  for (const rawSegment of note.split(/[\r\n]+|\s*[|·•]\s*|\s*\.\.\.+\s*|\s*…\s*/u)) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    // A line that is ONLY a speciality belongs to the doctor named on the line before it — reps
    // write "د/ هاني حنا | ENT" and "د/هند السعيد | أنف و اذن | رئيس القسم" as often as they write
    // the speciality inline. Read on its own it is a floating word; read in order it is his.
    const wholeSegment = specialityAt(tokens, 0);
    if (wholeSegment && wholeSegment.length === tokens.length) {
      const lastPerson = reading.people[reading.people.length - 1];
      if (lastPerson && !lastPerson.speciality) {
        lastPerson.speciality = wholeSegment.speciality;
        continue;
      }
    }

    let index = 0;
    let sawSomething = false;
    // WORDS THE RULES WALKED PAST MUST NOT VANISH.
    //
    // "د. عبدالكريم صبح Pedia العصافرة" reads as a doctor and his speciality, and the district on
    // the end — El-Asafra, where he practises — used to be stepped over and silently dropped. That
    // is the owner's no-truncation rule broken invisibly: the screen showed a complete-looking row
    // with a word the rep typed missing from it. Leftovers now go to `unread`, which is both what
    // the screen can still show and exactly what the cheap-model assist is given to read.
    let unclaimedFrom: number | null = null;
    const flushUnclaimed = (until: number) => {
      if (unclaimedFrom === null) return;
      const leftover = slice(segment, tokens, unclaimedFrom, until);
      unclaimedFrom = null;
      // One stray letter or connector identifies nothing and is not worth a round trip.
      if (leftover.length >= 3) reading.unread.push(leftover);
    };

    while (index < tokens.length) {
      if (LEADING_NOISE.has(tokens[index].key)) {
        index += 1;
        continue;
      }
      // A marker or a place keyword closes the run of unclaimed words before it. A SPECIALITY does
      // NOT: it claims BACKWARDS over the name in front of it ("احمد سمير خطاب GB"), so flushing
      // here would file that name as unread and as a person at the same time.
      if (DOCTOR_MARKERS.has(tokens[index].key) || KIND_BY_KEYWORD.has(tokens[index].key)) {
        flushUnclaimed(index);
      }

      const kind = KIND_BY_KEYWORD.get(tokens[index].key);
      if (kind) {
        // The place keeps everything after its keyword — "مستشفي كهرباء ٢٦ يوليو" is one name and
        // the address inside it is part of how the rep identifies the building. It ends where the
        // next person or place begins, never mid-name.
        const from = index;
        index += 1;
        while (index < tokens.length && !DOCTOR_MARKERS.has(tokens[index].key) && !KIND_BY_KEYWORD.has(tokens[index].key)) {
          index += 1;
        }
        const name = slice(segment, tokens, from, index);
        if (name) {
          reading.accounts.push({ kind, name });
          sawSomething = true;
        }
        continue;
      }

      if (DOCTOR_MARKERS.has(tokens[index].key)) {
        index += 1;
        const from = index;
        let speciality: CampaignSpeciality | null = null;
        while (index < tokens.length) {
          if (KIND_BY_KEYWORD.has(tokens[index].key)) break;
          const found = specialityAt(tokens, index);
          if (found) {
            speciality ??= found.speciality;
            break;
          }
          index += 1;
        }
        const name = slice(segment, tokens, from, index);
        if (speciality) index += specialityAt(tokens, index)?.length ?? 1;
        if (name) {
          reading.people.push({ name, speciality });
          sawSomething = true;
        }
        continue;
      }

      // No marker, but a speciality written straight after the name — "احمد سمير خطاب GB",
      // "بهاء سليم باطنا". This is the shape the owner pointed at, and it is a person.
      const found = specialityAt(tokens, index);
      if (found && index > 0) {
        const from = backToSegmentStart(tokens, index);
        const name = slice(segment, tokens, from, index);
        if (name) {
          // The name walked back over words this loop had marked unclaimed. Whatever sits BEFORE
          // that name is still unclaimed and flushes; the name itself is now spoken for.
          flushUnclaimed(from);
          unclaimedFrom = null;
          reading.people.push({ name, speciality: found.speciality });
          sawSomething = true;
          index += found.length;
          continue;
        }
      }

      // Nothing claimed this token. Remember where the run of unclaimed words began so it can be
      // handed on whole — see the flush below.
      unclaimedFrom ??= index;
      index += 1;
    }
    flushUnclaimed(tokens.length);

    if (!sawSomething) {
      const words = tokens.length;
      if (words >= REMARK_MIN_WORDS) remarks.push(segment);
      else reading.unread.push(segment);
    }
  }

  reading.remark = remarks.length > 0 ? remarks.join(" · ") : null;
  return reading;
}

/** Walk back over the plain words that make up a name, stopping at anything already classified. */
function backToSegmentStart(tokens: readonly Token[], index: number): number {
  let from = index;
  while (from > 0) {
    const previous = tokens[from - 1];
    if (KIND_BY_KEYWORD.has(previous.key) || DOCTOR_MARKERS.has(previous.key) || LEADING_NOISE.has(previous.key)) break;
    from -= 1;
  }
  return from;
}

/**
 * The one-line answer for the drill-down's Doctor column, and the reason this module exists: a
 * campaign row stops reading as "Contact 0" or as a paragraph, and starts reading as a person or a
 * place with a name.
 */
export function campaignHeadline(reading: CampaignNoteReading): string | null {
  const person = reading.people[0];
  if (person) return person.name;
  const account = reading.accounts[0];
  if (account) return account.name;
  return null;
}
