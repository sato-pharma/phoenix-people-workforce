// Recruitment / ATS — owner-editable wording for the SIX BUILT-IN WhatsApp screening questions,
// and for the ANSWERS an applicant taps to reply to them.
//
// The builder in whatsapp-screening-questions.ts owns brand-new questions, asked AFTER the fixed
// six. This file owns the fixed six themselves. The two are deliberately separate stores: putting
// the six into the extra-question table would have asked every applicant all six a second time.
//
// ── THE ONE BOUNDARY THIS FEATURE RESTS ON ──────────────────────────────────────────────────────
//
//   EDITABLE:     every word the applicant reads — the prompt, and each answer's title and second
//                 line. WHICH answers are offered, and in what order.
//   NOT EDITABLE: the CODE underneath an answer. A row's id is `phx:<step>:<value>`, and `<value>`
//                 is a candidateRoleFamily / candidateRegionCode / background / experience code that
//                 the CV pool filters, candidate folders, manager routing and the organogram all
//                 read. Relabelling rewrites the display; the value the tap sends back is
//                 byte-identical, so every downstream reader sees exactly what it saw before.
//
// `applyOptionLabels` therefore rewrites `title` and `description` only, keyed BY value, and never
// constructs a row id. whatsapp-question-prompts.test.ts pins that the ids survive relabelling
// unchanged — that assertion is the guard, not this comment.
//
// ── ADDING AND DELETING AN ANSWER ───────────────────────────────────────────────────────────────
//
// Deleting is HIDING (`hiddenOptions`), never removing the code. An applicant who tapped an answer
// before it was hidden still reads back correctly everywhere, and putting it back is one click.
//
// Adding is switching on an answer the code ALREADY understands (`optionOrder`). Every question's
// full vocabulary lives in code; some of it is deliberately not offered — the owner named the
// job-title list himself on 2026-08-28 and left `sales` and `pharmacist` off it. An answer with no
// code behind it cannot be added at all, and that is the safety property, not a limitation: the
// reply handler would reject the tap and the applicant's answer would vanish in silence. To ask
// something genuinely new, the extra-question builder on the same screen is the tool.
//
// This module is PURE — no I/O — so the catalogue and the validators can be imported by the admin
// client component for live feedback, and asserted in a test without a database.

