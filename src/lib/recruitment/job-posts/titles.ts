// Recruitment — a job title as the Job Posts page keeps it, and the rules a title and a post obey.
//
// PURE: no database, no Node import. The store (service.ts) and the routes call these on the way in;
// the builder screen calls the same ones to tell a person what is wrong before they press save, so
// the screen and the server can never disagree about what a valid post is.
//
// WHAT A JOB IS BELONGS TO THE TITLE (recruitment rules): the duties, the requirements and the key
// facts are saved per title and every template reads them. The areas and the line are not — they are
// choices made for one post, so they live only in the post the person is building.

import {
  JOB_POST_MAX_AREAS,
  isJobPostTemplateKey,
  type JobPostContent,
  type JobPostLine,
} from "@/lib/recruitment/job-posts/templates";

export type JobPostTitle = {
  id: string;
  title: string;
  department: string;
  headline: string | null;
  reportsTo: string | null;
  employment: string;
  location: string;
  duties: JobPostLine[];
  needs: JobPostLine[];
  menuName: string | null;
  isActive: boolean;
  updatedAt: string | null;
};

export type JobPostTitleDraft = Omit<JobPostTitle, "id" | "updatedAt">;

/** Eight lines a list is what one 1080×1350 picture holds at a readable size (the table says the same). */
export const JOB_POST_MAX_LINES = 8;
export const JOB_POST_TITLE_MAX = 80;
const LEAD_MAX = 120;
const REST_MAX = 200;
const FACT_MAX = 60;
const HEADLINE_LINE_MAX = 60;
const AREA_MAX = 60;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function textOrNull(value: unknown): string | null {
  const out = text(value);
  return out ? out : null;
}

/**
 * A list as it arrives — from the database, from a request body — made into clean lines. A row with
 * neither part filled is dropped (an empty row on the editor is not a duty); anything that is not an
 * array reads as no lines at all, never as a crash.
 */
export function coerceLines(value: unknown): JobPostLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return { lead: text(record.lead), rest: text(record.rest) };
    })
    .filter((line) => line.lead || line.rest);
}

/** A headline keeps at most two lines; blank lines are dropped. */
export function coerceHeadline(value: unknown): string | null {
  const lines = text(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  return lines.length ? lines.join("\n") : null;
}

/** A title draft from any loose object — the request body, or a row's columns already mapped. */
export function coerceTitleDraft(input: Record<string, unknown>): JobPostTitleDraft {
  return {
    title: text(input.title),
    department: text(input.department) || "Human Resources",
    headline: coerceHeadline(input.headline),
    reportsTo: textOrNull(input.reportsTo),
    employment: text(input.employment) || "Full-time",
    location: text(input.location) || "Sheraton, Cairo",
    duties: coerceLines(input.duties),
    needs: coerceLines(input.needs),
    menuName: textOrNull(input.menuName),
    isActive: input.isActive === false ? false : true,
  };
}

function lineViolations(label: string, lines: JobPostLine[]): string[] {
  const out: string[] = [];
  if (lines.length > JOB_POST_MAX_LINES) out.push(`${label} can hold at most ${JOB_POST_MAX_LINES} lines.`);
  lines.forEach((line, index) => {
    if (!line.lead) out.push(`${label} line ${index + 1} needs its bold opening.`);
    if (line.lead.length > LEAD_MAX) out.push(`${label} line ${index + 1}: the bold part is longer than ${LEAD_MAX} characters.`);
    if (line.rest.length > REST_MAX) out.push(`${label} line ${index + 1}: the rest is longer than ${REST_MAX} characters.`);
  });
  return out;
}

/** Everything wrong with a title, as sentences a person can act on. Empty means it saves. */
export function titleDraftViolations(draft: JobPostTitleDraft): string[] {
  const out: string[] = [];
  if (!draft.title) out.push("Give the job title a name.");
  if (draft.title.length > JOB_POST_TITLE_MAX) out.push(`The job title is longer than ${JOB_POST_TITLE_MAX} characters.`);
  for (const [label, value] of [
    ["Department", draft.department],
    ["Reports to", draft.reportsTo ?? ""],
    ["Employment", draft.employment],
    ["Location", draft.location],
    ["WhatsApp choice", draft.menuName ?? ""],
  ] as const) {
    if (value.length > FACT_MAX) out.push(`${label} is longer than ${FACT_MAX} characters.`);
  }
  for (const line of (draft.headline ?? "").split("\n")) {
    if (line.length > HEADLINE_LINE_MAX) out.push(`Each headline line must be ${HEADLINE_LINE_MAX} characters or fewer.`);
  }
  if (draft.needs.length === 0) out.push("Add at least one line under What you need.");
  out.push(...lineViolations("What you will do", draft.duties));
  out.push(...lineViolations("What you need", draft.needs));
  return out;
}

/** The areas a post names: trimmed, blanks and repeats dropped, in the order they were picked. */
/**
 * A post names either areas or whole regions — a district manager's post names the region he will
 * run (owner, 2026-10-16). Anything but the literal "region" reads as "area", so an older client,
 * a replayed request or a typo keeps today's wording instead of inventing a third noun.
 */
export function coerceAreaNoun(value: unknown): "area" | "region" {
  return value === "region" ? "region" : "area";
}

export function coerceAreas(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const area = text(raw);
    const key = area.toLowerCase();
    if (!area || seen.has(key)) continue;
    seen.add(key);
    out.push(area);
  }
  return out;
}

/** Everything wrong with a post about to be drawn — the title's rules plus the post's own. */
export function postRequestViolations(input: { draft: JobPostTitleDraft; areas: string[]; line: string | null; template: unknown }): string[] {
  const out = titleDraftViolations(input.draft);
  if (!isJobPostTemplateKey(input.template)) out.push("Choose one of the six templates.");
  if (input.areas.length > JOB_POST_MAX_AREAS) out.push(`A post can list at most ${JOB_POST_MAX_AREAS} areas.`);
  if (input.areas.some((area) => area.length > AREA_MAX)) out.push(`An area name is longer than ${AREA_MAX} characters.`);
  if (input.line && input.line.length > FACT_MAX) out.push(`The line name is longer than ${FACT_MAX} characters.`);
  return out;
}

/**
 * What one picture prints: the title's words plus this post's areas and line, with the apply details
 * the SERVER supplies. The WhatsApp number and the careers address never come from a request — a post
 * cannot be pointed at somebody else's number from the browser.
 */
export function contentFromDraft(
  draft: JobPostTitleDraft,
  post: { areas: string[]; line: string | null; areaNoun?: "area" | "region" },
  apply: { whatsapp: string; careers: string },
): JobPostContent {
  return {
    title: draft.title,
    department: draft.department,
    headline: draft.headline,
    reportsTo: draft.reportsTo,
    employment: draft.employment,
    location: draft.location,
    duties: draft.duties,
    needs: draft.needs,
    areas: post.areas,
    areaNoun: post.areaNoun === "region" ? "region" : "area",
    line: post.line,
    menuName: draft.menuName || draft.title,
    whatsapp: apply.whatsapp,
    careers: apply.careers,
  };
}
