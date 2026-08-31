// Recruitment / ATS — is this graduate eligible for the field force, or paramedical?
//
// The owner, 2026-08-31: *"I want the non science or pharmacy or vet to be excluded in a separate
// folder. Name this folder paramedical."* Asked the same day whether a doctor counts, he answered:
// *"medicine and dentistry are accepted. And add them in the question."*
//
// So the eligible set is FIVE disciplines — pharmacy, science, veterinary, medicine, dentistry — and
// everything else is paramedical. That is the whole rule. What the rest of this file is for is the
// part that is not the rule: WHERE the answer came from, and what may be done without asking a human.
//
// ── THE ASYMMETRY THIS MODULE EXISTS TO HOLD ────────────────────────────────────────────────────
//
// The two directions are not equally safe, and the owner's own instruction already splits them:
// *"the two hundred eligible, you will backfill them. But anyone non eligible, you will make the
// admin be able to check first their CV and confirm."*
//
//   ELIGIBLE     is the INCLUSIVE direction. Getting it wrong leaves a CV in the pool, where a
//                recruiter reads it anyway. Cost of an error: somebody reads one extra CV.
//   PARAMEDICAL  is the EXCLUSIVE direction. Getting it wrong takes a real applicant off the screen
//                the recruiters work from, and nothing ever brings them back — nobody re-reads a
//                folder named for people who were filtered out. Cost of an error: a lost candidate.
//
// So `autoFilable` is TRUE only for eligible, whatever the source, and paramedical ALWAYS waits for
// a person. This is the same shape as the owner's standing rule elsewhere in the system — it flags,
// the human decides — and it is why this module returns a verdict with its evidence rather than a
// boolean somebody would file on directly.
//
// ── DECLARED BEATS EXTRACTED, AND `unknown` IS A REAL ANSWER ────────────────────────────────────
//
// Two sources, and they are not the same kind of fact. `declaredBackground` is what the applicant
// TAPPED on WhatsApp — their own statement of their own degree. `faculty` is what the extractor read
// off the CV, which is an inference and is wrong at an inference's rate. Declared is therefore tried
// first and never overruled by the CV.
//
// Anything this module cannot place returns `unknown`, never a guess. Measured in production
// 2026-08-31, 161 of 372 CV faculties do not match any of the five disciplines, and a good share of
// those are simply unparseable strings rather than genuinely other degrees. Guessing would push them
// into the exclusive direction, which is precisely the direction that must never be guessed.
//
// PURE — no database, no React. Same rule as candidate-folder.ts and for the same reason: this is
// reached from a "use client" screen, so a database import anywhere in the chain would drag the
// service-role client into the browser bundle.

