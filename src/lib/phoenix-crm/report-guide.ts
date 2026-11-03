/**
 * Phoenix CRM — the catalogue of its reports: what each one is called, what question it answers, and
 * which family it belongs to.
 *
 * 🔴 IT EXISTS BECAUSE FIFTEEN REPORTS IN ONE UNDIFFERENTIATED WALL OF CHIPS IS NOT A REPORT INDEX
 * (owner, 2026-10-03: *"reports not clear"*). The Reports tab offered all fifteen as equal buttons
 * with a three-word note each — "AM and PM apart", "Per brick, with the caveat" — which tells a
 * reader who already knows the report which one it is, and tells a reader who does not nothing at
 * all. So each report now carries the QUESTION it answers, in a full sentence, and the reports are
 * grouped into families so that choosing one is choosing a subject first and a report second.
 *
 * It lives in `src/lib/phoenix-crm/` and not in the tab, under the domain-first rule: the section
 * names and the families are the module's own facts and they are asserted by
 * `tests/phoenix-crm-admin-surface.test.ts`, which refuses a section with no family, no question or no
 * note — and a section the Reports tab never offers, which would be a report with no way to open it.
 * 🔴 `SECTION_TITLES` IS THE ONE PLACE A REPORT IS NAMED, SO A RENAME HERE IS ONE EDIT. The
 * workbook reads it for all three things it used to spell out by hand — the worksheet tab, the
 * heading inside the sheet, and `packSections`, which is what the COVER promises — and that drift
 * was real, not theoretical: `exceptions` read "Needs you today" here and on its own heading
 * against a tab called "Needs you". The ONE exception is the visits sheet's heading, which says
 * "per rep" because its rows are reps; it carries a comment saying so.
 * `tests/phoenix-crm-reports-export.test.ts` section 9 refuses any other name written by hand, and
 * refuses a report listed here with no sheet in the download.
 *
 * 🔴 NOTHING HERE IS A PERMISSION. Which reports a viewer may open is the server's answer
 * (`canSeeLocations`, `hasManagers`, the products audience) and every section is refused again inside
 * its own loader — a family listed here that a viewer cannot read simply draws no reports, and an
 * entry added here grants nobody anything.
 */

export type ReportSection =
  | "exceptions"
  | "visits"
  | "plan"
  | "daily"
  | "coverage"
  | "frequency"
  | "tracking"
  | "bricks"
  | "managers"
  | "locations"
  | "adoption"
  | "capacity"
  | "heard"
  | "stock"
  | "samples"
  | "objections";

/** The report's name, as its title, its chip and its sheet in the workbook all read it. */
export const SECTION_TITLES: Record<ReportSection, string> = {
  exceptions: "Needs you today",
  visits: "Visits per day",
  plan: "Plan against actual",
  daily: "Daily plan",
  coverage: "Coverage and frequency",
  frequency: "Frequency per customer",
  tracking: "Tracking sheet",
  bricks: "Coverage against sales",
  adoption: "Who has started",
  managers: "Double and chain visits",
  locations: "Where the visit was saved",
  capacity: "Grade against capacity",
  heard: "What the field heard",
  stock: "Missing stock",
  samples: "Samples by month",
  objections: "Objections by customer",
};

/**
 * The report's name as a filename slug, for a download that holds ONE report.
 *
 * 🔴 DERIVED, NOT WRITTEN, FOR THE SAME REASON THE SHEET TAB IS. The export route spelled
 * `phoenix-crm-what-the-field-heard-…` out by hand, so renaming that report reached the screen, the
 * worksheet tab, the heading inside it and the cover — and the file a product manager actually saves
 * still carried the old name. It was the one surface left that a rename could miss.
 *
 * Only `[a-z0-9-]` survives, so the result is safe in a filename on every platform — none of
 * Windows's forbidden `\ / : * ? " < > |` can reach it, whatever a title is renamed to. The leading
 * and trailing dashes are trimmed, which is the spelling the rest of this repo's exports use.
 */
