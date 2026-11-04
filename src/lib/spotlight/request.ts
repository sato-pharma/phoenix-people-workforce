// Spotlight — parsing a selection off the wire.
//
// Pure, and deliberately STRICT. Everything below arrives from a browser, so nothing is trusted:
// an unknown subject, a malformed window or a limit of 10,000 is refused by name rather than
// coerced into something that happens to run. A coerced selection is the worst outcome here,
// because the sheet it produces looks exactly as authoritative as a correct one.

import { isValidWindow } from "./period";
import { SPOTLIGHT_MAX_LIMIT } from "./service";
import type {
  SpotlightLayout,
  SpotlightRankBy,
  SpotlightRankDirection,
  SpotlightSelection,
  SpotlightSubjectKind,
  SpotlightWindowKind,
} from "./types";

const SUBJECTS: SpotlightSubjectKind[] = ["rep", "dm", "rsm", "nsm", "area", "region", "line"];
const WINDOW_KINDS: SpotlightWindowKind[] = ["month", "quarter", "semester", "year"];
const RANK_BY: SpotlightRankBy[] = ["achievement", "value"];
const DIRECTIONS: SpotlightRankDirection[] = ["top", "bottom"];
const LAYOUTS: SpotlightLayout[] = ["leaderboard", "heroes", "both"];

/** Headline and sub-line are printed on a shared document, so their length is bounded. */
const MAX_HEADLINE = 120;

export class SpotlightRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotlightRequestError";
  }
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new SpotlightRequestError(`"${field}" must be a list.`);
  const out = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: T[], field: string, fallback?: T): T {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value === "string" && (allowed as string[]).includes(value)) return value as T;
  throw new SpotlightRequestError(`"${field}" must be one of: ${allowed.join(", ")}.`);
}

function text(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new SpotlightRequestError(`"${field}" must be text.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_HEADLINE) {
    throw new SpotlightRequestError(`"${field}" is longer than ${MAX_HEADLINE} characters.`);
  }
  return trimmed;
}

export function parseSelection(body: unknown): SpotlightSelection {
  if (!body || typeof body !== "object") throw new SpotlightRequestError("Send a selection.");
  const input = body as Record<string, unknown>;

  const windowInput = (input.window ?? {}) as Record<string, unknown>;
  const windowKind = oneOf(windowInput.kind, WINDOW_KINDS, "window.kind");
  const windowKey = typeof windowInput.key === "string" ? windowInput.key.trim() : "";
  const window = { kind: windowKind, key: windowKey };
  // `isValidWindow` is a type guard, so inside the negated branch TypeScript narrows `window` to
  // `never` — the message is built from the raw values above rather than from the narrowed object.
  if (!isValidWindow(window)) {
    throw new SpotlightRequestError(
      `"${windowKey}" is not a valid ${windowKind}. Expected a form like 2026-08, 2026-Q3, 2026-S2 or 2026.`,
    );
  }

  // `limit: null` is "everyone", which is a real answer and must survive the parse. Only an absent
  // field falls back to 10 — a sensible sheet length rather than the whole field force by accident.
  let limit: number | null = 10;
  if (input.limit === null) limit = null;
  else if (input.limit !== undefined) {
    const parsed = Number(input.limit);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new SpotlightRequestError(`"limit" must be a whole number of at least 1, or null for everyone.`);
    }
    limit = Math.min(SPOTLIGHT_MAX_LIMIT, Math.floor(parsed));
  }

  const filtersInput = (input.filters ?? {}) as Record<string, unknown>;

  return {
    window,
    subject: oneOf(input.subject, SUBJECTS, "subject"),
    filters: {
      lines: stringList(filtersInput.lines, "filters.lines"),
      regions: stringList(filtersInput.regions, "filters.regions"),
      areas: stringList(filtersInput.areas, "filters.areas"),
      hrIds: stringList(filtersInput.hrIds, "filters.hrIds"),
      seatIds: stringList(filtersInput.seatIds, "filters.seatIds"),
      excludeVacant: filtersInput.excludeVacant === true,
    },
    rankBy: oneOf(input.rankBy, RANK_BY, "rankBy", "achievement"),
    direction: oneOf(input.direction, DIRECTIONS, "direction", "top"),
    limit,
    layout: oneOf(input.layout, LAYOUTS, "layout", "both"),
    // Only an explicit `false` hides the money; anything else, including absent, shows it.
    ...(input.showValue === false ? { showValue: false } : {}),
    headline: text(input.headline, "headline"),
    subheadline: text(input.subheadline, "subheadline"),
  };
}