import {
  candidateBackgroundLabels,
  type CandidateBackgroundCode,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";

// The shelf a paramedical CV is filed on. Re-exported rather than restated: this module DECIDES who
// belongs there, candidate-folder.ts owns what the folder is called, and the two must not each hold
// their own copy of the string.
export { PARAMEDICAL_FOLDER_KEY } from "@/lib/recruitment/candidate-folder";

export type BackgroundOutcome = "eligible" | "paramedical" | "unknown";

/** Where the verdict came from — shown beside it, because the two carry different weight. */
export type BackgroundSource = "declared" | "cv";

export type BackgroundVerdict = {
  outcome: BackgroundOutcome;
  /** Null only when `outcome` is "unknown" and there was nothing to read at all. */
  source: BackgroundSource | null;
  /**
   * The discipline recognised, where one was — "pharmacy", "medicine", … Null for paramedical and
   * unknown. Kept as the CODE rather than the label so a caller may render it in its own words.
   */
  discipline: CandidateBackgroundCode | null;
  /**
   * The words the verdict was read from, verbatim. Shown to the admin who confirms an exclusion, so
   * the decision is made against what the applicant or the CV actually said rather than against this
   * module's opinion of it.
   */
  evidence: string | null;
  /**
   * May this be filed without a human?
   *
   * TRUE only for eligible — see the asymmetry note above. A paramedical verdict is a recommendation
   * to an admin and nothing more, however confident it looks.
   */
  autoFilable: boolean;
};

/**
 * The disciplines, as patterns over free text, IN THE ORDER THEY MUST BE TESTED.
 *
 * THE ORDER IS LOAD-BEARING AND IS THE ONLY SUBTLE THING IN THIS FILE. Two Egyptian faculty names
 * contain the word "Medicine" while not being medicine:
 *
 *   "Faculty of Veterinary Medicine"        → veterinary, not medicine
 *   "Faculty of Oral and Dental Medicine"   → dentistry,  not medicine
 *
 * Both are the STANDARD English names of those faculties in Egypt, so this is the common case rather
 * than an edge one. Testing `medicine` before `vet` and `dentistry` would misfile a large share of
 * the 46 veterinary graduates production already holds. Veterinary and dentistry therefore come
 * first, and `medicine` is written to match only the word itself.
 *
 * `medical` is DELIBERATELY NOT a pattern. "Medical Laboratory", "Medical Equipment" and "Medical
 * Representative" are all real strings in this data and none of them is a medicine degree — matching
 * the adjective would quietly promote paramedical graduates into the eligible set, which is the one
 * error this module's whole design is arranged to avoid making silently.
 */
const DISCIPLINE_PATTERNS: ReadonlyArray<{ code: CandidateBackgroundCode; pattern: RegExp }> = [
  // Veterinary FIRST — "Veterinary Medicine" must never reach the medicine rule.
  { code: "vet", pattern: /\b(vet|veterinar\w*)\b|بيطر/iu },
  // Dentistry SECOND — "Oral and Dental Medicine" must never reach it either.
  { code: "dentistry", pattern: /\b(dentist\w*|dental|dentistry)\b|أسنان/iu },
  { code: "pharmacy", pattern: /\b(pharmac\w*)\b|صيدل/iu },
  { code: "medicine", pattern: /\b(medicine|mbbch|m\.?b\.?b\.?ch)\b|طب بشر/iu },
  // "Chemistry" is a Faculty of Science degree that names its DEPARTMENT, not its faculty, so the CV
  // rarely says "science" at all — which is why five real chemistry graduates were reading as
  // unparseable and dropping toward the review queue. `chemist\w*` catches "Chemistry"/"chemist" (not
  // "chemical", which is engineering and stays in KNOWN_OTHER), plus the Arabic كيمياء. Owner
  // 2026-08-31: *"add chemistry to be approved with pharma vet science."* Folded INTO `science` rather
  // than made a sixth code: it is a science degree, not its own discipline, and is deliberately NOT a
  // row in the applicant's question. Geology — the other science department in those same missed CVs —
  // was left out on purpose; the owner named chemistry only, so geology stays paramedical until he
  // says otherwise.
  { code: "science", pattern: /\b(science|sciences|biotechnolog\w*|biochemist\w*|microbiolog\w*|chemist\w*)\b|علوم|كيمياء/iu },
];

/**
 * Degrees that are recognisably NOT one of the five.
 *
 * These change nothing about what may be done — every non-eligible verdict waits for a person
 * either way. What they change is the SHAPE OF THE ADMIN'S QUEUE. Measured in production
 * 2026-08-31, 161 CV faculties match no eligible discipline, and handing somebody 161 undifferentiated
 * rows to confirm is how a review screen becomes a "select all" button. Most of that 161 is not
 * ambiguous at all — "Faculty of Law", "Commerce", "Engineering" — and separating those from the
 * genuinely unreadable strings is what makes the queue something a person can actually work through.
 *
 * Read ONLY after every eligible pattern has been tried, so a faculty naming both loses to the
 * eligible one — "Agricultural Biotechnology" is a science degree, and the inclusive direction is the
 * safe one to resolve ties toward.
 */
const KNOWN_OTHER_PATTERNS: readonly RegExp[] = [
  /\b(law|jurisprudence|sharia)\b|حقوق|شريعة/iu,
  /\b(commerce|commercial|accounting|business|economics|finance|marketing|mba|bbs)\b|تجار/iu,
  /\b(engineer\w*|textile technology)\b|هندس/iu,
  /\b(arts?|literature|history|english department|mass communication|social work)\b|آداب|اداب/iu,
  /\b(agricultur\w*|floriculture)\b|زراع/iu,
  /\b(education|teaching)\b|تربية/iu,
  /\b(tourism|hotels)\b|سياحة/iu,
  /\b(nursing|physical therapy|physiotherapy)\b|تمريض|علاج طبيعي/iu,
  /\b(computer science|information systems|informatika|sistem informasi)\b|حاسبات/iu,
];

function matchesKnownOther(text: string): boolean {
  return KNOWN_OTHER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Trimmed, whitespace-collapsed, and NORMALISED TO NFKC.
 *
 * The normalisation is neither cosmetic nor theoretical. Production holds the faculty string `ﺣﻘﻮق`
 * — Arabic for "law", written in Unicode ARABIC PRESENTATION FORMS rather than in the ordinary
 * Arabic block. Those are different codepoints entirely, so it never matches the `حقوق` in the
 * pattern below and the row reads as unparseable instead of as a law degree. PDF text extraction
 * emits this shape routinely, and PDFs are how these CVs arrive — so for Arabic it is the common
 * case rather than a curio.
 *
 * NFKC folds the presentation forms back onto the standard letters. It also normalises full-width
 * Latin, which the same extractors occasionally produce.
 */
function cleanText(value: string | null | undefined): string | null {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Which of the five disciplines a piece of free text names, or null.
 *
 * Exported because the admin review screen needs to explain itself — showing "we read this as
 * veterinary" beside the faculty string is what lets a person disagree with one row without
 * distrusting the whole list.
 */
/**
 * Phrases containing the word "science" that are NOT a Faculty of Science degree.
 *
 * "Computer Science" and the French "Sciences Commerciales" are both live strings in production, and
 * both match a bare `\bscience\b` — which would file a computing graduate and a commerce graduate as
 * eligible science graduates. This is the one place a false friend can push somebody INTO the
 * eligible set, which is the direction nothing else in this module guards, because every other
 * mistake lands in the review queue where a person sees it.
 *
 * Checked before the science pattern and only against it: "Veterinary Medicine" is a false friend of
 * MEDICINE, and that one is already handled by testing veterinary first.
 */
const SCIENCE_FALSE_FRIENDS =
  /\b(computer|information|political|social|military|commercial|sport|library)\s+sciences?\b|\bsciences?\s+commerciales?\b/iu;

export function matchDiscipline(text: string | null | undefined): CandidateBackgroundCode | null {
  const cleaned = cleanText(text);
  if (!cleaned) return null;
  const scienceIsAFalseFriend = SCIENCE_FALSE_FRIENDS.test(cleaned);
  for (const { code, pattern } of DISCIPLINE_PATTERNS) {
    if (code === "science" && scienceIsAFalseFriend) continue;
    if (pattern.test(cleaned)) return code;
  }
  return null;
}

/**
 * A tapped answer, recognised by its LABEL.
 *
 * `writeClassification` stores the label ("Veterinary"), not the code, so an exact label match is an
 * exact answer — the applicant tapped that row and no inference is involved. Only a TYPED "Other"
 * answer falls through to `matchDiscipline`, which is a rule over free text and is allowed to be
 * wrong the way any rule is. Keeping the two apart is what stops a tapped answer inheriting an
 * inference's error rate, and it is the same split `candidate-folder-suggestion.ts` makes.
 */
function tappedDiscipline(declared: string): CandidateBackgroundCode | null {
  const cleaned = declared.toLowerCase();
  const codes = Object.keys(candidateBackgroundLabels) as CandidateBackgroundCode[];
  return codes.find((code) => candidateBackgroundLabels[code].toLowerCase() === cleaned) ?? null;
}

/** Everything this module reads — structural, so a fixture or a pool row need not be a whole record. */
export type BackgroundSubject = {
  /** The WhatsApp answer: a tapped label, or the applicant's typed words after "Other". */
  declaredBackground?: string | null;
  /** What the extractor read off the CV. An inference — never overrules the declared answer. */
  faculty?: string | null;
};

/**
 * The eligibility verdict for one candidate.
 *
 * Reads the declared answer first and stops there if it has one: the applicant's own statement is
 * the better fact, and letting a CV disagree with it would mean a machine overruling a person about
 * their own degree.
 */
export function judgeBackground(subject: BackgroundSubject | null | undefined): BackgroundVerdict {
  const declared = cleanText(subject?.declaredBackground);
  if (declared) {
    // A tapped row is exact. A typed one goes through the free-text rule, and an unrecognised typed
    // answer is PARAMEDICAL rather than unknown — the applicant did answer, and what they named is
    // not one of the five. That still does not auto-file; it goes to the admin like every exclusion.
    const discipline = tappedDiscipline(declared) ?? matchDiscipline(declared);
    if (discipline) {
      return {
        autoFilable: true,
        discipline,
        evidence: declared,
        outcome: "eligible",
        source: "declared",
      };
    }
    return {
      autoFilable: false,
      discipline: null,
      evidence: declared,
      outcome: "paramedical",
      source: "declared",
    };
  }

  const faculty = cleanText(subject?.faculty);
  if (faculty) {
    const discipline = matchDiscipline(faculty);
    if (discipline) {
      return { autoFilable: true, discipline, evidence: faculty, outcome: "eligible", source: "cv" };
    }
    // A faculty naming a degree we RECOGNISE as something else — law, commerce, engineering — is
    // paramedical. A string the rule simply could not parse is UNKNOWN. Neither may be filed without
    // a person, so this changes no outcome; it changes what the admin's queue looks like, which is
    // the difference between 161 rows somebody works through and 161 rows somebody select-alls.
    if (matchesKnownOther(faculty)) {
      return { autoFilable: false, discipline: null, evidence: faculty, outcome: "paramedical", source: "cv" };
    }
    // Treating a parsing failure as grounds for exclusion is how unreadable strings become quiet
    // removals, so this stays UNKNOWN and says so on screen.
    return { autoFilable: false, discipline: null, evidence: faculty, outcome: "unknown", source: "cv" };
  }

  return { autoFilable: false, discipline: null, evidence: null, outcome: "unknown", source: null };
}

/** True when this candidate may be filed without anybody looking — eligible, and only eligible. */
export function canAutoFileBackground(subject: BackgroundSubject | null | undefined): boolean {
  return judgeBackground(subject).autoFilable;
}

/**
 * One line explaining a verdict, for the admin review screen.
 *
 * Says what was read and where it came from, never a bare judgement. An admin asked to confirm an
 * exclusion needs to see the words the machine read — that is the difference between confirming a
 * decision and rubber-stamping one.
 */
export function describeBackgroundVerdict(verdict: BackgroundVerdict): string {
  const where = verdict.source === "declared" ? "answered on WhatsApp" : "read from the CV";
  if (!verdict.evidence) return "No degree recorded, on the CV or in their answers.";
  if (verdict.outcome === "eligible") {
    const label = verdict.discipline ? candidateBackgroundLabels[verdict.discipline] : "an eligible degree";
    return `${label} — ${where}: "${verdict.evidence}".`;
  }
  if (verdict.outcome === "paramedical") {
    return `Not one of the five eligible degrees — ${where}: "${verdict.evidence}".`;
  }
  return `Could not be matched to a degree — ${where}: "${verdict.evidence}".`;
}
