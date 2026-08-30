// Recruitment / ATS — the screening link, and what it narrows to.
//
// WHY THIS IS ITS OWN FILE. These exports are needed on BOTH sides of the wire: the server pages
// read the narrowing out of the query string, and the candidate pool — a "use client" component —
// builds the link. They started out in screening-queue.ts beside the loader, and that was wrong in
// a way webpack caught immediately: the loader imports listCandidates, which reaches
// employee-directory and employee-photo and ends at `node:crypto`, so a client component importing
// one pure helper dragged the whole server chain into the browser bundle. Under webpack that is a
// hard build failure; the more dangerous version is a bundler that tree-shakes it away in dev and
// stops doing so later.
//
// So the rule this file exists to keep: anything the pool imports must have NO database import
// anywhere in its chain. The three modules imported below are pure vocabularies — a list of status
// codes, a list of role families, and a list of region codes — and between them they have not one
// import of their own. Nothing here reaches a Supabase client, and nothing here should.
// tests/recruitment-screening-page.test.ts pins that import list exactly.

import { candidateRegionCodes, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilies, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { normalizeCandidateStatus, type CandidateStatus } from "@/lib/recruitment/candidate-status";

/** The filters a screening link can carry. Everything is optional; absent means "no narrowing". */
export type ScreeningQueueFilters = {
  /** `1`/`true` — only CVs this viewer has never opened. The link the owner actually wants. */
  unseen?: string | string[] | undefined;
  /** `1`/`true` — the other half of the same three-way: only CVs this viewer HAS already opened. */
  seen?: string | string[] | undefined;
  /** `1`/`true` — only CVs already pushed straight to a manager. */
  sent?: string | string[] | undefined;
  /** `1`/`true` — the other half of the same three-way: only CVs never pushed to a manager. */
  unsent?: string | string[] | undefined;
  /** A single candidate status, e.g. `new`. Anything unrecognised is ignored, never guessed at. */
  status?: string | string[] | undefined;
  /** The area the applicant asked to work in, verbatim, or `unknown` for those who never said. */
  area?: string | string[] | undefined;
  /** A `candidateRoleFamilies` value, or `unknown` for candidates with no job title on file. */
  role?: string | string[] | undefined;
  /** A `candidateRegionCodes` value, `foreign`, or `unknown`. */
  region?: string | string[] | undefined;
  /** A `screeningReceivedFilters` value — how long ago the CV arrived. */
  received?: string | string[] | undefined;
  /** A source channel label, verbatim — see `candidateSourceChannel`, e.g. `WhatsApp`, `Email`. */
  source?: string | string[] | undefined;
};

/**
 * Seen / unseen, as a THREE-way rather than a checkbox.
 *
 * "Unseen only" existed first and is the owner's bookmarked link. Its opposite is a real question
 * too — "show me the ones I have already read", which is how you get back to a CV you remember
 * without remembering the name — and folding that into an unchecked box answers it with the whole
 * pool instead.
 */
export type ScreeningSeenFilter = "any" | "seen" | "unseen";

/**
 * Sent-to-a-manager, as the same kind of three-way as seen/unseen above — and for the same reason:
 * "never sent" is a real question a screener asks ("what's still sitting with nobody looking at
 * it?"), not just the absence of the "already sent" checkbox.
 */
export type ScreeningNotifiedFilter = "any" | "sent" | "unsent";

/**
 * How long ago the CV arrived, as a rolling window ending now — "the last hour", not "today" — so
 * hour/day/week/month compose into one scale rather than mixing a clock window with a calendar one.
 */
export type ScreeningReceivedFilter = "hour" | "day" | "week" | "month";

/** Narrowest window first, matching how a person scans the dropdown. */
export const screeningReceivedFilters: readonly ScreeningReceivedFilter[] = ["hour", "day", "week", "month"];

export const screeningReceivedFilterLabels: Record<ScreeningReceivedFilter, string> = {
  day: "Last 24 hours",
  hour: "Last hour",
  month: "Last 30 days",
  week: "Last 7 days",
};

/** A role family, or `unknown` — meaning nobody ever told us what this person does. */
export type ScreeningRoleFilter = CandidateRoleFamily | "unknown";

/**
 * A company region, `foreign` (an address we hold that is not in Egypt), or `unknown` (no
 * governorate on file at all). Three buckets, not two, for the reason the pool's own filter gives:
 * "we do not know where they live" and "we do, and it is abroad" are different answers, and filing
 * the second under the first misdescribes somebody whose address we actually hold.
 */
export type ScreeningRegionFilter = CandidateRegionCode | "foreign" | "unknown";

/**
 * The value that means "we were never told", as opposed to naming a real answer.
 *
 * On the area filter it is a sentinel inside the same parameter rather than a second parameter,
 * because it is one question with one answer. Areas here are Egyptian territory names — "Gharbia 1
 * (Tanta)", "Alex West" — so the collision this in principle allows (an area literally called
 * "unknown") does not exist, and the same word already means the same thing on the role and region
 * filters beside it.
 */
export const SCREENING_UNKNOWN = "unknown";

/** What a screening link actually asks for, once the query string has been read. */
export type ScreeningQueueNarrowing = {
  seen: ScreeningSeenFilter;
  notified: ScreeningNotifiedFilter;
  status: CandidateStatus | null;
  /** An area name spelled as the applicant's answer spells it, or `SCREENING_UNKNOWN`. */
  area: string | null;
  role: ScreeningRoleFilter | null;
  region: ScreeningRegionFilter | null;
  received: ScreeningReceivedFilter | null;
  /** A source channel label, verbatim — see `candidateSourceChannel`. */
  source: string | null;
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

function parseRole(value: string | null): ScreeningRoleFilter | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === SCREENING_UNKNOWN) return SCREENING_UNKNOWN;
  return (candidateRoleFamilies as readonly string[]).includes(normalized)
    ? (normalized as CandidateRoleFamily)
    : null;
}

