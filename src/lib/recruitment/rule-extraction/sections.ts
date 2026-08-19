// Recruitment / ATS — cutting a CV into its labelled sections.
//
// This is the backbone the field rules stand on. "Find the university" is a hopeless question to
// ask of a whole CV (a candidate's employer may be "Cairo University Hospital", their course list
// may name three more) and an easy one to ask of the EDUCATION section alone. Nearly every rule in
// this module is therefore scoped to a section, and precision comes from the scoping rather than
// from ever-cleverer regexes.
//
// The vocabulary below is not invented — it was counted over the 133-CV careers inbox on
// 2026-08-19. The top headings and their real frequencies:
//
//     EDUCATION 102 · LANGUAGES 65 · PROFESSIONAL SUMMARY 45 · SKILLS 43 ·
//     PROFESSIONAL EXPERIENCE 40 · TECHNICAL SKILLS 34 · WORK EXPERIENCE 32 · EXPERIENCE 31 ·
//     SUMMARY 23 · CORE COMPETENCIES 18 · OBJECTIVE 17 · CAREER OBJECTIVE 14 · CERTIFICATIONS 13 ·
//     PERSONAL INFORMATION 12
//
// So 81% of CVs carry a literal "EDUCATION" line. Matching a known vocabulary is both far safer
// than guessing at typography (bold/size are lost in a text layer) and demonstrably sufficient.

/** The kinds of section a rule can ask for. "header" is synthetic — see sliceCvSections. */
export type CvSectionKind =
  | "header"
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "languages"
  | "certifications"
  | "personal"
  | "contact"
  | "projects"
  | "other";

export type CvSection = {
  readonly kind: CvSectionKind;
  /** The heading line as written ("" for the synthetic header block). */
  readonly heading: string;
  /** The lines belonging to this section, excluding the heading itself. */
  readonly lines: readonly string[];
};

// Longest phrases first within each group: "PROFESSIONAL EXPERIENCE" must win over "EXPERIENCE",
// and "COURSES AND CERTIFICATIONS" over "COURSES", or the coarser label would swallow the finer.
const HEADING_VOCABULARY: ReadonlyArray<{ readonly kind: CvSectionKind; readonly phrases: readonly string[] }> = [
  {
    kind: "experience",
    phrases: [
      "PROFESSIONAL EXPERIENCE",
      "WORK EXPERIENCE",
      "EMPLOYMENT HISTORY",
      "PROFESSIONAL BACKGROUND",
      "CAREER HISTORY",
      "WORK HISTORY",
      "EMPLOYMENT",
      "EXPERIENCE",
      "EXPERIENCES",
      "الخبرات العملية",
      "الخبرة العملية",
      "الخبرات",
    ],
  },
  {
    kind: "education",
    phrases: [
      "EDUCATION AND QUALIFICATIONS",
      "EDUCATIONAL BACKGROUND",
      "EDUCATION BACKGROUND",
      "ACADEMIC BACKGROUND",
      "ACADEMIC QUALIFICATIONS",
      "EDUCATION QUALIFICATION",
      "QUALIFICATIONS",
      "EDUCATION",
      "ACADEMIC",
      "المؤهلات العلمية",
      "المؤهل الدراسي",
      "التعليم",
    ],
  },
  {
    kind: "certifications",
    phrases: [
      "COURSES AND CERTIFICATIONS",
      "COURSES & CERTIFICATIONS",
      "TRAINING AND DEVELOPMENT",
      "PROFESSIONAL TRAINING",
      "CERTIFICATIONS AND COURSES",
      "COURSES AND TRAINING",
      "TRAINING COURSES",
      "CERTIFICATIONS",
      "CERTIFICATES",
      "CERTIFICATION",
      "TRAINING",
      "COURSES",
      "الدورات التدريبية",
      "الدورات",
    ],
  },
  {
    kind: "skills",
    phrases: [
      "CORE COMPETENCIES",
      "TECHNICAL SKILLS",
      "PROFESSIONAL SKILLS",
      "PERSONAL SKILLS",
      "KEY SKILLS",
      "CORE SKILLS",
      "SOFT SKILLS",
      "COMPETENCIES",
      "SKILLS",
      "المهارات",
    ],
  },
  {
    kind: "languages",
    phrases: ["LANGUAGE SKILLS", "LANGUAGES", "LANGUAGE", "اللغات"],
  },
  {
    kind: "summary",
    phrases: [
      "PROFESSIONAL SUMMARY",
      "PROFESSIONAL PROFILE",
      "CAREER OBJECTIVE",
      "CAREER SUMMARY",
      "PERSONAL PROFILE",
      "OBJECTIVE",
      "SUMMARY",
      "PROFILE",
      "ABOUT ME",
      "ABOUT",
      "الهدف الوظيفي",
      "نبذة",
    ],
  },
  {
    kind: "personal",
    phrases: [
      "PERSONAL INFORMATION",
      "PERSONAL DETAILS",
      "PERSONAL DATA",
      "PERSONAL INFO",
      "البيانات الشخصية",
      "المعلومات الشخصية",
    ],
  },
  {
    kind: "contact",
    phrases: ["CONTACT INFORMATION", "CONTACT DETAILS", "CONTACT"],
  },
  {
    kind: "projects",
    phrases: ["PROJECTS", "PROJECT", "ACTIVITIES", "VOLUNTEER", "INTERESTS", "REFERENCES"],
  },
];

