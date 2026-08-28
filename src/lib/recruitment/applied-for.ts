/**
 * "Applying for" — working out which job a CV was actually sent for.
 *
 * Almost nobody states it. Measured against production on 2026-08-21, 555 candidates:
 * `applied_for_job_title` is filled on **15**. So a column headed "Applying for" answered the one
 * question that decides who a CV goes to on 2.7% of the pool, and read "Not stated" on the rest.
 *
 * The answer was never missing — it was in four places nothing looked at:
 *
 *   | where                                             | rows it answers |
 *   | ------------------------------------------------ | --------------- |
 *   | `ats_candidates.applied_for_job_title`            |  15 (a human typed it) |
 *   | `ats_candidate_source_context.subject`            | 192 (the email's subject line) |
 *   | the WhatsApp caption in that row's `raw_metadata` |  18 (what the sender typed with the CV) |
 *   | the `Subject( … )` inside the intake `full_name`  | 198 (the forwarder's envelope) |
 *   | the latest CV extraction's `appliedForJobTitle`   |   9 (the AI read the covering note) |
 *   | the requisition an application points at          |   1 (what they were put forward for) |
 *   | the latest CV extraction's `currentJobTitle`      |  71 (the role they hold today) |
 *
 * Order matters and is not arbitrary. A human's typed value always wins. After that comes what the
 * SENDER wrote — the subject line, the caption — because the job someone wants is a statement of
 * intent, and a CV describes what they have done, not what they want. The AI's reading sits BELOW
 * those because it is derived from them (see `formatCoveringMessage`), so preferring it would be
 * preferring a paraphrase to the original. The requisition is last because only one row has one.
 *
 * Nothing here writes. The stored columns are untouched; this is a reading of evidence already on
 * the record, and every value carries the source it came from so a recruiter can tell a stated
 * role from an inferred one.
 */

/** Where an answer came from. Never hidden from the reader — a guess must not read as a fact. */
export type AppliedForSource = "stated" | "subject" | "message" | "cv" | "requisition" | "current";

export type CandidateAppliedFor = {
  /** The role to show, already cleaned. Null when no source names one. */
  text: string | null;
  /** Which source answered. Null when none did. */
  source: AppliedForSource | null;
  /** The untouched value the answer was cleaned from, for the hover text. Null when text is null. */
  evidence: string | null;
};

const NOT_RESOLVED: CandidateAppliedFor = { evidence: null, source: null, text: null };

/**
 * Leading boilerplate, stripped repeatedly until nothing more comes off.
 *
 * Every entry is here because a production row needed it — "APPLICATION FOR EMPLOYMENT AS NATIONAL
 * SALES MANAGER", "Apply for the Post of National Sales Manager", "CV for the position of National
 * Sales Manager- Sato Pharma", "Job vacancy : National Sales Manager". Ordered longest-phrase-first
 * so "application for the post of" is not half-eaten by "application for".
 */