function parseReceived(value: string | null): ScreeningReceivedFilter | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return (screeningReceivedFilters as readonly string[]).includes(normalized)
    ? (normalized as ScreeningReceivedFilter)
    : null;
}

function parseRegion(value: string | null): ScreeningRegionFilter | null {
  if (!value) return null;
  // Region CODES are upper case (`CA`, `D3`) and the two buckets are lower case, so each half is
  // normalised the way it is actually written rather than folding both to one case.
  const lower = value.toLowerCase();
  if (lower === SCREENING_UNKNOWN) return SCREENING_UNKNOWN;
  if (lower === "foreign") return "foreign";
  const upper = value.toUpperCase();
  return (candidateRegionCodes as readonly string[]).includes(upper) ? (upper as CandidateRegionCode) : null;
}

/**
 * Read the narrowing out of a link.
 *
 * A URL is untrusted input like any other: a status, role or region nobody recognises is IGNORED
 * rather than guessed at or thrown on, because a screening link that 500s because somebody edited
 * the address bar is a worse outcome than one that shows the whole queue. The area is the one value
 * that cannot be validated here — it is free text an applicant typed or tapped, and this module is
 * not allowed to reach the database to find out which ones exist — so it is passed through as
 * written and simply matches nobody if it is nonsense.
 */
export function parseScreeningFilters(filters: ScreeningQueueFilters = {}): ScreeningQueueNarrowing {
  const unseen = isTruthyFlag(firstParam(filters.unseen));
  const seen = isTruthyFlag(firstParam(filters.seen));
  const sent = isTruthyFlag(firstParam(filters.sent));
  const unsent = isTruthyFlag(firstParam(filters.unsent));
  const area = firstParam(filters.area);
  return {
    area: area && area.toLowerCase() === SCREENING_UNKNOWN ? SCREENING_UNKNOWN : area,
    // `?sent=1&unsent=1` is somebody editing an address bar, not an attack. Sent wins for the same
    // reason unseen wins over seen below: it is the narrower, more specific half of the pair.
    notified: sent ? "sent" : unsent ? "unsent" : "any",
    received: parseReceived(firstParam(filters.received)),
    region: parseRegion(firstParam(filters.region)),
    role: parseRole(firstParam(filters.role)),
    // `?unseen=1&seen=1` is somebody editing an address bar, not an attack. Unseen wins because it
    // is the link that already exists in bookmarks and in the pool's own button.
    seen: unseen ? "unseen" : seen ? "seen" : "any",
    source: firstParam(filters.source),
    status: normalizeCandidateStatus(firstParam(filters.status)),
  };
}

