// Recruitment — a job post as a satopharma.com careers card, and the check of the careers page against
// the open requisitions.
//
// PURE: no database, no network, no Node import. The Publish dialog, the publish route and the guard
// all read the same rules from here, so the screen and the server can never disagree about which apply
// form a card reaches. The network half is website.ts.

import type { JobPostTitleDraft } from "@/lib/recruitment/job-posts/titles";

export type CareersRoute = { label: string; match: RegExp; roleKey: string };

/**
 * A copy of the website's own list (`ROLE_ROUTES` in its `phoenix-counts.service.ts`), same order, first
 * match wins, so specific titles come before general ones. A card whose ENGLISH title matches none of
 * these offers an applicant email only, and the website refuses to create it (422 `NO_APPLY_ROUTE`).
 * This copy only warns early: the website's answer is the real gate, so a drift here shows up as a
 * refusal on the press, never as a card that reaches no form.
 */
export const CAREERS_ROUTES: readonly CareersRoute[] = [
  { label: "HR Section Head", match: /hr\s*section\s*head/i, roleKey: "hr_section_head" },
  { label: "Office Coordinator", match: /office\s*coordinator/i, roleKey: "office_coordinator" },
  { label: "Talent Acquisition Specialist", match: /talent\s*acquisition/i, roleKey: "talent_acquisition_specialist" },
  { label: "Personnel", match: /personnel/i, roleKey: "personnel" },
  { label: "Product Manager", match: /product\s*manager/i, roleKey: "product_manager" },
  { label: "National Sales Manager", match: /national\s*sales\s*manager/i, roleKey: "national_sales_manager" },
  { label: "District Manager", match: /district\s*manager/i, roleKey: "district_manager" },
  { label: "Medical Representative", match: /medical\s*rep(resentative)?/i, roleKey: "medical_representative" },
  { label: "Regulatory Affairs Specialist", match: /regulatory\s*affairs/i, roleKey: "regulatory_affairs_specialist" },
  { label: "Quality Control Analyst", match: /quality\s*control/i, roleKey: "quality_control_analyst" },
];

export function careersRouteForTitle(title: string): CareersRoute | null {
  return CAREERS_ROUTES.find((route) => route.match.test(title)) ?? null;
}

// The website's own limits (`integrationJobCreateSchema`), so a long field is refused here in words.
export const CARD_TITLE_MAX = 160;
export const CARD_LOCATION_MAX = 160;
export const CARD_DESCRIPTION_MAX = 5000;

/** The live cards' shape: `Medical Representative — Heliopolis`. One card names one area, or none. */
export function cardTitle(title: string, area: string | null): string {
  const base = title.trim();
  const place = area?.trim();
  return place ? `${base} — ${place}` : base;
}

/** The starting English description, in one paragraph as the live cards read. A person can change it. */
export function cardDescriptionEn(draft: Pick<JobPostTitleDraft, "duties" | "headline" | "needs">): string {
  const sentence = (lines: JobPostTitleDraft["duties"]) => lines.map((line) => [line.lead, line.rest].filter(Boolean).join(" ")).join(". ");
  const parts = [draft.headline?.replace(/\n/g, " ") ?? "", sentence(draft.duties), sentence(draft.needs)];
  return parts
    .map((part) => part.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean)
    .map((part) => `${part}.`)
    .join(" ")
    .slice(0, CARD_DESCRIPTION_MAX);
}

export type PublishCard = { descAr: string; descEn: string; location: string; titleAr: string; titleEn: string };

/** What the Publish dialog and the publish route both refuse, one sentence each. */
export function publishCardViolations(card: PublishCard): string[] {
  const out: string[] = [];
  if (!careersRouteForTitle(card.titleEn)) out.push(`“${card.titleEn}” reaches no apply form on the careers page, so it cannot be published.`);
  if (!card.titleAr.trim()) out.push("Type the job title in Arabic.");
  if (!card.descEn.trim()) out.push("Write the English description.");
  if (!card.descAr.trim()) out.push("Type the description in Arabic.");
  if (!card.location.trim()) out.push("Say where the job is.");
  if (card.titleEn.length > CARD_TITLE_MAX || card.titleAr.length > CARD_TITLE_MAX) out.push(`A title can be at most ${CARD_TITLE_MAX} characters.`);
  if (card.location.length > CARD_LOCATION_MAX) out.push(`The location can be at most ${CARD_LOCATION_MAX} characters.`);
  if (card.descEn.length > CARD_DESCRIPTION_MAX || card.descAr.length > CARD_DESCRIPTION_MAX) out.push(`A description can be at most ${CARD_DESCRIPTION_MAX} characters.`);
  return out;
}

export type OpenCareersCard = { id: string; location: string | null; slug: string; title: string };

export type CareersGuardInput = {
  /** Every open card on the live careers page. */
  cards: readonly OpenCareersCard[];
  /** The job titles of the requisitions that are hiring now, one entry per requisition. */
  requisitionTitles: readonly string[];
  /** The active job titles on the Job Posts page. */
  titles: readonly string[];
};

export type CareersGuardReport = {
  notes: string[];
  openCards: number;
  requisitions: number;
  warnings: string[];
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * The careers page against the open requisitions. It compares by ROLE, because a requisition and a card
 * rarely spell a title the same way. It only reports: nothing here closes a card.
 *
 * A WARNING is something an applicant or a hiring manager would feel. A NOTE is true and allowed: three
 * of the live cards have no requisition behind them by design.
 */
export function careersGuard(input: CareersGuardInput): CareersGuardReport {
  const warnings: string[] = [];
  const notes: string[] = [];
  const cardRoles = new Set<string>();

  for (const card of input.cards) {
    const route = careersRouteForTitle(card.title);
    if (route) cardRoles.add(route.roleKey);
    else warnings.push(`The open card “${card.title}” reaches no apply form, so applicants are offered email only.`);
  }
  for (const title of input.titles) {
    if (!careersRouteForTitle(title)) warnings.push(`The job title “${title}” reaches no apply form, so Publish will refuse it.`);
  }

  const byTitle = new Map<string, number>();
  for (const title of input.requisitionTitles) byTitle.set(title, (byTitle.get(title) ?? 0) + 1);
  const requisitionRoles = new Set<string>();
  for (const [title, count] of [...byTitle.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const route = careersRouteForTitle(title);
    const label = plural(count, "active requisition", "active requisitions");
    if (!route) {
      warnings.push(`${label} for “${title}”: the careers page has no role for this title.`);
      continue;
    }
    requisitionRoles.add(route.roleKey);
    if (!cardRoles.has(route.roleKey)) warnings.push(`${label} for “${title}” with no open card for that role.`);
  }

  for (const card of input.cards) {
    const route = careersRouteForTitle(card.title);
    if (route && !requisitionRoles.has(route.roleKey)) notes.push(`The open card “${card.title}” has no active requisition behind it.`);
  }
  for (const route of CAREERS_ROUTES) {
    if (!cardRoles.has(route.roleKey) && !requisitionRoles.has(route.roleKey)) notes.push(`${route.label} has no open card on the careers page.`);
  }

  return { notes, openCards: input.cards.length, requisitions: input.requisitionTitles.length, warnings };
}
