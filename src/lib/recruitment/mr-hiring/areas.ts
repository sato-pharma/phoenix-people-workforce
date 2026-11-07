// Recruitment / Medical Rep hiring — the areas HR may confirm at the 1st interview's result.
//
// THE BOT'S OWN LIST. The owner, 7 Nov 2026: "make the HR able to confirm the location … the candidate
// is applying to, and the line". The area is chosen, never typed: it is one of the active canonical
// areas the WhatsApp bot offers, grouped under its recruitment region and named exactly as the bot
// named it — the list the workspace's Medical Rep tab is split by (`loadWorkspacePlaces`, cached five
// minutes). So a confirmed area is always a name the rest of Phoenix files candidates under.
//
// SERVER ONLY for the read; `mrAreaChoicesFrom` and `isKnownMrArea` are pure and tested.

import { loadWorkspacePlaces } from "@/lib/recruitment/workspace/places";
import type { WorkspacePlaces } from "@/lib/recruitment/workspace/types";
import type { MrAreaChoice } from "@/lib/recruitment/mr-hiring/vocabulary";

/** The Medical Rep places as region → area names, in the bot's own order; empty regions left out. */
export function mrAreaChoicesFrom(places: WorkspacePlaces): MrAreaChoice[] {
  return places.regions
    .map((region) => ({ areas: region.areas.map((area) => area.name).filter(Boolean), region: region.name }))
    .filter((choice) => choice.areas.length > 0);
}

/** Whether a name is one of the areas offered, compared as the bot spells it (spaces folded). */
export function isKnownMrArea(choices: readonly MrAreaChoice[], name: string): boolean {
  const wanted = name.replace(/\s+/g, " ").trim();
  if (!wanted) return false;
  return choices.some((choice) => choice.areas.some((area) => area.replace(/\s+/g, " ").trim() === wanted));
}

export async function loadMrAreaChoices(): Promise<MrAreaChoice[]> {
  return mrAreaChoicesFrom(await loadWorkspacePlaces("medical_rep"));
}