const LEADING_BOILERPLATE: RegExp[] = [
  /^\s*(?:job\s+)?application\s+for\s+employment\s+as\s+/i,
  /^\s*(?:apply|applying|application|request)\s+for\s+the\s+(?:post|position|role|job)\s+of\s+/i,
  /^\s*(?:job\s+)?application\s+for\s+/i,
  /^\s*(?:apply|applying)\s+for\s+a\s*:?\s*/i,
  /^\s*(?:apply|applying)\s+(?:for|to)\s+/i,
  /^\s*expression\s+of\s+interest\s*(?:for|in)?\s*/i,
  /^\s*recruitment\s+of\s+/i,
  /^\s*job\s+offer\s*/i,
  /^\s*from\s+sato\s*pharma\s*/i,
  /^\s*(?:job\s+)?(?:vacancy|offer)\s*:?\s*/i,
  /^\s*role\s+of\s+/i,
  /^\s*interest\s+in\s+/i,
  /^\s*for\s+the\s+(?:post|position|role|job)\s+of\s+/i,
  /^\s*application\s*[:\-–—]\s*/i,
  // Stranded by the "CV for …" prefix above: "CV for the position of National Sales Manager- Sato
  // Pharma" has its "CV for " taken off as a name-or-job prefix, which leaves "the position of"
  // standing in front of the role. The entry two lines up only fires when the string STARTS with
  // it, so it never saw this one — the cell read "the position of National Sales Manager" on prod.
  /^\s*the\s+(?:post|position|role|job)\s+of\s+/i,
  /^\s*(?:for|job)\s+/i,
  // Punctuation and quotes left behind by the phrases above, or typed by the sender.
  /^[\s"'“”«»:;,.\-–—|/\\]+/,
];

/** `Re:`, `Fwd:`, `Subject:` — stripped before anything else looks at the string. */
const ENVELOPE_PREFIX: RegExp[] = [/^\s*(?:re|fw|fwd)\s*:\s*/i, /^\s*subject\s*:\s*/i, /^[\s"'“”«»:;,.\-–—|/\\]+/];

/**
 * Openings that are followed by a PERSON as often as by a job — "Cv for Thabo Nkosi",
 * "Fwd: Job Inquiry - Anil Kumar Bhat" against "Cv for district manager job for upper Egypt".
 *
 * The prefix itself proves the rest of the string is the subject of a sentence, so whatever follows
 * is either the role or the applicant's name and there is no third option. What follows therefore
 * has to name a job, and when it does not the whole row is rejected rather than cleaned — a name in
 * a column headed "Applying for" is a worse answer than no answer.
 */
const NAME_OR_JOB_PREFIX: RegExp[] = [
  /^\s*(?:my\s+)?(?:cv|c\.?v\.?|resume)\s+for\s+/i,
  /^\s*(?:job\s+)?(?:inquiry|enquiry)\s*[-–—:]?\s*/i,
  // A bare "CV <something>" — "Cv Accountant" is a role, "Michael'Cv National sales manager" is a
  // role with a name stuck to it, and "Bassem cv" is only a name. Same test decides all three.
  /^\s*(?:cv|resume)\s+/i,
];

/**
 * Trailing boilerplate. Same rule: each one earned its place.
 * "Sales manager position", "Office Coordinator job", "National Sales Manager post",
 * "Accounts Payable Accountant – Sato Pharma", "Office Coordinator at Sato Pharma".
 */
const TRAILING_BOILERPLATE: RegExp[] = [
  /[\s"'“”«»:;,.\-–—|/\\]+$/,
  /\s*(?:at|for|from|with|[-–—|])\s*sato\s*pharma\s*$/i,
  /\s+(?:position|post|vacancy|job|role)\s*$/i,
];

/** A filename in the role slot. WhatsApp puts the document's name where a caption would go. */
const LOOKS_LIKE_A_FILENAME = /\.(?:pdf|docx?|jpe?g|png|webp|heic|rtf|txt)\s*$/i;

/**
 * What is left after cleaning but still names no job.
 *
 * Kept deliberately small and literal — this rejects a whole row, so a wrong entry here silently
 * blanks a cell that had an answer. "HR" is NOT in it: it is the entire subject on 18 production
 * rows, and a recruiter reads it as an answer.
 */
const NAMES_NO_JOB = new Set([
  "...",
  "apply",
  "application",
  "applications",
  "c.v",
  "c.v.",
  "cv",
  "job",
  "job application",
  "job applications",
  "my cv",
  "resume",
]);

/**
 * Subjects that arrived in the recruitment mailbox but are not somebody applying for work.
 *
 * These are real production rows — a maternity-leave request, a supplier registration, a price
 * quotation, an insurance circular. Reading a job title out of them would put a fabricated role on
 * a person's record, which is worse than an empty cell: the column is used to decide which manager
 * receives the CV.
 */
const NOT_AN_APPLICATION = [
  // No word-boundary anchors on the Arabic patterns. JS defines \b by [A-Za-z0-9_], so an Arabic
  // letter never sits on one and putting a \b in front of one matches nothing whatsoever — which
  // silently let a maternity-leave request through as a job title until it was measured.
  /طلب\s+إجازة/,
  /طلب\s+عرض\s+سعر/,
  /قيد\s+موردين/,
  /\binterview\s+confirmation\b/i,
  /\bcertificate\s+of\s+attendance\b/i,
  /\bmedical\s+insur\w*\s*&?\s*life\s+protection\b/i,
  /\bbenefits\s+20\d\d\s*\/\s*20\d\d\b/i,
];

/** Longer than this and the value is a sentence about a person, not the name of a job. */
const LONGEST_PLAUSIBLE_TITLE = 70;

/**
 * Words that make a string a job rather than a person.
 *
 * Used ONLY as a tiebreaker on the doubtful paths — a subject that had to be cut at a dash because
 * it was too long, or one whose trailing "cv" left a single bare word. The ordinary path never
 * consults it, so a real title absent from this list is not rejected; it is only the salvage
 * attempts that have to prove they found a job and not somebody's name. Without it,
 * "Amr cv" becomes "Amr" and ":: Nabil Abd El Rasoul - CV :: …" becomes "Nabil Abd El Rasoul" —
 * a person's name sitting in a column headed "Applying for", which is worse than an empty cell.
 *
 * English and Arabic, because 25 production rows state the role in Arabic.
 */
const JOB_WORDS =
  /\b(?:manager|manger|manag\w*|specialist|special\w*|accountant|account\w*|representative|rep|supervisor|coordinator|coordinat\w*|executive|officer|engineer|pharmacist|generalist|consultant|analyst|director|assistant|clerk|technician|intern|internship|trainee|payroll|recruitment|personnel|finance|financial|marketing|medical|sales|quality|production|legal|procurement|logistics|admin|administration|hr|it|nsm|dsm|mr|gm|avp|call\s*center|telesales|business\s+development|product|regulatory|health|banking|store|supply\s+chain)\b|محاسب|مدير|أخصائي|اخصائي|مسئول|مسؤول|موارد|وظيف|منسق|خبير|مندوب|صيدل/i;

/**
 * Two, not three. "HR" is the whole subject on 18 production rows and "Apply for HR" reduces to it
 * on four more — a department rather than a title, but a recruiter reads it as an answer, and a
 * three-character floor would silently drop all 22.
 */
const SHORTEST_PLAUSIBLE_TITLE = 2;

function stripRepeatedly(value: string, patterns: RegExp[]): string {
  let current = value;
  // Bounded rather than `while (true)`: each pass must remove something, and a dozen passes is far
  // more than any real subject needs ("Fwd: Re: Application for …" is three).
  for (let pass = 0; pass < 12; pass += 1) {
    let next = current;
    for (const pattern of patterns) next = next.replace(pattern, "");
    next = next.trim();
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * The nouns an English job title ends on.
 *
 * Used only by the salvage pass below, never by the ordinary path — a real title whose noun is
 * missing here is still read normally; it just cannot be rescued out of a filename.
 */
const JOB_NOUN =
  "(?:manager|manger|specialist|accountant|representative|supervisor|coordinator|executive|officer|engineer|pharmacist|generalist|consultant|analyst|director|assistant|technician|clerk|trainee)";

/**
 * The words allowed to stand IN FRONT of that noun. Closed on purpose.
 *
 * A filename is mostly somebody's name, so an open-ended "take the two words before the noun" turns
 * `Wagih_Sorour_Senior_Accountant.pdf` into "Sorour Senior Accountant". Every word here is a word that
 * qualifies a job and is not a person's name, so what the pass can produce is bounded by
 * construction rather than by hoping the guess is right.
 *
 * Every applicant name in this file's examples is INVENTED. Each was a real person's until
 * 2026-08-28 — the subject lines and filenames keep their exact SHAPE, which is the only thing
 * these rules read.
 */
const TITLE_QUALIFIER =
  "(?:senior|junior|assistant|deputy|chief|head|lead|first|second|third|regional|district|national|area|zone|field|product|brand|medical|scientific|clinical|veterinary|regulatory|sales|marketing|digital|export|import|hr|human|resources|talent|acquisition|recruitment|personnel|payroll|training|finance|financial|accounts?|accounting|treasury|tax|cost|audit|internal|legal|procurement|purchasing|logistics|supply|chain|warehouse|store|stores|plant|production|manufacturing|maintenance|quality|control|assurance|safety|health|environment|it|software|network|systems?|data|business|development|key|account|customer|service|client|project|program|office|administrative|admin|general|technical|operations?|line|unit)";

const SALVAGEABLE_TITLE = new RegExp(`\\b(?:${TITLE_QUALIFIER}[\\s]+){0,3}${JOB_NOUN}\\b`, "gi");

/**
 * Last resort: pull a job title out of a string that is mostly not one.
 *
 * `Nader_Bahgat_District_Sales_Manager_CV.pdf` is a filename, so the ordinary path rejects the whole
 * value — and yet the answer is written across the middle of it. Same for
 * `Wagih_Sorour_Senior_Accountant.pdf`, and for
 * `:: Nabil Abd El Rasoul - CV :: HR-Recruitment Consultant / …`, where the role is buried between
 * separators. This pass runs ONLY after the normal read has already returned null, so it can never
 * override a cleanly-read title; and it fires only on the closed vocabulary above, so on the rest of
 * the rejected rows — "Bassem cv", "Bahgat CV PDFF.pdf", "Re: Job offer from Sato Pharma" — it finds
 * nothing and the cell stays honestly empty.
 *
 * Longest match wins: "District Sales Manager" beats "Sales Manager" beats "Manager".
 */
function salvageTitlePhrase(value: string): string | null {
  // Filenames and headers separate words with punctuation, not spaces.
  const spaced = value.replace(/[_/\\|.:;,()[\]]+/g, " ").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim();
  let best: string | null = null;
  for (const match of spaced.matchAll(SALVAGEABLE_TITLE)) {
    const found = match[0].trim();
    if (!best || found.length > best.length) best = found;
  }
  if (!best || best.length > LONGEST_PLAUSIBLE_TITLE) return null;
  return best;
}

/**
 * Noise that survives the leading/trailing strips because it sits in the MIDDLE of the subject.
 *
 * Measured on production 2026-08-21: 396 rows answered, and 24 distinct answers still read as a
 * sentence rather than a job — "Office Coordinator Position – Amira Lotfy", "National sales
 * Manager- 15 yrs of exp in UAE in all the channels", "Zaher halawa cv District manager upper
 * Egypt". The role is in every one of them; it is wearing the sender's name, their CV filename and
 * their years of experience.
 *
 * The line this pass will not cross: it removes a PERSON, a FILLER WORD, a CV marker, a boast and a
 * date, and nothing else. A place, a line name, a qualification and a second role all stay, because
 * "National Sales Manager – Anti-Infective Line", "Senior Medical Sales Representative (Nigeria)"
 * and "HR Generalist / HR Operations / Personnel & Payroll" are not noisy — they are three people
 * telling a recruiter something worth reading, and 10 of the 24 are of exactly that kind.
 *
 * Nothing is lost either way: `evidence` still carries the untouched string, and the cell's hover
 * text shows it.
 */

/** Filler that means "this is an application" and never names the job. Eats one separator with it. */
const MIDDLE_FILLER = /\s*\b(?:position|post|vacancy|job|role|application|applying|request)\b\s*[-–—:_,./]?\s*/gi;

/**
 * A marker with a person in front of it — "Zaher halawa cv …", "Anil Bhandari _ Resume_…",
 * "WAFAA-SARHAN-Application for …". Only ever applied when a job word is left standing behind it.
 *
 * The marker ends on `(?![A-Za-z])`, NOT on `\b`. An underscore is a word character in JS, so `\b`
 * does not exist between "Resume" and "_National" — with a `\b` here the whole rule silently missed
 * `Anil Bhandari _ Resume_National Sales Manager` and left the sender's name in the column. Same
 * root cause as the Arabic patterns in NOT_AN_APPLICATION above: `\b` is defined by [A-Za-z0-9_]
 * and nothing else, which is exactly the set a filename separator is drawn from.
 */
const NAME_BEFORE_MARKER =
  /^.*?\b(?:cv|c\.?v\.?|resume|application\s+for|apply\s+for)(?![A-Za-z])\s*(?:for\s+the\s+(?:post|position|role)\s+of|as|[_\-:/])?\s*/i;

/**
 * A person's name at the end — "… – Amira Lotfy", "… ,Nourhan Fathy", "… (Tarek Zohny)".
 *
 * Two or three words, each capitalised and purely alphabetic, and reachable ONLY across an explicit
 * separator that has whitespace in front of it. That separator is the whole safety margin, and it
 * was added after measuring: without it the same pattern reads "Qena Luxor", "Upper Egypt" and
 * "Kafr Elsheikh" as people and deletes three governorates, and eats "Infective Line" out of the
 * middle of "Anti-Infective". Requiring the run to reach the end of the string is what protects
 * "National Sales Manager – Anti-Infective Line", whose tail is not a pure run.
 *
 * The cost of the caution is that "Finance Manager Adib Sanad" keeps its name. A surname with
 * nothing in front of it is genuinely indistinguishable from a town, and a kept name is a blemish
 * where a deleted territory is a wrong answer.
 */
const TRAILING_PERSON_NAME = /(?:\s+[-–—|]|\s*,)\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\s*$/;

/** The same, bracketed — "National Sales Manager (Tarek Zohny)". "(Nigeria)" is one word, so it stays. */
const BRACKETED_PERSON_NAME = /\s*\([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\)\s*$/;

/** Boasts and biography: what the applicant is like, never what the job is. */
const APPLICANT_BIOGRAPHY: RegExp[] = [
  /^\s*(?:highly\s+)?experienced\s+/i,
  /\s*[-–—|,]?\s*(?:seeking|looking\s+for|open\s+to)\s+\w+.*$/i,
  /\s*[-–—|,]\s*\d+\s*(?:\+)?\s*(?:yrs?|years?)\b.*$/i,
  /\s*[-–—|,]?\s*fresh\s+gradu\w*\s*$/i,
  /\s+residen(?:t|ce)\s+\p{L}+\s*$/iu,
  // "(August–October 2026)" — a date, not a place. "(Nigeria)" has no year and no month, and stays.
  /\s*\((?=[^)]*(?:\b20\d\d\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))[^)]*\)\s*$/i,
  /\s+\d\s*$/,
];

/**
 * Cuts the noise out of an already-clean title, or returns it untouched.
 *
 * Every step is conditional on a job word still standing afterwards, so the failure mode is "no
 * change", never "the role was removed". The result is also never allowed to grow.
 */
function tightenJobTitle(title: string): string {
  const keepIfStillAJob = (next: string): string | null => {
    const tidied = stripRepeatedly(next, TRAILING_BOILERPLATE)
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .replace(/\s+([,.])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!tidied || tidied.length < SHORTEST_PLAUSIBLE_TITLE) return null;
    if (!JOB_WORDS.test(tidied) || NAMES_NO_JOB.has(tidied.toLowerCase())) return null;
    return tidied;
  };

  let current = title;

  // A tail that names a job is not a person, whatever it looks like. "HR | Administration |
  // Operations Manager" is two capitalised words after a separator and it is the ROLE — dropping it
  // left "HR | Administration". The remainder-still-a-job check cannot catch that on its own,
  // because "HR" is itself a job word and the wreckage passes.
  const dropIfNotAJob = (pattern: RegExp) => {
    const removed = current.match(pattern)?.[0] ?? "";
    if (JOB_WORDS.test(removed)) return;
    current = keepIfStillAJob(current.replace(pattern, "")) ?? current;
  };

  // A marker only proves a name is in front of it when a job is left standing behind it.
  current = keepIfStillAJob(current.replace(NAME_BEFORE_MARKER, "")) ?? current;
  for (const pattern of APPLICANT_BIOGRAPHY) current = keepIfStillAJob(current.replace(pattern, " ")) ?? current;
  // Names before filler: "Office Coordinator Position – Amira Lotfy" needs its separator intact
  // to find the name, and only then is "Position" noise with nothing after it.
  dropIfNotAJob(BRACKETED_PERSON_NAME);
  dropIfNotAJob(TRAILING_PERSON_NAME);
  current = keepIfStillAJob(current.replace(MIDDLE_FILLER, " ")) ?? current;

  return current.length < title.length ? current : title;
}

/**
 * Turns one raw candidate string into a job title, or null if it does not name one.
 *
 * NFKC first, which is what folds the mathematical-bold letters some senders use for emphasis —
 * "𝐍𝐚𝐭𝐢𝐨𝐧𝐚𝐥 𝐒𝐚𝐥𝐞𝐬 𝐌𝐚𝐧𝐚𝐠𝐞𝐫" is ten production rows, and without this it is a different string from
 * "National Sales Manager" in every filter, export and count.
 *
 * Exported for the tests and for the backfill script; callers should prefer `candidateAppliedFor`.
 */
export function cleanJobTitle(raw: string | null | undefined, options?: { tighten?: boolean }): string | null {
  const start = String(raw ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (!start) return null;
  // Ahead of everything, including the salvage pass: a maternity-leave request or an insurance
  // circular must never yield a role, however many job words it happens to contain.
  if (NOT_AN_APPLICATION.some((pattern) => pattern.test(start))) return null;
  const read = readJobTitle(start);
  if (!read) return salvageTitlePhrase(start);
  return options?.tighten === false ? read : tightenJobTitle(read);
}

function readJobTitle(start: string): string | null {
  if (LOOKS_LIKE_A_FILENAME.test(start)) return null;

  const unwrapped = stripRepeatedly(start, ENVELOPE_PREFIX);

  // "CV for …", "Job Inquiry — …": whatever follows is the role or the applicant, never both.
  for (const prefix of NAME_OR_JOB_PREFIX) {
    if (!prefix.test(unwrapped)) continue;
    const rest = stripRepeatedly(stripRepeatedly(unwrapped.replace(prefix, ""), LEADING_BOILERPLATE), TRAILING_BOILERPLATE);
    return rest && JOB_WORDS.test(rest) && rest.length <= LONGEST_PLAUSIBLE_TITLE ? rest : null;
  }

  let title = stripRepeatedly(unwrapped, LEADING_BOILERPLATE);
  title = stripRepeatedly(title, TRAILING_BOILERPLATE);

  // A trailing "cv" is only boilerplate when a job is still standing after it goes. "Sales cv"
  // shortens to "Sales"; "Amr cv" and "Fawzy Elsaid Fawzy C.V." shorten to a person, and the "cv"
  // is the proof that is all they ever were — so those are rejected outright, not left whole.
  const withoutCv = stripRepeatedly(title, [/\s+(?:cv|c\.?v\.?|resume)\s*$/i, /[\s\-–—|.,]+$/]);
  if (withoutCv !== title) {
    if (!withoutCv || !JOB_WORDS.test(withoutCv)) return null;
    title = withoutCv;
  }

  // Too long to be a job title, but subjects of that length are nearly always "<the role> – <the
  // person>" or "<the role> | <a qualification>". Take the first segment, and only keep it if it
  // actually names a job — otherwise the salvage would promote the sender's name into the column.
  if (title.length > LONGEST_PLAUSIBLE_TITLE) {
    const head = stripRepeatedly(title.split(/\s+[–—|]\s+|\s+-\s+/)[0] ?? "", TRAILING_BOILERPLATE);
    title = head && head.length <= LONGEST_PLAUSIBLE_TITLE && JOB_WORDS.test(head) ? head : title;
  }

  if (!title) return null;
  if (LOOKS_LIKE_A_FILENAME.test(title)) return null;
  if (title.length < SHORTEST_PLAUSIBLE_TITLE || title.length > LONGEST_PLAUSIBLE_TITLE) return null;
  if (NAMES_NO_JOB.has(title.toLowerCase())) return null;
  // A remainder with no letter in it at all — a date, a reference number, stray punctuation.
  if (!/\p{L}/u.test(title)) return null;
  return title;
}

/** `Subject(` … `)` — the forwarder's envelope, written into `full_name` at intake. */
const FORWARDED_SUBJECT = /Subject\(([^)]*)\)/;

export type AppliedForEvidence = {
  /** `ats_candidates.applied_for_job_title` — a human typed it. Always wins. */
  statedJobTitle?: string | null;
  /** `ats_candidate_source_context.subject` — the subject line of the email the CV arrived on. */
  sourceSubject?: string | null;
  /**
   * What the sender typed on WhatsApp — the caption on the document, then the messages that came
   * just before it, oldest first. A list rather than one string because the caption is regularly
   * only the filename ("Cv.pdf") while the role is in the message above it.
   */
  sourceMessages?: ReadonlyArray<string | null | undefined>;
  /** `ats_candidates.full_name` — the intake envelope, which carries `Subject( … )`. */
  fullName?: string | null;
  /** The latest CV extraction's `appliedForJobTitle.value`. */
  cvExtractionJobTitle?: string | null;
  /** The job title of the requisition this candidate has an application against. */
  requisitionJobTitle?: string | null;
  /**
   * The latest CV extraction's `currentJobTitle.value` — the job they hold TODAY, not one they
   * asked for. Last resort, and labelled as such on screen; see the ladder below.
   */
  cvCurrentJobTitle?: string | null;
};

/**
 * The role to show for a candidate, and where it came from.
 *
 * Walks the sources in order of how directly each one states intent, and returns the first that
 * survives cleaning. Never invents: when no source names a job it returns nulls, because a wrong
 * job title routes a CV to the wrong hiring manager, and that is worse than an empty cell.
 */
export function candidateAppliedFor(evidence: AppliedForEvidence): CandidateAppliedFor {
  const ladder: Array<[AppliedForSource, string | null | undefined]> = [
    ["stated", evidence.statedJobTitle],
    ["subject", evidence.sourceSubject],
    ...(evidence.sourceMessages ?? []).map((line): [AppliedForSource, string | null | undefined] => ["message", line]),
    ["subject", (evidence.fullName ?? "").match(FORWARDED_SUBJECT)?.[1]],
    ["cv", evidence.cvExtractionJobTitle],
    ["requisition", evidence.requisitionJobTitle],
    // LAST, and a different kind of answer from everything above it.
    //
    // Every rung before this one is somebody saying what job they WANT. This one is the job they
    // already HAVE, read off the CV — which is not the same fact, and the column must never let a
    // reader mistake it for one. It earns its place because 117 candidates attached a CV and wrote
    // no covering text of any kind: for them the choice is not "their goal or their current role",
    // it is "their current role or an empty cell", and 71 of the 159 empty cells have one. Its
    // label says so in plain words, on the desktop tooltip and on the mobile card alike.
    ["current", evidence.cvCurrentJobTitle],
  ];

  // The tightening pass exists for ENVELOPES — a subject line or a WhatsApp caption, where the
  // sender's name and their CV filename are glued to the role. The CV extractions and the
  // requisition are structured fields that were never an envelope, so tightening them can only do
  // harm: it read "District Manager - Commercial Unit" as a person and dropped the business unit.
  const STRUCTURED: AppliedForSource[] = ["cv", "requisition", "current"];

  for (const [source, raw] of ladder) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    // A stated title is what a person entered on this record — clean the punctuation off it, but a
    // human's answer is never rejected for looking implausible.
    const text = source === "stated" ? value : cleanJobTitle(value, { tighten: !STRUCTURED.includes(source) });
    if (!text) continue;
    // A chat message has to prove it names a job; a subject line does not.
    //
    // A subject line is written to say what the mail is ABOUT, so shorthand with no recognisable job
    // word in it is still an answer — "Cairo 2 DM", "M.r - Gharbia", "Mohamed Hassan D.M" are five
    // production rows, and requiring a job word would throw all five away. A WhatsApp message is not
    // written to say anything of the kind: of the seven rows it answered on the first production
    // run, four were "صباح الخير" (good morning) and a home address. Those went in a column that
    // decides which manager receives the CV.
    if (source === "message" && !JOB_WORDS.test(text)) continue;
    return { evidence: value, source, text };
  }
  return NOT_RESOLVED;
}

/**
 * Just enough of a candidate row to read the evidence off it.
 *
 * Structural rather than the domain `Candidate`, because `types.ts` imports THIS module (it carries
 * `CandidateAppliedFor` on the row) and importing back would make a cycle.
 */
export type AppliedForCandidateRow = {
  appliedFor?: CandidateAppliedFor | null;
  appliedForJobTitle?: string | null;
  fullName?: string | null;
  sourceContext?: { channel: "email" | "whatsapp" | null; shortLabel: string | null; detailLines: string[] } | null;
};

/**
 * The evidence that is already on the row — nothing here costs a database round trip. This alone
 * answers 432 of the 555 production rows; the two loaders in `candidates.ts` exist only for what is
 * left after it.
 */
export function freeAppliedForEvidence(candidate: AppliedForCandidateRow): AppliedForEvidence {
  const context = candidate.sourceContext;
  return {
    fullName: candidate.fullName,
    sourceMessages: context?.channel === "whatsapp" ? context.detailLines : [],
    sourceSubject: context?.channel === "email" ? context.shortLabel : null,
    statedJobTitle: candidate.appliedForJobTitle,
  };
}

/**
 * What to render for a candidate row.
 *
 * Prefers the answer `listCandidates` already resolved — it is the only one that saw the CV
 * extraction and the requisition — and falls back to the free evidence for the surfaces that load a
 * candidate on their own (`getCandidate`, the manager's push list), so those never regress to
 * "Not stated" just because the fuller loader did not run.
 */
export function candidateRowAppliedFor(candidate: AppliedForCandidateRow): CandidateAppliedFor {
  if (candidate.appliedFor?.text) return candidate.appliedFor;
  return candidateAppliedFor(freeAppliedForEvidence(candidate));
}

/** How a source should be described to a recruiter, in words rather than a column name. */
export const APPLIED_FOR_SOURCE_LABEL: Record<AppliedForSource, string> = {
  // Says "did not say" first, because this one is the job they HOLD, not one they asked for.
  current: "They did not say which job they want — this is the role they hold now, read from their CV",
  cv: "Read by the CV reader from the message this CV arrived on",
  message: "Read from the message the sender typed with this CV",
  requisition: "Taken from the vacancy this candidate was put forward for",
  stated: "Entered on the candidate's record",
  subject: "Read from the subject line of the message this CV arrived on",
};

/**
 * The same fact in a few words, for a mobile card, which has no tooltip and must not wrap.
 * `stated` has no entry: a stated title is the plain case and the card says nothing extra about it.
 */
export const APPLIED_FOR_SOURCE_SHORT: Record<Exclude<AppliedForSource, "stated">, string> = {
  current: "their role now, per CV",
  cv: "read from the CV",
  message: "from the sender's message",
  requisition: "from the vacancy",
  subject: "from the subject line",
};
