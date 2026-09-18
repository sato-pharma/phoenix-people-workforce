// Recruitment / ATS — WhatsApp Applicants: what one row of the page carries, and which rows a set of
// filters keeps.
//
// The page (app/(admin)/recruitment/whatsapp-applicants/page.tsx) lists everyone who started the
// WhatsApp bot's questions. A job title is chosen first, and that title's own questions then appear as
// filters. whatsapp-applicants.ts builds every row and every filter once, on the server. This file is
// the half the browser needs, so it stays PURE and imports nothing. The client component filters on
// every change without a round trip, and a test can pin the matching rule without a database.

/** Where the Region column's answer came from, in the owner's order of trust. */
export type WhatsAppApplicantRegionSource = "whatsapp" | "cv" | "cv_unconfirmed";

export type WhatsAppApplicantAnswer = {
  /** Stable within a row: the built-in step's name, or `extra:<question key>`. */
  key: string;
  /** The question, in words. Never a code. */
  question: string;
  /** Their answer, as they gave it. */
  answer: string;
};

export type WhatsAppApplicantRow = {
  /** Unique on the page. The candidate and the title together, because one person can apply for two jobs. */
  key: string;
  candidateId: string;
  name: string;
  /** Where the candidate stands in the pipeline, in words ("New", "Rejected"). */
  statusLabel: string;
  /** The job-title filter's value: the role family they tapped. */
  titleValue: string;
  /** What they typed when they chose "Other" for the job. Null for every tapped title. */
  typedTitle: string | null;
  /** When their conversation with the bot started, which is when their CV arrived. ISO. */
  appliedAt: string;
  /** The company region, and the words saying where it came from. Null when nothing places them. */
  region: { label: string; source: WhatsAppApplicantRegionSource; sourceLine: string } | null;
  /** Everything they answered, in the order the bot asked it. The Region column carries the region. */
  answers: WhatsAppApplicantAnswer[];
  /** Filter key -> this row's value for it. A key that is absent means they never answered that question. */
  values: Record<string, string>;
  /** They answered every question the bot put to them. */
  finished: boolean;
  /** For an unfinished row, the question the bot was left waiting on, in words. */
  waitingOn: string | null;
  /** Their conversation is still open, so they may yet answer. */
  stillOpen: boolean;
};

export type WhatsAppApplicantFilterOption = { value: string; label: string };

export type WhatsAppApplicantFilter = {
  key: string;
  /** The question, as the applicant was asked it, or the filter's own name. */
  label: string;
  /** A line under the label. "No longer asked" for a retired question; null for most filters. */
  note: string | null;
  options: WhatsAppApplicantFilterOption[];
};

export type WhatsAppApplicantTitle = {
  value: string;
  label: string;
  /** Rows under this title. */
  count: number;
  /**
   * People who answered for this title but whose CV is not yet a candidate record, so there is no
   * row to show them in. Counted so they are named, not silently dropped.
   */
  unlinked: number;
};

export type WhatsAppApplicantsView = {
  titles: WhatsAppApplicantTitle[];
  filtersByTitle: Record<string, WhatsAppApplicantFilter[]>;
  rows: WhatsAppApplicantRow[];
};

/** The Region filter. Its value is a company region code, or one of the two below. */
export const REGION_FILTER_KEY = "region";
export const REGION_OUTSIDE_EGYPT = "foreign";
export const REGION_NOT_KNOWN = "unknown";

/** The owner's "answered all questions / didn't answer all questions". */
export const ANSWERED_FILTER_KEY = "answered";
export const ANSWERED_ALL = "all";
export const ANSWERED_NOT_ALL = "not_all";

/** A typed answer to a question that also has a tappable list, as one filter option. */
export const TYPED_ANSWER_VALUE = "__typed";

/** The page's own last segment, under /recruitment or /hr/recruitment. */
export const WHATSAPP_APPLICANTS_SEGMENT = "/whatsapp-applicants";

/**
 * The recruitment address the browser is really in, which a CV link must stay inside.
 *
 * The HR Business Partner browses under `/hr`, which proxy.ts rewrites onto this same page, so the
 * server cannot tell the two apart. A link built on the server would take them out of the HR sidebar,
 * which is the trap `screeningShellPoolHref` describes for the screening page. The browser's own path
 * is the only thing that sees the rewrite, so it is the input, and the pool is that path with this
 * page's segment removed.
 */
export function whatsAppApplicantsPoolHref(pathname: string | null | undefined): string {
  return pathname && pathname.endsWith(WHATSAPP_APPLICANTS_SEGMENT) && pathname.length > WHATSAPP_APPLICANTS_SEGMENT.length
    ? pathname.slice(0, -WHATSAPP_APPLICANTS_SEGMENT.length)
    : "/recruitment";
}

/** What the page holds as chosen: filter key -> chosen value. An empty string means "Any". */
export type WhatsAppApplicantSelections = Readonly<Record<string, string>>;

function own(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Whether a row belongs in the list for this title and these filters.
 *
 * Every chosen filter must hold. A row that never answered a question fails a filter on that
 * question: somebody searching for "25 to 30" has not asked for people whose age nobody knows.
 */
export function applicantMatches(
  row: WhatsAppApplicantRow,
  title: string,
  selections: WhatsAppApplicantSelections,
): boolean {
  if (!title || row.titleValue !== title) return false;
  for (const key of Object.keys(selections)) {
    const wanted = own(selections, key);
    if (!wanted) continue;
    if (key === ANSWERED_FILTER_KEY) {
      if (wanted === ANSWERED_ALL && !row.finished) return false;
      if (wanted === ANSWERED_NOT_ALL && row.finished) return false;
      continue;
    }
    if (own(row.values, key) !== wanted) return false;
  }
  return true;
}