import {
  areaMenu,
  backgroundMenu,
  experienceMenu,
  jobTitleMenu,
  jobTitleMenuAllFamilies,
  OTHER_ROW_VALUE,
  parseClassifyRowId,
  regionMenu,
  salaryPromptText,
  WHATSAPP_BODY_MAX,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_DESCRIPTION_MAX,
  WHATSAPP_ROW_TITLE_MAX,
  type ClassifyMenu,
  type ClassifyRow,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";

/** The six steps whose wording an admin may edit. Same spelling as the session's `step` column and
 *  as the migration's CHECK constraint — one vocabulary, three places, no translation layer. */
export const builtInPromptKeys = [
  "job_title",
  "background",
  "region",
  "area",
  "experience",
  "salary",
] as const;

export type BuiltInPromptKey = (typeof builtInPromptKeys)[number];

/**
 * The token an `area` prompt may carry, replaced at send time with the region the applicant just
 * chose. The default wording uses it; an admin who deletes it simply gets a prompt that does not
 * name the region back, which is their call to make.
 */
export const REGION_TOKEN = "{region}";

/**
 * The area prompt's default, as a template. Every other default is read from the menu builder itself
 * so the two can never drift; this one cannot be, because `areaMenu` interpolates a real region name
 * rather than a token. `whatsapp-question-prompts.test.ts` pins the two forms against each other, so
 * a later edit to the menu builder's wording that forgets this line goes red.
 */
export const AREA_PROMPT_DEFAULT = `Which area inside ${REGION_TOKEN}?`;

/** One answer's display text, as saved. Either field absent means "keep the code's own". */
export type OptionLabel = { title?: string; description?: string };

/** Everything saved for one question. `body` null means the prompt keeps its code default. */
export type PromptOverride = {
  body: string | null;
  optionLabels: Record<string, OptionLabel>;
  /**
   * Values NOT to offer — the "delete an answer" gesture. Hiding rather than removing, so an
   * applicant who already tapped one still reads back correctly everywhere.
   */
  hiddenOptions: string[];
  /**
   * The order to show answers in. Empty means the code's own order.
   *
   * It carries the "add an answer" gesture too: a value the code understands but does not offer by
   * default appears only when it is listed here. Two jobs in one field is deliberate — the
   * alternative is a third list that has to be kept consistent with this one, and a disagreement
   * between them would be unresolvable. Any offered value NOT listed keeps its code order after the
   * ones that are, so a partial array written by a stale client can never silently drop an answer.
   */
  optionOrder: string[];
};

export type PromptOverrides = ReadonlyMap<string, PromptOverride>;

/** One tappable answer as the admin sees it on the screen. */
export type BuiltInPromptOption = {
  /** The code the tap sends back. Shown to the admin, never editable. */
  value: string;
  /** The title the applicant reads today, from the code. */
  defaultTitle: string;
  /** The second line the applicant reads today, if the code sets one. */
  defaultDescription?: string;
  /**
   * False for an answer the code understands but the menu does not currently offer — the owner named
   * the job-title list himself on 2026-08-28 and left `sales` and `pharmacist` off it. Showing one is
   * what "adding an answer" means here, and it is safe precisely because the reply handler already
   * accepts the value. An answer with no code behind it could not be added at all: the handler would
   * reject the tap and the applicant's answer would be dropped in silence.
   */
  offeredByDefault: boolean;
};

export type BuiltInPrompt = {
  key: BuiltInPromptKey;
  /** What the ADMIN sees as the question's name on the screen. Never shown to an applicant. */
  label: string;
  /** One line telling the admin what this question does and what it must keep asking for. */
  note: string;
  /** The wording used when nobody has overridden it — read from the code itself, not re-typed. */
  defaultBody: string;
  /** True for the one prompt that carries {region}. */
  supportsRegionToken: boolean;
  /** The tappable answers, in the order the applicant sees them. Empty for a free-text question. */
  options: BuiltInPromptOption[];
  /** How the applicant answers, and anything the admin needs to know about editing these answers. */
  optionsNote: string;
};

/**
 * The catalogue, in the order an applicant meets the questions.
 *
 * `defaultBody` and `options` call the real menu builders rather than repeating their strings. That
 * is the whole point: a future reword in whatsapp-classify-menus.ts shows up on this screen
 * automatically, "reset to default" can never restore text that has since been improved elsewhere,
 * and an answer added or removed in code appears or disappears here with no edit to this file.
 */
export function builtInPrompts(): BuiltInPrompt[] {
  return [
    {
      defaultBody: jobTitleMenu().body,
      key: "job_title",
      label: "1 · What are you applying for?",
      note: "Routes the CV to the right manager. Keep it clear that you are asking for a job title.",
      // The only question with answers the system understands but does not offer. `jobTitleMenu()`
      // is the owner's eight; `jobTitleMenuAllFamilies()` adds the two he left off, marked below as
      // not offered so the screen can present them as answers to switch on.
      options: optionsFromMenu(jobTitleMenuAllFamilies(), jobTitleMenu()),
      optionsNote: "They tap one of these. The last one lets them type a job we do not list.",
      supportsRegionToken: false,
    },
    {
      defaultBody: backgroundMenu().body,
      key: "background",
      label: "2 · What did you graduate in?",
      note: "Decides the Paramedical split — anything that is not Pharmacy, Science or Veterinary.",
      options: optionsFromMenu(backgroundMenu()),
      optionsNote: "They tap one of these. Anything answered as Other is treated as Paramedical.",
      supportsRegionToken: false,
    },
    {
      defaultBody: regionMenu().body,
      key: "region",
      label: "3 · Which region?",
      note: "The company's own regions, not geography. Feeds vacancy matching.",
      options: optionsFromMenu(regionMenu()),
      optionsNote: "They tap one of these. These are the company's own regions, not a map of Egypt.",
      supportsRegionToken: false,
    },
    {
      defaultBody: AREA_PROMPT_DEFAULT,
      key: "area",
      label: "4 · Which area?",
      note: `Asked to Medical Representatives only. Use ${REGION_TOKEN} where the region name should appear.`,
      // areaMenu builds its rows from the live areas of whichever region was chosen, so the only row
      // that exists for every applicant — and the only one there is any point relabelling — is the
      // escape. Passing no area names is what leaves exactly that row.
      options: optionsFromMenu(areaMenu("CA", [])),
      optionsNote:
        "The areas themselves come from your live area list and change with the region, so they are not edited here. Only the escape answer below is.",
      supportsRegionToken: true,
    },
    {
      defaultBody: experienceMenu().body,
      key: "experience",
      label: "5 · How much experience?",
      note: "The five bands cover everyone, so there is no Other to type.",
      options: optionsFromMenu(experienceMenu()),
      optionsNote: "They tap one of these five. The bands cover everyone, so there is no Other.",
      supportsRegionToken: false,
    },
    {
      defaultBody: salaryPromptText(),
      key: "salary",
      label: "6 · Expected salary",
      note: "The last question, and the highest-friction one. Free text, stored exactly as written.",
      options: [],
      optionsNote: "Nothing to tap — they type a figure, a range, or a word like negotiable.",
      supportsRegionToken: false,
    },
  ];
}

/** A row's answer code. Recovered from the id, never re-derived, so it is literally what a tap sends. */
function rowValue(row: ClassifyRow): string {
  return parseClassifyRowId(row.id)?.value ?? row.id;
}

/**
 * The admin-facing view of a menu's rows. The VALUE is recovered from the row id rather than being
 * re-derived, so what the screen labels as "the code" is literally the code the applicant's tap
 * sends back — the two cannot drift.
 *
 * `pool` is every answer the question COULD offer; `offered` is the menu the bot actually sends
 * today. Passing only one means the two are the same, which is true of every question but job title.
 */
function optionsFromMenu(pool: ClassifyMenu, offered: ClassifyMenu = pool): BuiltInPromptOption[] {
  const offeredValues = new Set(offered.rows.map(rowValue));
  return pool.rows.map((row) => {
    const value = rowValue(row);
    return {
      defaultDescription: row.description,
      defaultTitle: row.title,
      offeredByDefault: offeredValues.has(value),
      value,
    };
  });
}

/**
 * Every answer a question could offer, as real menu rows — the pool `applyAnswerConfig` draws from.
 *
 * Only job title has anything beyond its own menu. The area question is the opposite case: its rows
 * are the live areas of whichever region the applicant chose, so the pool IS whatever was built for
 * that applicant, plus the escape row.
 */
function answerPool(step: BuiltInPromptKey, menu: ClassifyMenu): readonly ClassifyRow[] {
  return step === "job_title" ? jobTitleMenuAllFamilies().rows : menu.rows;
}

/** True for a key this table is allowed to hold. Guards a stale or hand-written key on the way in. */
export function isBuiltInPromptKey(value: string): value is BuiltInPromptKey {
  return (builtInPromptKeys as readonly string[]).includes(value);
}

/** The empty override — what every question starts on, and what a failed read falls back to. */
export function emptyPromptOverride(): PromptOverride {
  return { body: null, hiddenOptions: [], optionLabels: {}, optionOrder: [] };
}

/**
 * Everything wrong with a proposed prompt, as sentences an admin can read. Empty means saveable.
 *
 * Runs at save time AND is re-run by the client for live feedback. The body ceiling is Meta's own:
 * an over-long body is a 400 for the whole message, so it would not truncate — it would stop the
 * conversation dead for that applicant.
 */
export function promptViolations(input: { key: string; bodyText: string }): string[] {
  const problems: string[] = [];
  if (!isBuiltInPromptKey(input.key)) {
    problems.push(`"${input.key}" is not one of the six built-in questions.`);
  }
  const body = input.bodyText.trim();
  if (!body) {
    problems.push("The question cannot be empty — delete your changes to go back to the default wording.");
  }
  if (body.length > WHATSAPP_BODY_MAX) {
    problems.push(`The question is ${body.length} characters — WhatsApp allows ${WHATSAPP_BODY_MAX}.`);
  }
  return problems;
}

/**
 * Everything wrong with a proposed set of answer labels. Empty means saveable.
 *
 * The two ceilings are Meta's, and they are the reason this is checked at all: a list message whose
 * row title runs past 24 characters is a 400 for the WHOLE message, not a truncated row — so an
 * over-long answer would not look untidy, it would stop the conversation dead. Checked at save time
 * and again at send time, where `menuViolations` re-runs the identical limits on the built menu.
 */
export function optionLabelViolations(input: {
  key: string;
  optionLabels: Record<string, OptionLabel>;
  allowedValues: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (!isBuiltInPromptKey(input.key)) {
    problems.push(`"${input.key}" is not one of the six built-in questions.`);
  }
  for (const [value, label] of Object.entries(input.optionLabels ?? {})) {
    // A label for an answer this question does not offer would sit in the table overriding nothing,
    // which on screen is indistinguishable from a saved edit that does not work.
    if (!input.allowedValues.includes(value)) {
      problems.push(`"${value}" is not one of this question's answers.`);
      continue;
    }
    const title = (label?.title ?? "").trim();
    const description = (label?.description ?? "").trim();
    if (title.length > WHATSAPP_ROW_TITLE_MAX) {
      problems.push(
        `"${title.slice(0, 20)}" is ${title.length} characters — WhatsApp allows ${WHATSAPP_ROW_TITLE_MAX} for an answer.`,
      );
    }
    if (description.length > WHATSAPP_ROW_DESCRIPTION_MAX) {
      problems.push(
        `The second line under "${title || value}" is ${description.length} characters — WhatsApp allows ${WHATSAPP_ROW_DESCRIPTION_MAX}.`,
      );
    }
  }
  return problems;
}

/**
 * Everything wrong with a proposed set of hidden/ordered answers. Empty means saveable.
 *
 * The count check is the one that matters. Meta caps a list at 10 rows and refuses the WHOLE message
 * over it, and a menu with nothing to tap is not a question at all — either would strand a real
 * applicant mid-conversation with a generic failure. `applyAnswerConfig` falls back to the code menu
 * rather than sending one, but a save that could only ever fall back is a save that silently does
 * nothing, so it is refused here instead.
 */
export function answerConfigViolations(input: {
  key: string;
  hiddenOptions: readonly string[];
  optionOrder: readonly string[];
  /** Every answer this question could offer. */
  allowedValues: readonly string[];
  /** The subset offered when nobody has configured anything. */
  defaultOfferedValues: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (!isBuiltInPromptKey(input.key)) {
    problems.push(`"${input.key}" is not one of the six built-in questions.`);
  }

  for (const value of [...input.hiddenOptions, ...input.optionOrder]) {
    if (!input.allowedValues.includes(value)) {
      problems.push(`"${value}" is not an answer this question can offer.`);
    }
  }
  for (const value of input.hiddenOptions) {
    if (input.optionOrder.includes(value)) {
      problems.push(`"${value}" is both switched off and placed in the order — it can only be one.`);
    }
  }

  const offered = offeredValues({
    defaultOffered: input.defaultOfferedValues,
    hidden: input.hiddenOptions,
    order: input.optionOrder,
    pool: input.allowedValues,
  });
  if (offered.length === 0) {
    problems.push("Every answer is switched off — leave at least one for them to tap.");
  }
  if (offered.length > WHATSAPP_LIST_MAX_ROWS) {
    problems.push(
      `That is ${offered.length} answers — WhatsApp allows ${WHATSAPP_LIST_MAX_ROWS} in one list.`,
    );
  }
  return problems;
}

/**
 * Which answers a configuration actually offers, in order. The one place the rule lives, so the
 * save-time check and the send-time build can never disagree about it.
 *
 * An answer offered by default shows unless it is hidden. An answer the code understands but does
 * not offer shows only when the order names it — which is what makes a value added to the code
 * later appear or not appear on its own terms, rather than leaking onto a menu because an old saved
 * row happened not to mention it.
 */
function offeredValues(input: {
  pool: readonly string[];
  defaultOffered: readonly string[];
  hidden: readonly string[];
  order: readonly string[];
}): string[] {
  const hidden = new Set(input.hidden);
  const order = new Set(input.order);
  const shows = (value: string) =>
    !hidden.has(value) && (input.defaultOffered.includes(value) || order.has(value));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of input.order) {
    if (seen.has(value) || !input.pool.includes(value) || !shows(value)) continue;
    seen.add(value);
    out.push(value);
  }
  for (const value of input.pool) {
    if (seen.has(value) || !shows(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * A menu's rows with the admin's hidden/added/reordered answers applied.
 *
 * Rows are MOVED, never rebuilt — every row handed back is an object that came out of a real menu
 * builder, so its `phx:<step>:<value>` id is byte-identical to the one the code would have sent.
 * That is the same guarantee `applyOptionLabels` gives, for the same reason.
 *
 * FAILS SAFE TO THE CODE'S OWN MENU. A configuration that would leave nothing to tap, or more rows
 * than Meta accepts, is discarded here rather than sent: an over-long list is a 400 for the whole
 * message, so honouring such a config would stop that applicant's conversation dead. Saving one is
 * refused by `answerConfigViolations`; this is the second line, for a row written before a code
 * change moved the ground under it.
 */
export function applyAnswerConfig(input: {
  rows: readonly ClassifyRow[];
  /** Every answer this question could offer, as rows. Superset of `rows`. */
  pool: readonly ClassifyRow[];
  hiddenOptions: readonly string[];
  optionOrder: readonly string[];
}): readonly ClassifyRow[] {
  if (input.hiddenOptions.length === 0 && input.optionOrder.length === 0) return input.rows;

  const byValue = new Map<string, ClassifyRow>();
  for (const row of input.pool) byValue.set(rowValue(row), row);
  // `rows` wins on a collision: for the area question the live rows ARE the pool, and for job title
  // the two agree. This only matters if a future menu builder ever hands back a row the pool build
  // shaped differently — the one the applicant would really have seen is the right one to keep.
  for (const row of input.rows) byValue.set(rowValue(row), row);

  const wanted = offeredValues({
    defaultOffered: input.rows.map(rowValue),
    hidden: input.hiddenOptions,
    order: input.optionOrder,
    pool: [...byValue.keys()],
  });

  if (wanted.length === 0 || wanted.length > WHATSAPP_LIST_MAX_ROWS) return input.rows;

  const next = wanted.map((value) => byValue.get(value)!);
  const unchanged =
    next.length === input.rows.length && next.every((row, index) => row === input.rows[index]);
  return unchanged ? input.rows : next;
}

/**
 * The wording actually sent, given whatever the admin has saved. An absent or blank override falls
 * back to the code default, so a half-finished edit can never send an empty question.
 */
export function resolvePromptBody(input: {
  key: BuiltInPromptKey;
  overrides: PromptOverrides;
  defaultBody: string;
  regionLabel?: string | null;
}): string {
  const saved = input.overrides.get(input.key)?.body?.trim();
  const body = saved && saved.length > 0 ? saved : input.defaultBody;
  if (!input.regionLabel) return body;
  return body.split(REGION_TOKEN).join(input.regionLabel);
}

/**
 * A menu's rows with the admin's answer labels applied.
 *
 * THE ROW ID IS NEVER REBUILT — it is carried across verbatim from the row this came from. That is
 * what makes relabelling safe: the applicant sees new words, and the tap still sends back the same
 * `phx:<step>:<value>` every downstream reader already understands. Returns the SAME array when
 * nothing applies.
 */
export function applyOptionLabels(
  rows: readonly ClassifyRow[],
  optionLabels: Record<string, OptionLabel> | undefined,
): readonly ClassifyRow[] {
  if (!optionLabels || Object.keys(optionLabels).length === 0) return rows;

  let changed = false;
  const next = rows.map((row) => {
    const value = parseClassifyRowId(row.id)?.value;
    const label = value ? optionLabels[value] : undefined;
    if (!label) return row;

    const title = label.title?.trim();
    const description = label.description?.trim();
    // A blank saved value is treated as "no override" rather than as an empty row: a half-finished
    // edit must never send an answer with no words on it.
    const nextTitle = title && title.length > 0 ? title : row.title;
    const nextDescription = description && description.length > 0 ? description : row.description;
    if (nextTitle === row.title && nextDescription === row.description) return row;

    changed = true;
    // `id` first and unconditional, so no future edit here can accidentally omit it.
    return nextDescription === undefined
      ? { id: row.id, title: nextTitle }
      : { description: nextDescription, id: row.id, title: nextTitle };
  });

  return changed ? next : rows;
}

/**
 * A menu with the admin's wording, answer labels, and hidden/added/reordered answers applied.
 * Returns the SAME object when nothing is overridden, so the untouched path is exactly the code path
 * that shipped before this feature.
 *
 * Which answers to show is settled BEFORE relabelling, so a label saved for an answer that is now
 * hidden simply does not apply, rather than having to be cleaned up when the answer is switched off.
 *
 * `regionLabel` is passed only for the area question, which is the one prompt carrying a token.
 */
export function applyPromptOverride(
  menu: ClassifyMenu,
  overrides: PromptOverrides,
  regionLabel?: string | null,
): ClassifyMenu {
  if (!isBuiltInPromptKey(menu.step)) return menu;
  const saved = overrides.get(menu.step);
  const body = resolvePromptBody({
    defaultBody: menu.body,
    key: menu.step,
    overrides,
    regionLabel,
  });
  const offered = applyAnswerConfig({
    hiddenOptions: saved?.hiddenOptions ?? [],
    optionOrder: saved?.optionOrder ?? [],
    pool: answerPool(menu.step, menu),
    rows: menu.rows,
  });
  const rows = applyOptionLabels(offered, saved?.optionLabels);
  if (body === menu.body && rows === menu.rows) return menu;
  return { ...menu, body, rows: rows as ClassifyRow[] };
}

/** The escape answer's value, re-exported so the admin screen need not import the menus module. */
export { OTHER_ROW_VALUE };
