// Reading an outstation request's notes back as something a person can read.
//
// `service.ts` stores the employee's own note and then appends machine audit lines to the SAME
// text — `Allowance guard: …` and `Car live evidence: source=… hr_id=… captured_at=… location=…
// gps=… draft_id=… request_id=…` (or `Arrival photo evidence:` for any other transport). The stored
// shape is load-bearing: other readers key on it (`employeeVisibleNotes`, the audit trail), so it is
// never rewritten. This module only turns it into display parts, and every screen, email and export
// that shows a description to a person goes through it.
//
// The expense row's `description` holds the same text with every newline collapsed to a space, so
// the markers are found anywhere in the string, never only at a line start.
//
// Client-safe: it runs in the browser bundle and on the server alike. Times go through
// `cairo-datetime`, never a fresh Intl formatter with timeZone "Africa/Cairo": that one renders an
// hour apart on an engine with pre-2023 zone data, and in a "use client" component the one-digit
// difference is hydration error #418 (see that module's header).

import { codeOrWords, humanizeCode } from "@/lib/format/code-label";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";

export type OutstationEvidenceKind = "car" | "arrival";

export type OutstationEvidenceStamp = {
  kind: OutstationEvidenceKind;
  /** "Car photo" or "Arrival photo". */
  title: string;
  /** How the photo was taken, in words: "taken live in the app" or "uploaded". Null when unknown. */
  sourceLabel: string | null;
  /** The instant as stored (UTC ISO), kept for sorting and links. */
  capturedAt: string | null;
  /** The same instant in Cairo, e.g. "19 Sept 2026 · 12:33". */
  capturedAtLabel: string | null;
  /** The street address without its plus code, postal code or trailing ", Egypt". */
  place: string | null;
  brick: string | null;
  area: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  /** A Google Maps link to the captured point, when the coordinates are real. */
  mapUrl: string | null;
};

export type OutstationDescriptionParts = {
  /** The employee's own words, exactly as typed (whitespace tidied), or null. */
  note: string | null;
  /** Why an allowance was not paid, one sentence per notice, dates written out. */
  allowanceNotices: string[];
  evidence: OutstationEvidenceStamp[];
};

const MARKER = /(Car live evidence:|Arrival photo evidence:|Allowance guard:)/gi;
const EVIDENCE_KEYS = ["source", "hr_id", "captured_at", "location", "gps", "draft_id", "request_id"] as const;
const EVIDENCE_KEY = new RegExp(`(^|\\s)(${EVIDENCE_KEYS.join("|")})=`, "g");

// An Open Location Code ("4W8R+7Q3", "5WW8+Q5X") at the head of a geocoded address.
const LEADING_PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{0,3}(?=[\s,،]|$)[\s,،]*/i;

function tidy(value: string | null | undefined) {
  const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}

/** "19 Sept 2026 · 12:33", in Cairo — the platform's one timestamp format. */
export function formatOutstationEvidenceTime(value: string | null | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return null;
  return cairoDateTime(value);
}

/** A calendar date inside a sentence ("2026-08-06") written out as "06 Aug 2026". */
function writeOutCalendarDates(sentence: string) {
  return sentence.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (match) => {
    const written = utcDate(match);
    return written === "—" ? match : written;
  });
}

/**
 * A geocoder address as a person would write it: no plus code at the head, no postal code after
 * the governorate, no trailing "Egypt".
 */
export function tidyOutstationAddress(value: string | null | undefined) {
  const address = tidy(value);
  if (!address) return null;
  const segments = address
    .replace(LEADING_PLUS_CODE, "")
    .split(/\s*[,،]\s*/)
    .map((segment) => segment.replace(/\s+\d{4,7}$/, "").trim())
    .filter((segment) => segment.length > 0 && !/^egypt$/i.test(segment) && !/^\d{4,7}$/.test(segment));
  return segments.length > 0 ? segments.join(", ") : null;
}

/** A stored code written as words: "manager_review" → "Manager review", "car" → "Car". */
export function humanizeOutstationCode(value: string | null | undefined) {
  const words = tidy(codeOrWords(String(value ?? "")));
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : null;
}

function sourceLabel(source: string | null) {
  if (!source) return null;
  if (source === "live_camera") return "taken live in the app";
  if (source === "upload") return "uploaded";
  return humanizeCode(source).toLowerCase();
}