/** Everything a screening link can narrow to. Absent keys narrow nothing, exactly as before. */
export type ScreeningHrefOptions = {
  seen?: ScreeningSeenFilter;
  notified?: ScreeningNotifiedFilter;
  status?: CandidateStatus | null;
  area?: string | null;
  role?: ScreeningRoleFilter | null;
  region?: ScreeningRegionFilter | null;
  received?: ScreeningReceivedFilter | null;
  source?: string | null;
};

/**
 * The link that opens the screening queue, optionally narrowed.
 *
 * Every filter on the page is a LINK rather than a piece of component state, which is the whole
 * point of the page existing: "screen the New Medical Rep CVs in Tanta I have not read yet" is
 * something you can bookmark, paste into a message, or come back to tomorrow.
 *
 * `seen: "unseen"` deliberately still emits `?unseen=1` — the exact URL the owner already has
 * bookmarked and the one the pool's button builds — rather than a new spelling of the same thing.
 *
 * A function rather than a string constant because the two shells sit at different prefixes and a
 * hard-coded `/recruitment/screening` in the portal would bounce a Talent Acquisition user out
 * through the (admin) group's redirect the moment they clicked it.
 */
export function screeningHref(basePath: string, options: ScreeningHrefOptions = {}): string {
  const base = `${basePath.replace(/\/$/, "")}/screening`;
  const params = new URLSearchParams();
  if (options.seen === "unseen") params.set("unseen", "1");
  if (options.seen === "seen") params.set("seen", "1");
  if (options.notified === "sent") params.set("sent", "1");
  if (options.notified === "unsent") params.set("unsent", "1");
  if (options.status) params.set("status", options.status);
  if (options.role) params.set("role", options.role);
  if (options.region) params.set("region", options.region);
  if (options.area) params.set("area", options.area);
  if (options.received) params.set("received", options.received);
  if (options.source) params.set("source", options.source);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * WHICH SHELL IS THE BROWSER ACTUALLY IN? Not always the one that rendered the page.
 *
 * HR Advisory and HR Operations browse under an `/hr` namespace that proxy.ts REWRITES onto the
 * (admin) route. The rewrite is invisible to the server — it renders
 * app/(admin)/recruitment/screening and hands the client `poolHref="/recruitment"` — while the
 * browser is sitting at `/hr/recruitment/screening` with the HR sidebar. Building a link from the
 * server's own href navigates OUT of that namespace: measured 2026-08-30, changing one filter moved
 * the user from /hr/recruitment/screening to /recruitment/screening and swapped their whole sidebar
 * mid-task.
 *
 * `usePathname` is the only thing that can see the rewrite, so the browser's own path is the input.
 * The page is always `<pool>/screening`, so the pool is that path with the suffix removed.
 *
 * Pure, and exported from here rather than left inline in the client component, because a rule that
 * only exists inside a React hook can only be checked by driving a browser — and the browser pane
 * reports `visibilityState: "hidden"` when it is collapsed, which stalls React's scheduler and makes
 * exactly this kind of check unprovable at the moment you need it.
 *
 * The fallback covers everything unexpected, including a bare "/screening" whose pool would
 * otherwise be the empty string — a router.push("") reloads the current URL rather than navigating.
 */
export function screeningShellPoolHref(pathname: string | null | undefined, fallback: string): string {
  const suffix = "/screening";
  return pathname && pathname.endsWith(suffix) && pathname.length > suffix.length
    ? pathname.slice(0, -suffix.length)
    : fallback;
}
