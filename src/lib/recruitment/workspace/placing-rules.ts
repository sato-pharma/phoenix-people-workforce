// Recruitment workspace — the rules of the "Place this candidate" form (owner, 20 Oct 2026: in Needs
// placing, pick Applying for from a list, then the Region, then the Area — only that region's — and
// answer most of the WhatsApp questions by hand, so the candidate is placed exactly from his entries).
//
// PURE and safe in the browser: the form and the route read the same rules, so the screen never
// offers a choice the server then refuses.
//
// THE ROLE LIST IS THE BOT'S OWN MENU (`offeredRoleMenuFamilies`), with the bot's labels — never a
// list of tabs — minus any role whose tab this viewer does not file into. That one filter is the
// Talent Acquisition fence: her seat sees neither HR tab, so HR Section Head and Talent Acquisition
// are not offered to her. The retired Human Resources tap is not on the menu and files nowhere.

import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { offeredRoleMenuFamilies } from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import { questionIsVisible, type ScreeningQuestionShowIf } from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import { roleTabForFamily, tabsWithAreas, tabsWithRegions, type WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";

/** One question on the form. `options` empty = a typed answer. The stored answer is the option's TITLE. */
export type PlacingQuestion = {
  /** The chip key: `background`, `experience`, `salary`, or an admin question's key. */
  key: string;
  label: string;
  options: { value: string; title: string }[];
  showIf: ScreeningQuestionShowIf | null;
};

/** What the form sends. `answers` holds only what HR changed; null clears an answer. */
export type PlacingInput = {
  roleFamily: string | null;
  regionCode: string | null;
  areaCode: string | null;
  answers: Record<string, string | null>;
};

/** The built-in answers the form asks, by their chip key. Role, region and area are its own three fields. */
export const PLACING_BUILT_IN_KEYS = ["background", "experience", "salary"] as const;

/** More answers than any role is asked — a body past this is not the form. */
export const PLACING_MAX_ANSWERS = 60;

/** The roles this viewer may place someone as, in the bot's own menu order. */
export function placingRoleFamilies(roleTabs: readonly WorkspaceRoleTab[]): CandidateRoleFamily[] {
  return offeredRoleMenuFamilies.filter((family) => {
    const tab = roleTabForFamily(family);
    return tab !== null && roleTabs.includes(tab);
  });
}

export function placingRoleLabel(family: string): string {
  return (candidateRoleFamilyLabels as Record<string, string | undefined>)[family] ?? family;
}

/** The tab a chosen role files into, and whether that tab asks for a region and an area. */
export function placingShape(roleFamily: string | null): { tab: WorkspaceRoleTab | null; region: boolean; area: boolean } {
  const tab = roleTabForFamily(roleFamily);
  return { area: tab !== null && tabsWithAreas.includes(tab), region: tab !== null && tabsWithRegions.includes(tab), tab };
}

/**
 * The questions to draw, given what is answered so far: a follow-up appears only when the answer it
 * follows says so — the bot's own `questionIsVisible`, so the form asks exactly what the bot would.
 */
export function visiblePlacingQuestions(
  questions: readonly PlacingQuestion[],
  answers: Readonly<Record<string, string | null | undefined>>,
): PlacingQuestion[] {
  const given: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === "string" && value.trim()) given[key] = value.trim();
  }
  const controlling = questions.map((question) => ({
    options: question.options.map((option) => ({ description: null, title: option.title, value: option.value })),
    questionKey: question.key,
  }));
  return questions.filter((question) => questionIsVisible(question, given, controlling));
}

/**
 * Why this placing cannot be saved, or null. The checks that need no database: a role is chosen, it is
 * one this viewer may file, a region or area only where the tab has them, and the answers are a plain
 * map of text. That the area sits in the region is the server's, against the AU directory.
 */
export function placingRefusal(input: PlacingInput, roleTabs: readonly WorkspaceRoleTab[]): string | null {
  const family = input.roleFamily?.trim() || null;
  if (!family) return "Choose what they are applying for.";
  if (!(offeredRoleMenuFamilies as readonly string[]).includes(family)) return "Choose one of the roles on the list.";
  const shape = placingShape(family);
  if (!shape.tab) return "That role files in no tab. Choose another.";
  if (!roleTabs.includes(shape.tab)) return "You cannot file a CV in that tab.";
  if (input.regionCode && !shape.region) return "This role is not split by region.";
  if (input.areaCode && !shape.area) return "Only a Medical Rep is filed under an area.";
  if (input.areaCode && !input.regionCode) return "Choose the region before the area.";
  const entries = Object.entries(input.answers ?? {});
  if (entries.length > PLACING_MAX_ANSWERS) return "That is more answers than this form asks.";
  for (const [key, value] of entries) {
    if (!key || (value !== null && typeof value !== "string")) return "An answer is text.";
  }
  return null;
}