export function reportFileSlug(section: ReportSection): string {
  return SECTION_TITLES[section]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The families, in the order a reader meets them: what is wrong first, then the work, then the list
 * it is done against, then the ground, then the rollout, then what came back from the field.
 */
export type ReportFamily = "attention" | "work" | "list" | "ground" | "rollout" | "heard";

export const REPORT_FAMILY_ORDER: ReadonlyArray<ReportFamily> = ["attention", "work", "list", "ground", "rollout", "heard"];

export const REPORT_FAMILY_TITLES: Record<ReportFamily, string> = {
  attention: "What needs you",
  work: "The work done",
  list: "The customer list",
  ground: "The ground it was done on",
  rollout: "The rollout",
  heard: "What came back from the field",
};

/**
 * One report: its family, and the question it answers written out for somebody who has not opened it
 * before. The sentence is what the screen prints under the report's title, so it is written as an
 * answer to "what am I looking at", never as a feature description.
 */
export type ReportEntry = {
  family: ReportFamily;
  /** The question the report answers, in one sentence. */
  answers: string;
  /** The short note on the chip — kept, because a reader who knows the report wants the short form. */
  note: string;
};

export const REPORT_GUIDE: Record<ReportSection, ReportEntry> = {
  exceptions: {
    family: "attention",
    note: "Only what is wrong",
    answers:
      "Every territory in your reach that is behind today — no plan sent, no visit, below the call rate, or a decision waiting on somebody. Nothing that is going well appears here.",
  },
  visits: {
    family: "work",
    note: "AM and PM apart",
    answers: "How many visits each territory recorded over the days you choose, with the AM list and the PM list counted apart.",
  },
  plan: {
    family: "work",
    note: "Visited or missed, day by day",
    answers: "For each day of a sent plan, which of the customers on it were actually visited and which were missed.",
  },
  daily: {
    family: "work",
    note: "Each day's customers",
    answers: "One rep's plan for the days you choose, customer by customer — who they are due to see, and who they saw.",
  },
  coverage: {
    family: "list",
    note: "The list, month by month",
    answers: "What share of a territory's customer list was seen at all in the month, and how often the ones who were seen were seen.",
  },
  frequency: {
    family: "list",
    note: "Grade and plan, apart",
    answers: "Customer by customer: the grade they carry, how often their grade says they should be seen, and how often they actually were.",
  },
  tracking: {
    family: "list",
    note: "Customer against every day",
    answers: "The month as a grid — every customer on the list against every day of it, so a gap in the middle of a month is visible as a gap.",
  },
  capacity: {
    family: "list",
    note: "The list against the month",
    answers: "Whether a rep's list can even fit into the working days of the month at the frequency their customers' grades ask for.",
  },
  bricks: {
    family: "ground",
    note: "Per brick, with the caveat",
    answers:
      "Brick by brick, within one line: where the list is being covered, and where the line sells with nobody on the list to cover it.",
  },
  locations: {
    family: "ground",
    note: "Against the saved place",
    answers: "How far each visit was saved from the place it was saved against. Never shown to the rep it is about.",
  },
  adoption: {
    family: "rollout",
    note: "How far the rollout got",
    answers: "Which territories in your reach have started working in Phoenix CRM, and which have not opened it yet.",
  },
  managers: {
    family: "rollout",
    note: "Per manager",
    answers: "How many double visits and chain visits each manager made with their reps over the days you choose.",
  },
  heard: {
    family: "heard",
    note: "Products and objections",
    answers: "Which products were talked about, and what customers objected to, as the field recorded it.",
  },
  stock: {
    family: "heard",
    note: "Pharmacies short of a product",
    answers: "The pharmacies a rep found short of a product, so the gap is a list somebody can act on rather than a note in one visit.",
  },
  samples: {
    family: "heard",
    note: "What was left, month by month",
    answers: "What was left with customers — samples and materials — month by month.",
  },
  objections: {
    family: "heard",
    note: "Each rep's customers, counts only",
    answers: "Each rep's customers and what they objected to, with the product, the day and the rep's note. The objection is the customer's: counts only, and it never scores a rep.",
  },
};

/**
 * `managers` read by a PRODUCT or MARKETING manager, about HIMSELF (owner, 2026-10-07: the visits
 * Nada Abdullah filed with Ahmed SharafEldeen "are not appearing in his data"). That report's own
 * sentence says "each manager", because its rows are the managers above a team; his row is his own
 * and there is no team on it, so the sentence would be false of what he is looking at. One section,
 * two readers, two questions — and still ONE place either of them is written.
 *
 * Shown on every surface, not the admin one alone: the whole reason he opens it is that he could not
 * tell where the visits he rode had gone.
 */
export const OWN_RIDE_ALONGS_ANSWER =
  "Every double and chain visit you were on, day by day — which rep, which territory, and how many AM and PM visits you made together.";

/** The question a report answers, for the line under its title. */
export function reportAnswers(section: ReportSection): string {
  return REPORT_GUIDE[section].answers;
}

/**
 * The offered sections regrouped into families, families in `REPORT_FAMILY_ORDER` and the reports
 * inside each in the order they were offered. A family no section was offered for is left out
 * entirely, so a viewer never reads a heading with nothing under it.
 */
export function groupReportSections<T extends { value: ReportSection }>(
  offered: ReadonlyArray<T>,
): Array<{ family: ReportFamily; title: string; sections: T[] }> {
  return REPORT_FAMILY_ORDER.map((family) => ({
    family,
    title: REPORT_FAMILY_TITLES[family],
    sections: offered.filter((entry) => REPORT_GUIDE[entry.value].family === family),
  })).filter((group) => group.sections.length > 0);
}