function coordinate(value: string | undefined, limit: number) {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

function parseEvidence(kind: OutstationEvidenceKind, body: string): { stamp: OutstationEvidenceStamp; rest: string | null } {
  const fields = new Map<string, string>();
  const starts = [...body.matchAll(EVIDENCE_KEY)].map((match) => ({
    key: match[2],
    valueStart: (match.index ?? 0) + match[0].length,
    keyStart: (match.index ?? 0) + match[1].length,
  }));
  let rest: string | null = starts.length > 0 ? tidy(body.slice(0, starts[0].keyStart)) : tidy(body);

  starts.forEach((start, index) => {
    const next = starts[index + 1];
    let value = body.slice(start.valueStart, next ? next.keyStart : body.length);
    if (!next) {
      // The last key's value is one token; anything after it is not part of the audit line.
      const [token, ...after] = value.trim().split(/\s+/);
      value = token ?? "";
      rest = tidy([rest, after.join(" ")].filter(Boolean).join(" "));
    }
    fields.set(start.key, value.trim());
  });

  const [addressPart, ...labelParts] = (fields.get("location") ?? "").split(/\s+·\s+/);
  const labelled = (prefix: string) => {
    const part = labelParts.find((segment) => segment.startsWith(`${prefix} `));
    return part ? tidy(part.slice(prefix.length + 1)) : null;
  };

  const [latText, lngText] = (fields.get("gps") ?? "").split(",");
  const latitude = coordinate(latText, 90);
  const longitude = coordinate(lngText, 180);
  const hasPoint = latitude !== null && longitude !== null && !(latitude === 0 && longitude === 0);
  const capturedAt = tidy(fields.get("captured_at"));

  return {
    rest,
    stamp: {
      area: labelled("Area"),
      brick: labelled("Brick"),
      capturedAt,
      capturedAtLabel: formatOutstationEvidenceTime(capturedAt),
      kind,
      latitude: hasPoint ? latitude : null,
      longitude: hasPoint ? longitude : null,
      mapUrl: hasPoint ? `https://www.google.com/maps?q=${latitude},${longitude}` : null,
      place: tidyOutstationAddress(addressPart),
      region: labelled("Region"),
      sourceLabel: sourceLabel(tidy(fields.get("source"))),
      title: kind === "car" ? "Car photo" : "Arrival photo",
    },
  };
}

/**
 * One notice per DISTINCT sentence, with how many days it covered.
 *
 * The guard writes one reason per trip day, so rows stored before 2026-09-28 repeat a sentence once
 * per day — OUTSTATION-148 printed "No allowance: a trip to Cairo from a regional base does not earn
 * an outstation per-diem allowance." five times in a row. The source now writes each reason once
 * with "(5 days)"; this reads the OLD rows the same way, so a person sees one sentence either way.
 * A reason that names its own date ("Allowance for 2026-09-09 was already granted…") stays
 * distinct by construction, because the date is part of the sentence.
 */
function distinctAllowanceSentences(body: string | null): string[] {
  if (!body) return [];
  const counts = new Map<string, number>();
  for (const raw of body.split(/(?<=\.)\s+/)) {
    const sentence = raw.trim();
    if (sentence) counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  return [...counts].map(([sentence, times]) => {
    // "No allowance: <reason>" reads as a label glued to a label once it sits under its own
    // heading, so the reason keeps a dash instead.
    const labelled = sentence.replace(/^No allowance:\s*/i, "No allowance — ");
    return times > 1 ? `${labelled.replace(/\.$/, "")} (${times} days).` : labelled;
  });
}

/** Splits stored outstation notes (or an expense description) into the parts a person reads. */
export function parseOutstationDescription(raw: string | null | undefined): OutstationDescriptionParts {
  const source = String(raw ?? "");
  const markers = [...source.matchAll(MARKER)];
  const noteParts: string[] = [];
  const allowanceNotices: string[] = [];
  const evidence: OutstationEvidenceStamp[] = [];

  const lead = tidy(source.slice(0, markers[0]?.index ?? source.length));
  if (lead && lead !== "-") noteParts.push(lead);

  markers.forEach((marker, index) => {
    const bodyStart = (marker.index ?? 0) + marker[0].length;
    const body = source.slice(bodyStart, markers[index + 1]?.index ?? source.length);
    const label = marker[0].toLowerCase();

    if (label.startsWith("allowance guard")) {
      for (const notice of distinctAllowanceSentences(tidy(body))) {
        allowanceNotices.push(writeOutCalendarDates(notice));
      }
      return;
    }

    const { rest, stamp } = parseEvidence(label.startsWith("car") ? "car" : "arrival", body);
    evidence.push(stamp);
    if (rest) noteParts.push(rest);
  });

  return { allowanceNotices, evidence, note: noteParts.length > 0 ? noteParts.join("\n") : null };
}

/** One evidence stamp as plain-text lines: what and when, then the place, then the territory. */
export function outstationEvidenceLines(stamp: OutstationEvidenceStamp) {
  const heading = [stamp.title, stamp.sourceLabel].filter(Boolean).join(", ");
  const territory = [
    stamp.brick ? `Brick ${stamp.brick}` : null,
    stamp.area ? `Area ${stamp.area}` : null,
    stamp.region ? `Region ${stamp.region}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    stamp.capturedAtLabel ? `${heading} — ${stamp.capturedAtLabel}` : heading,
    stamp.place,
    territory || null,
  ].filter((line): line is string => Boolean(line));
}

/**
 * The description as clean plain text, one fact per line — for emails, spreadsheet cells and any
 * other surface that cannot render the structured parts. Empty string when there is nothing to say.
 */
export function formatOutstationDescriptionText(raw: string | null | undefined) {
  const parts = parseOutstationDescription(raw);
  return [
    parts.note,
    ...parts.allowanceNotices,
    ...parts.evidence.flatMap(outstationEvidenceLines),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/** One line of the plain-text form, for a single spreadsheet cell or a one-line summary. */
export function formatOutstationDescriptionInline(raw: string | null | undefined) {
  return formatOutstationDescriptionText(raw).split("\n").join(" · ");
}

