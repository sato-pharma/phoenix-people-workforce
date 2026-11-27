// Reading and writing the HR Forms Control tab's arrangement. The rules (which steps may sit where)
// live in `forms-layout.ts`; this is the half that talks to the database.
//
// ONE ROW PER PACKAGE (`newHire`, `leaver`), holding that package's papers in order. A save writes
// exactly the package it names, so a stale copy of the other one can never be written back over a
// change made since; "Put back the standard order" deletes the row rather than writing a sentinel.
//
// THE TABLE MAY NOT EXIST YET, AND THE READ HAS TO SURVIVE THAT — the same shape, and the same reason,
// as `company-details-store.ts`: a missing table answers `PGRST205`, not `42P01`, and the degraded
// answer is the standard order, which is what HR Forms showed before this feature. The WRITE path
// refuses instead: reporting "saved" for an arrangement that was not kept would be worse than an error.

import {
  ARRANGED_PACKAGES,
  DEFAULT_FORMS_LAYOUT,
  cleanPackageSteps,
  type ArrangedPackage,
  type FormsLayout,
} from "@/lib/hiring-pack/forms-layout";
import type { LeaverStep } from "@/lib/hiring-pack/hr-forms-wizard";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "hiring_pack_forms_layout";

function isFormsLayoutTableMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01" || code === "42703") return true;
  const message = ("message" in error ? String((error as { message?: unknown }).message ?? "") : "").toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export type StoredFormsLayout = {
  layout: FormsLayout;
  /** Which packages are arranged by hand, rather than in the standard order. */
  arranged: Record<ArrangedPackage, boolean>;
  /** False when the table is not there yet — the Control tab then says saving is not ready. */
  ready: boolean;
};

/** The arrangement HR Forms walks through right now. Never throws for a missing table. */
export async function loadFormsLayout(): Promise<StoredFormsLayout> {
  const fallback: StoredFormsLayout = {
    arranged: { leaver: false, newHire: false },
    layout: { leaver: [...DEFAULT_FORMS_LAYOUT.leaver], newHire: [...DEFAULT_FORMS_LAYOUT.newHire] },
    ready: true,
  };
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("package_key, steps");
  if (error) {
    if (isFormsLayoutTableMissing(error)) return { ...fallback, ready: false };
    throw new Error(error.message);
  }
  for (const row of (data ?? []) as { package_key?: unknown; steps?: unknown }[]) {
    const pack = row.package_key;
    if (pack !== "newHire" && pack !== "leaver") continue;
    const steps = cleanPackageSteps(row.steps, pack);
    if (!steps) continue;
    fallback.layout[pack] = steps;
    fallback.arranged[pack] = true;
  }
  return fallback;
}

/** The read, for a page: an outage shows the standard order rather than taking HR Forms down. */
export async function loadFormsLayoutOrDefault(): Promise<StoredFormsLayout> {
  try {
    return await loadFormsLayout();
  } catch {
    return {
      arranged: { leaver: false, newHire: false },
      layout: { leaver: [...DEFAULT_FORMS_LAYOUT.leaver], newHire: [...DEFAULT_FORMS_LAYOUT.newHire] },
      ready: false,
    };
  }
}

export class FormsLayoutTableMissingError extends Error {
  constructor() {
    super("The HR Forms arrangement table is not ready yet. Run the Supabase migration for hiring_pack_forms_layout.");
    this.name = "FormsLayoutTableMissingError";
  }
}

/**
 * Store one package's papers in order, or (`steps === null`) put it back to the standard order.
 * The steps must already be cleaned by `cleanPackageSteps` — the route does that.
 */
export async function saveFormsLayoutPackage(
  pack: ArrangedPackage,
  steps: readonly LeaverStep[] | null,
  actorHrId: string | null,
): Promise<StoredFormsLayout> {
  if (!ARRANGED_PACKAGES.includes(pack)) throw new Error(`Unknown HR Forms package: ${pack}`);
  const client = getSupabaseAdmin();
  const { error } =
    steps === null
      ? await client.from(TABLE).delete().eq("package_key", pack)
      : await client.from(TABLE).upsert(
          {
            package_key: pack,
            steps: [...steps],
            updated_at: new Date().toISOString(),
            // The stored form of the id, never the lowercase comparison key AccessContext holds.
            updated_by_hr_id: hrIdForStorage(actorHrId),
          },
          { onConflict: "package_key" },
        );
  if (error) {
    if (isFormsLayoutTableMissing(error)) throw new FormsLayoutTableMissingError();
    throw new Error(error.message);
  }
  return loadFormsLayout();
}