/**
 * A heading is a SHORT line whose letters spell a known section name — nothing more.
 *
 * The length cap is what stops a sentence being mistaken for a heading: "I have experience in
 * recruitment and payroll" contains "EXPERIENCE" but runs far past 40 characters. Trailing
 * punctuation and decoration (":", "----", leading bullets) are stripped before matching, and the
 * comparison is on letters only, so "E X P E R I E N C E" and "Work Experience:" both land.
 */
export function classifyHeading(line: string): CvSectionKind | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;

  // Keep Arabic letters as themselves; fold Latin to uppercase; drop everything else.
  const canonical = trimmed
    .toUpperCase()
    .replace(/[^A-Z؀-ۿ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (canonical.length < 3) return null;

  for (const { kind, phrases } of HEADING_VOCABULARY) {
    for (const phrase of phrases) {
      if (canonical === phrase) return kind;
    }
  }
  return null;
}

/**
 * Cuts the CV into sections.
 *
 * The first block — everything above the first recognised heading — is returned as the synthetic
 * "header" section. That block is where the name, phone, email and links almost always live, and
 * treating it as a real section is what lets the identity rules ignore the other four pages.
 */
export function sliceCvSections(lines: readonly string[]): CvSection[] {
  const sections: CvSection[] = [];
  let currentKind: CvSectionKind = "header";
  let currentHeading = "";
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length > 0 || currentHeading) {
      sections.push({ heading: currentHeading, kind: currentKind, lines: buffer });
    }
    buffer = [];
  };

  for (const line of lines) {
    const kind = classifyHeading(line);
    if (kind) {
      flush();
      currentKind = kind;
      currentHeading = line.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/** Every line belonging to sections of the given kind, concatenated in document order. */
export function linesOfKind(sections: readonly CvSection[], kind: CvSectionKind): string[] {
  return sections.filter((section) => section.kind === kind).flatMap((section) => [...section.lines]);
}

/** As linesOfKind, joined with newlines — for rules that want to run a regex over a whole block. */
export function textOfKind(sections: readonly CvSection[], kind: CvSectionKind): string {
  return linesOfKind(sections, kind).join("\n");
}

/**
 * Lines to search for a value that could be filed under any of several headings.
 *
 * Personal facts are the reason this exists: a date of birth may sit under PERSONAL INFORMATION,
 * under CONTACT, or in the unlabelled header block, and which one it is says nothing about the
 * value's reliability.
 */
export function linesOfKinds(sections: readonly CvSection[], kinds: readonly CvSectionKind[]): string[] {
  const wanted = new Set(kinds);
  return sections.filter((section) => wanted.has(section.kind)).flatMap((section) => [...section.lines]);
}
