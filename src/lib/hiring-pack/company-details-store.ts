// Reading and writing the company record. The shapes and the merge live in `company-details.ts`;
// this is the half that talks to the database.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TABLE MAY NOT EXIST YET, AND EVERY READ HERE HAS TO SURVIVE THAT — the same shape as
// `field-layout-store.ts` and `custom-template-store.ts`, and for the same reason.
//
// `hiring_pack_company_details` arrives in a migration, and applying one to production is a
// protected action only the owner approves. So there is a window — possibly a long one — in which
// this code is deployed and the table is not. An HR Forms screen that 500s because nobody has run a
// migration yet would take out printing for everybody, over a feature nobody is using.
//
// A MISSING TABLE ANSWERS `PGRST205`, NOT `42P01`: PostgREST resolves through its schema cache and
// reports a cache miss, so the obvious guard fires never. Both codes are treated as one set, the
// CODE is checked as well as the message (a PostgREST error is a plain object, not an `Error`, so a
// message-only test reads it as empty and returns false — the same as having no guard at all), and
// `42703` is in the set too, for the deploy window in which the table exists and a later column
// does not.
//
// The degraded answer is NO OVERRIDES, which is exactly right: every paper then prints the compiled
// company from `system-settings.ts`, which is what it printed before this feature existed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE ROW PER VALUE, NOT ONE ROW PER COMPANY.
//
// A single wide row would have to be written whole on every save, which is the "optional field
// written unconditionally is a silent erase" trap this repository has already paid for: one edit
// carrying a stale copy of eighteen other values would quietly restore them. A key/value row means a
// save touches exactly the value that was typed, and RESET is expressible as deleting a row rather
// than as writing a sentinel nothing can tell apart from a deliberate blank.
//
// AN UNKNOWN KEY IS DROPPED ON READ rather than trusted. Rows outlive code: a key retired from
// `COMPANY_DETAIL_FIELDS` leaves its row behind, and `resolveCompanyDetails` would ignore it anyway
// — filtering here means the count this function reports is the count that actually prints.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  isCompanyDetailKey,
  resolveCompanyDetails,
  type CompanyDetailKey,
  type CompanyDetails,
} from "@/lib/hiring-pack/company-details";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "hiring_pack_company_details";

/** The ways this table can be absent, as one question. See the header. */
export function isCompanyDetailsLayerMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01" || code === "42703") {
    return true;
  }
  const message = (
    "message" in error ? String((error as { message?: unknown }).message ?? "") : ""
  ).toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export type CompanyDetailOverride = {
  key: CompanyDetailKey;
  value: string;
  updatedAt: string | null;
  updatedByHrId: string | null;
};

/**
 * Every stored override, keyed. Absent table, empty table and "everything reset" all answer `{}`,
 * which is the same instruction to the resolver: print the compiled default.
 */
export async function loadCompanyDetailOverrides(): Promise<
  Partial<Record<CompanyDetailKey, string>>
> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("detail_key, detail_value");

  if (error) {
    if (isCompanyDetailsLayerMissing(error)) return {};
    throw new Error(error.message);
  }

  const overrides: Partial<Record<CompanyDetailKey, string>> = {};
  for (const row of data ?? []) {
    const key = (row as { detail_key?: unknown }).detail_key;
    if (!isCompanyDetailKey(key)) continue;
    const value = (row as { detail_value?: unknown }).detail_value;
    // An empty string is a deliberate blank and must survive; only a NULL column is "no answer",
    // and the column is `not null` so that cannot normally happen.
    overrides[key] = typeof value === "string" ? value : "";
  }
  return overrides;
}

/** The company as the papers will print it right now. The one function the renderers depend on. */
export async function loadCompanyDetails(): Promise<CompanyDetails> {
  return resolveCompanyDetails(await loadCompanyDetailOverrides());
}

/**
 * The same answer, plus who changed what and when — for the screen that lists the values.
 *
 * Separate from `loadCompanyDetails` because the renderers must never carry audit columns into a
 * token map, and because this one is allowed to be slower: it is read by one admin panel, not by
 * every print.
 */
export async function listCompanyDetailOverrides(): Promise<CompanyDetailOverride[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("detail_key, detail_value, updated_at, updated_by_hr_id")
    .order("detail_key", { ascending: true });

  if (error) {
    if (isCompanyDetailsLayerMissing(error)) return [];
    throw new Error(error.message);
  }

  const rows: CompanyDetailOverride[] = [];
  for (const row of data ?? []) {
    const record = row as {
      detail_key?: unknown;
      detail_value?: unknown;
      updated_at?: unknown;
      updated_by_hr_id?: unknown;
    };
    if (!isCompanyDetailKey(record.detail_key)) continue;
    rows.push({
      key: record.detail_key,
      value: typeof record.detail_value === "string" ? record.detail_value : "",
      updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
      updatedByHrId:
        typeof record.updated_by_hr_id === "string" ? record.updated_by_hr_id : null,
    });
  }
  return rows;
}

/** Raised when the table is not there yet, so the route can say which migration is missing. */
export class CompanyDetailsLayerMissingError extends Error {
  constructor() {
    super(
      "The company-details table is not ready yet. Run the Supabase migration for hiring_pack_company_details.",
    );
    this.name = "CompanyDetailsLayerMissingError";
  }
}

/**
 * Store one company value, or reset it.
 *
 * `value === null` DELETES the row, which is what "print the compiled default again" means — see
 * `resolveCompanyDetails`, where a missing key and an empty string are deliberately different
 * answers. Everything else is stored verbatim, including `""`.
 *
 * THE ABSENT TABLE IS AN ERROR ON THE WRITE PATH, not a degraded success. A read that degrades
 * prints the default and nothing is lost; a WRITE that degraded would report "saved" to somebody who
 * had just corrected a government form, and the correction would be gone. The two paths differ on
 * purpose.
 */
export async function saveCompanyDetail(
  key: CompanyDetailKey,
  value: string | null,
  actorHrId: string | null,
): Promise<CompanyDetails> {
  // `hrIdForStorage`, never the lowercase comparison key `AccessContext.hrId` holds: writing that
  // is what left ~37,000 lowercase actor ids across the database, and a naive `.eq` against one
  // returns nothing at all rather than something visibly wrong.
  const actor = hrIdForStorage(actorHrId);
  const client = getSupabaseAdmin();

  if (value === null) {
    const { error } = await client.from(TABLE).delete().eq("detail_key", key);
    if (error) {
      if (isCompanyDetailsLayerMissing(error)) throw new CompanyDetailsLayerMissingError();
      throw new Error(error.message);
    }
    return loadCompanyDetails();
  }

  const { error } = await client.from(TABLE).upsert(
    {
      detail_key: key,
      detail_value: value,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: actor,
    },
    { onConflict: "detail_key" },
  );

  if (error) {
    if (isCompanyDetailsLayerMissing(error)) throw new CompanyDetailsLayerMissingError();
    throw new Error(error.message);
  }

  // The whole re-read record, never the one value that was written: the caller redraws the paper
  // from this, and a paper drawn from a patched-in value is a paper nobody has proven the server
  // would print.
  return loadCompanyDetails();
}
