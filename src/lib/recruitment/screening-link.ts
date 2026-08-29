// Recruitment / ATS — the screening link, and what it narrows to.
//
// WHY THIS IS ITS OWN FILE. These three exports are needed on BOTH sides of the wire: the server
// pages read the narrowing out of the query string, and the candidate pool — a "use client"
// component — builds the link. They started out in screening-queue.ts beside the loader, and that
// was wrong in a way webpack caught immediately: the loader imports listCandidates, which reaches
// employee-directory and employee-photo and ends at `node:crypto`, so a client component importing
// one pure helper dragged the whole server chain into the browser bundle. Under webpack that is a
// hard build failure; the more dangerous version is a bundler that tree-shakes it away in dev and
// stops doing so later.
//
// So the rule this file exists to keep: anything the pool imports must have NO database import
// anywhere in its chain. Nothing here imports a Supabase client, and nothing here should.

import { normalizeCandidateStatus, type CandidateStatus } from "@/lib/recruitment/candidate-status";

/** The filters a screening link can carry. Everything is optional; absent means "no narrowing". */
export type ScreeningQueueFilters = {
  /** `1`/`true` — only CVs this viewer has never opened. The link the owner actually wants. */
  unseen?: string | string[] | undefined;
  /** A single candidate status, e.g. `new`. Anything unrecognised is ignored, never guessed at. */
  status?: string | string[] | undefined;
};

/** What a screening link actually asks for, once the query string has been read. */
export type ScreeningQueueNarrowing = {
  unseenOnly: boolean;
  status: CandidateStatus | null;
};

/** Next.js hands a repeated query param through as an array; take the first and ignore the rest. */
function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function isTruthyFlag(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Read the narrowing out of a link.
 *
 * A URL is untrusted input like any other: a status nobody recognises is IGNORED rather than
 * guessed at or thrown on, because a screening link that 500s because somebody edited the address
 * bar is a worse outcome than one that shows the whole queue.
 */
export function parseScreeningFilters(filters: ScreeningQueueFilters = {}): ScreeningQueueNarrowing {
  return {
    status: normalizeCandidateStatus(firstParam(filters.status)),
    unseenOnly: isTruthyFlag(firstParam(filters.unseen)),
  };
}

/**
 * The link that opens the screening queue, optionally narrowed to only what this person has never
 * read and/or to a single status — "screen only New" is a link exactly the same way "screen only
 * unseen" already is.
 *
 * A function rather than a string constant because the two shells sit at different prefixes and a
 * hard-coded `/recruitment/screening` in the portal would bounce a Talent Acquisition user out
 * through the (admin) group's redirect the moment they clicked it.
 */
export function screeningHref(
  basePath: string,
  options: { unseenOnly?: boolean; status?: CandidateStatus | null } = {},
): string {
  const base = `${basePath.replace(/\/$/, "")}/screening`;
  const params = new URLSearchParams();
  if (options.unseenOnly) params.set("unseen", "1");
  if (options.status) params.set("status", options.status);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
