// Recruitment / ATS — WhatsApp Applicants: what one row of the page carries, and which rows a set of
// filters keeps.
//
// The page (app/(admin)/recruitment/whatsapp-applicants/page.tsx) lists everyone who started the
// WhatsApp bot's questions. A job title is chosen first, and that title's own questions then appear as
// filters. whatsapp-applicants.ts builds every row and every filter once, on the server. This file is
// the half the browser needs, so it stays PURE and imports nothing. The client component filters on
// every change without a round trip, and a test can pin the matching rule without a database. The
// screening page uses it too: a link from this page carries the search there (see
// `whatsAppApplicantSearchParam`), and the screening queue re-runs the same match on the server.

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

/**
 * A search on this page, carried to the screening page in one link parameter.
 *
 * The owner, 2026-09-18: "based on my filters, I can go to screening page and only show those I
 * filtered." The link carries the SEARCH, never a list of names. The screening page re-runs
 * `applicantMatches` over the same rows on the server. So the link stays short however many people
 * match: 250 candidate ids would be about 9 KB of address, which together with the sign-in cookies is
 * more than a server accepts in one request. A saved link also keeps meaning "these filters" as new
 * people answer.
 *
 * One parameter, holding a query string of its own: `title=office_coordinator&region=CA&...`. The
 * screening page keeps it as an opaque string and passes it on untouched when one of its own filters
 * changes, so it needs to know nothing about the questions behind it.
 */
export type WhatsAppApplicantSearch = { title: string; selections: WhatsAppApplicantSelections };

/** The job title's own key inside the parameter. No filter is called this (see the keys above). */
const SEARCH_TITLE_KEY = "title";

export function whatsAppApplicantSearchParam(title: string, selections: WhatsAppApplicantSelections): string {
  const params = new URLSearchParams();
  params.set(SEARCH_TITLE_KEY, title);
  // Sorted, so one search always spells one link, whatever order its filters were picked in.
  for (const key of Object.keys(selections).sort()) {
    const value = own(selections, key);
    if (key !== SEARCH_TITLE_KEY && value) params.set(key, value);
  }
  return params.toString();
}

/**
 * The search back out of the parameter, or null when it names no job title.
 *
 * Untrusted, like every other part of an address. Nothing is checked against the questions here,
 * because this file cannot see them. A filter or an answer that nobody gave simply matches nobody,
 * which is what `applicantMatches` already does with it. The selections sit on a null prototype, so
 * a key spelled `__proto__` is an ordinary filter that matches nobody, never a change to every object.
 */
export function parseWhatsAppApplicantSearch(value: string | null | undefined): WhatsAppApplicantSearch | null {
  if (!value) return null;
  const params = new URLSearchParams(value);
  const title = params.get(SEARCH_TITLE_KEY)?.trim();
  if (!title) return null;
  const selections: Record<string, string> = Object.create(null);
  params.forEach((wanted, key) => {
    if (key !== SEARCH_TITLE_KEY && wanted) selections[key] = wanted;
  });
  return { selections, title };
}

/** Who a search finds, as candidate ids. The same rule the page's own list uses, so the two agree. */
export function whatsAppApplicantSearchCandidateIds(
  rows: readonly WhatsAppApplicantRow[],
  search: WhatsAppApplicantSearch,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (applicantMatches(row, search.title, search.selections)) ids.add(row.candidateId);
  }
  return ids;
}

/** A search in words, for the screening page's header. */
export type WhatsAppApplicantSearchLabel = {
  /** The job title, as the title filter names it. */
  title: string;
  /** Each chosen filter as its question and the answer picked, in the order the page lists them. */
  filters: string[];
};

/**
 * Put a search into words, using the names the WhatsApp page itself shows, never a code.
 *
 * A filter or an answer the page no longer offers is still listed, under the words it arrived in,
 * because it is still narrowing the list. Hiding it would leave a short list with no reason shown.
 */
export function whatsAppApplicantSearchLabel(
  view: Pick<WhatsAppApplicantsView, "filtersByTitle" | "titles">,
  search: WhatsAppApplicantSearch,
): WhatsAppApplicantSearchLabel {
  const title = view.titles.find((entry) => entry.value === search.title)?.label ?? "A job title nobody has applied for";
  const filters = Object.prototype.hasOwnProperty.call(view.filtersByTitle, search.title)
    ? view.filtersByTitle[search.title]
    : [];
  const phrase = (question: string, answer: string) =>
    question.trimEnd().endsWith("?") ? `${question} ${answer}` : `${question}: ${answer}`;

  const words: string[] = [];
  const named = new Set<string>();
  for (const filter of filters) {
    const wanted = own(search.selections, filter.key);
    if (!wanted) continue;
    named.add(filter.key);
    const answer = filter.options.find((option) => option.value === wanted)?.label ?? wanted;
    words.push(phrase(filter.label, answer));
  }
  for (const key of Object.keys(search.selections).sort()) {
    const wanted = own(search.selections, key);
    if (!wanted || named.has(key)) continue;
    words.push(phrase("A filter this page no longer offers", wanted));
  }
  return { filters: words, title };
}
