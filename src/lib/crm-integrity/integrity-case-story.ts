/**
 * Location integrity — every case told as a story, in clear simple English.
 *
 * The owner's seventh request of 2026-10-13: "make every case a story telling in clear simple
 * english". Before this the board printed the detector's label and nothing else — "The photo and the
 * pin are the same reading, to the bit" — which says what was measured but not what it means, what
 * the ordinary innocent reason is, or what he is being asked to decide.
 *
 * 🔴 THE HOUSE VOICE IS: STATE THE MEASURED FACT, THEN NAME THE ORDINARY EXPLANATION, NEVER A
 * VERDICT. It is the voice `validation-review-queue.tsx` and `location-confidence.ts` already use,
 * and on this board it is not a style preference: a flag here is a reading, nothing more. Most of
 * them have a completely innocent cause — a one-tap capture, a phone on approximate location, a
 * shared clinic door, a leave record entered after the visit — and the person it is about is never
 * told a check exists, so the sentences must be fair in a room he is not in. Nothing here calls
 * anything fraud, and nothing concludes.
 *
 * 🔴 AND EVERY UNKNOWN HAS ITS OWN SENTENCE, SO A DETECTOR ADDED LATER CAN NEVER PRINT AS A CODE.
 * A source this module does not know says so in words and shows its measurements; a flag it does not
 * know falls back to the label the board already carries, then to its own words opened out. That is
 * the pattern `signboardText()` follows, and it is why `signboard` — which started filing cases on
 * 2026-10-08 without being added anywhere — printed as **Position** on the owner's board for a day.
 *
 * Pure: no React, no server import, no clock of its own. The caller passes the case; this returns
 * sentences.
 */

import { distanceMeters, formatDistance } from "@/lib/phoenix-crm/geo";

export type CaseStoryReading = {
  label: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  atIso: string | null;
};

/**
 * Every reading label the board prints, in ONE place.
 *
 * 🔴 THE LOADER NAMES ITS READINGS FROM HERE, so a sentence that has to FIND one of them by name
 * cannot be quietly orphaned by a reworded label. `visitsAgainstThePhotographSentence` looks the
 * photograph up by its label and returns null when it is absent — which is exactly how a renamed
 * label would read: not as a broken panel, but as a panel that has silently stopped saying the one
 * thing the owner asked it to say. The map of subject kinds below lives here for the same reason.
 */
export const CASE_READING_LABELS = {
  visitSaved: "Where the visit was saved",
  photograph: "Where the photograph was taken",
  placeOnList: "The place on the list",
  placeCaptured: "Where the place was captured",
  pin: "The pin saved for the place",
  /**
   * The PLACE's photograph, on a case about a VISIT — the anchor the owner named.
   *
   * A separate label from `photograph` because they are different readings on a visit case: that
   * one is the shutter fix of the picture the REP took on the call, this one is the shutter fix of
   * the picture the place was validated with. On most places it sits on the same coordinate as the
   * point kept for the place (1,312 of 1,403, production 13 Oct 2026), and `groupReadings` says so
   * on one line rather than printing the same numbers twice.
   */
  placePhotograph: "The photograph saved for the place",
} as const;

/** One visit of this case's customer, as a point. The metres are measured here, never in the loader. */
export type CaseVisitPoint = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  atIso: string | null;
};

/**
 * Everything a story needs, named structurally rather than imported from the board's own type.
 *
 * Deliberate: the loader's module reaches the database, so a client component may only take its
 * TYPES from it, and a test must be able to build a case without one. Every field here is a field
 * `IntegrityCase` already carries.
 */
export type CaseStoryInput = {
  source: string;
  subjectKind: string;
  strong: boolean;
  flags: ReadonlyArray<string>;
  /** Each finding in the words the board already prints. The fallback for a flag with no sentence. */
  reasons: ReadonlyArray<string>;
  repName: string;
  customerName: string;
  customerList: string | null;
  customerSpeciality: string | null;
  subjectLabel: string | null;
  brickName: string | null;
  brickDistanceKm: number | null;
  placeDistanceMeters: number | null;
  readings: ReadonlyArray<CaseStoryReading>;
  /**
   * Every visit saved for this case's customer, as points — what the place's own readings are judged
   * AGAINST. Empty for a customer with none, and for a visit case, whose own fix is already one of
   * the readings above.
   */
  nearbyVisits: ReadonlyArray<CaseVisitPoint>;
  /** The metres between the two readings furthest apart, from `integrity-case-map.ts`. */
  spreadMeters: number | null;
  accuracyMeters: number | null;
  deviceMocked: boolean | null;
  signText: string | null;
  companionNames: ReadonlyArray<string>;
  replayByName: string | null;
  signals: Record<string, unknown>;
  photoPath: string | null;
  visitDate: string | null;
};

export type CaseEvidence = { label: string; value: string };

export type CaseStory = {
  /** One sentence: the measured fact, for the row itself. Never a verdict and never a question. */
  headline: string;
  /**
   * The story as NUMBERED POINTS, one fact each — the owner's instruction of 13 October 2026:
   * "I want it as easy as visits, location versus the validation location with a story listed
   * pointed 1, 2, 3 … clear English. Don't make me enter a loop."
   *
   * 🔴 FIVE POINTS AT MOST. Before this it was eight to twelve sentences of paragraph, including one
   * line saying a photograph was below the paragraph and a three-line block for the ordinary
   * causes — and he could not find what had happened in it. Anything that is not the fact, the
   * comparison or the ordinary cause belongs in the measurements, a click away and out of his path.
   */
  story: string[];
  /**
   * The one comparison a case comes down to: where the capture says it happened, the location it
   * was judged against, and the distance between them. Null when the case has a single coordinate
   * (a replay case, by definition) or nothing to compare it with.
   */
  comparison: CaseComparison | null;
  /** The raw measurements, so a reader can check the sentences rather than trust them. */
  evidence: CaseEvidence[];
};

/**
 * The two locations side by side, which is how the owner reads a case: "location versus the
 * validation location".
 *
 * `capture` is where the thing being judged says it happened; `validation` is what it was measured
 * against — the photograph the place was validated with wherever there is one, because the
 * photograph is the anchor and the pin is dropped from the judgement (his instruction, 13 October
 * 2026). `apart` is the plain-English distance, and "the same reading" when the two coincide.
 */
export type CaseComparisonSide = {
  label: string;
  coordinates: string;
  accuracy: string | null;
  at: string | null;
};

export type CaseComparison = {
  capture: CaseComparisonSide;
  validation: CaseComparisonSide;
  apart: string;
  /** Metres between them — 0 when the two readings are identical, never null. */
  apartMeters: number;
};

/** What each detector is called on the screen, and what it looks at. */
export const INTEGRITY_SOURCE_STORY_LABELS: Record<string, string> = {
  gps: "Position",
  photo: "Photograph",
  behaviour: "The month's shape",
  signboard: "Signboard",
  capture_trust: "Pin and photograph",
  roster: "The day's record",
  cadence: "How often",
  coverage: "Brick",
  // The visit against the place's photograph (2026-10-13). It names what was COMPARED, never what
  // it means — a rep filling the form in the car outside produces this reading honestly.
  visit_photo: "Visit against the photograph",
};

/** The detector by name, never as a code — an unknown one reads as its own words opened out. */
export function integritySourceStoryLabel(source: string): string {
  return INTEGRITY_SOURCE_STORY_LABELS[source] ?? source.replace(/_/g, " ");
}

/**
 * Every subject kind the table may carry — what a case is ABOUT, as opposed to which check filed it.
 *
 * 🔴 IT LIVES IN THIS PURE MODULE SO THERE IS ONE MAP AND NOT TWO. `server/integrity-board.ts`
 * re-exports both of these and the board's own view imports them straight from here, because a
 * client component may not touch that server module at all — it would carry the service-role Supabase
 * client into the browser bundle. The first draft of the view therefore carried its own copy of this
 * map, which is precisely how a kind added to one of them prints as `shared_place` on the other.
 *
 * `tests/phoenix-crm-integrity-settle.test.ts` reads this list against the migration's own CHECK,
 * because the column is text and the compiler cannot.
 */
export const INTEGRITY_SUBJECT_KINDS = ["visit", "place", "shared_place", "customer"] as const;

export type IntegritySubjectKind = (typeof INTEGRITY_SUBJECT_KINDS)[number];

/**
 * Each kind in the owner's own words, as the board prints it. Sentence case, because it is written
 * at the head of a line and lowercased where it appears mid-sentence.
 */
export const INTEGRITY_SUBJECT_KIND_LABELS: Record<IntegritySubjectKind, string> = {
  visit: "A visit",
  place: "Validating a place",
  shared_place: "A shared venue",
  customer: "A customer",
};

/** The kind by name, never as a code — an unknown one reads as its own words opened out. */
export function integritySubjectKindLabel(kind: string): string {
  return INTEGRITY_SUBJECT_KIND_LABELS[kind as IntegritySubjectKind] ?? kind.replace(/_/g, " ");
}

// ── Small, honest formatters ────────────────────────────────────────────────────────────────────

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "")).filter((entry) => entry !== "") : [];
}

/** A gap in words. Seconds up to a minute, then minutes, then hours — never a bare number of seconds. */
export function spokenGap(seconds: number): string {
  const absolute = Math.abs(seconds);
  if (absolute < 1) return "less than a second";
  if (absolute < 90) return `${Math.round(absolute)} seconds`;
  const minutes = absolute / 60;
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  return hours < 24 ? `${Math.round(hours * 10) / 10} hours` : `${Math.round(hours / 24)} days`;
}

/** A list of names as a reader would say it: "A", "A and B", "A, B and C". */
export function spokenList(values: ReadonlyArray<string>): string {
  const kept = values.filter((value) => value.trim() !== "");
  if (kept.length === 0) return "";
  if (kept.length === 1) return kept[0]!;
  return `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]!}`;
}

/** Readings that share a coordinate to six decimals, so the panel can say "one reading" once. */
export function groupReadings(
  readings: ReadonlyArray<CaseStoryReading>,
): ReadonlyArray<{ labels: string[]; reading: CaseStoryReading }> {
  const groups: { labels: string[]; reading: CaseStoryReading }[] = [];
  const keyOf = (r: CaseStoryReading): string => `${r.lat.toFixed(6)},${r.lon.toFixed(6)}`;
  for (const reading of readings) {
    const existing = groups.find((group) => keyOf(group.reading) === keyOf(reading));
    if (existing !== undefined) existing.labels.push(reading.label);
    else groups.push({ labels: [reading.label], reading });
  }
  return groups;
}

/** Several reading labels as one phrase: only the first keeps its capital. */
function spokenLabelList(labels: ReadonlyArray<string>): string {
  return spokenList(labels.map((label, index) => (index === 0 ? label : lowerFirst(label))));
}

/** A label mid-sentence: "The odd one out is the pin saved for the place", not "The pin". */
function lowerFirst(value: string): string {
  return value === "" || /^[A-Z][A-Z]/.test(value) ? value : value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Which reading disagrees with the others, and whether it is the less precise of the two.
 *
 * 🔴 IT NAMES THE ODD READING AND REFUSES TO SAY WHICH OF THE TWO IS WRONG. The first draft of
 * this sentence concluded from the ACCURACY figures — "the least precise of them, so the likelier to
 * be the stale one" — and the owner's very first case proved that backwards within the hour: the
 * photograph of ليندا اسكندر's place carried the TIGHTER figure (25 m against the pin's 100 m) and was
 * the outlier, while the pin and the visit she saved 96 seconds later agreed with each other to 56 m.
 * A phone reports a cached position just as confidently as a live one, so accuracy ranks precision,
 * never truth. What settles it is whether anything else from that day sits near one of the readings,
 * which is a question about other rows and not about this case.
 *
 * This is the question a reader asks first and the panel never answered: three coordinates, two of
 * them identical, and nothing saying which one is the doubtful one. Null whenever the shape is not
 * "several agreeing readings and exactly one odd" — a replay case has one coordinate by definition.
 */
export function oddReadingSentence(input: CaseStoryInput): string | null {
  if (input.readings.length < 3) return null;
  const groups = groupReadings(input.readings);
  if (groups.length !== 2) return null;
  const [agreeing, odd] =
    groups[0]!.labels.length >= groups[1]!.labels.length ? [groups[0]!, groups[1]!] : [groups[1]!, groups[0]!];
  if (agreeing.labels.length < 2 || odd.labels.length !== 1) return null;
  const agreeingAccuracy = agreeing.reading.accuracyMeters;
  const oddAccuracy = odd.reading.accuracyMeters;
  const precision =
    agreeingAccuracy !== null && oddAccuracy !== null
      ? ` The phone reported it as accurate to about ${formatDistance(oddAccuracy)}, against about ${formatDistance(agreeingAccuracy)} for the other two — but a tighter figure is not a truer reading, because a cached position is reported just as confidently, so which of the two is stale is settled by whether anything else from that day sits near one of them.`
      : "";
  // 🔴 WHY TWO READINGS AGREE IS NOT ALWAYS A SINGLE TAP, and this sentence used to say it was.
  // The pin and the photograph coinciding IS a one-tap capture. But the point kept for the place
  // coinciding with the place's photograph is a different thing entirely — `point_source` says the
  // kept point was taken FROM the photograph, which is true of 1,312 of the 1,403 validated places —
  // and on a visit case those are the two labels that agree. Printing "saved in a single tap" there
  // would be a confident explanation of the wrong mechanism.
  const labels = agreeing.labels;
  const oneTap = labels.includes(CASE_READING_LABELS.pin) && labels.includes(CASE_READING_LABELS.photograph);
  const keptFromPhotograph =
    labels.includes(CASE_READING_LABELS.placeOnList) && labels.includes(CASE_READING_LABELS.placePhotograph);
  const why = oneTap
    ? ", saved in a single tap"
    : keptFromPhotograph
      ? " — the point kept for the place is the photograph's own reading"
      : "";
  return `${spokenLabelList(agreeing.labels)} are one and the same reading${why}. The one that disagrees is ${lowerFirst(odd.reading.label)}.${precision}`;
}

/**
 * What the customer's own visits sit near — the question `oddReadingSentence` can only defer.
 *
 * 🔴 THE PHOTOGRAPH IS THE ANCHOR AND THE VISITS ARE MEASURED AGAINST IT (owner, 13 October 2026:
 * "since u have the accurate validation the photo with location then drop the suspected one and
 * compare visits vs the accurate"). A photograph carries the fix its own shutter took at the door,
 * so it is the one reading nobody can drag across a map; a pin can be. The panel therefore drops the
 * pin from the judgement and says how far what the rep saved LATER sits from the photograph — and,
 * where the place's two readings disagree, which of the two those later visits sit with. That is the
 * "whether anything else from that day sits near one of them" the sentence above has to leave open,
 * answered from rows this case already has.
 *
 * Measured on production the same day, every visit against its own customer's photograph: of 1,284
 * visits carrying a fix, 1,143 (89.02%) sit within 100 m of it and 48 sit further than the 300 m the
 * settings call far. Anchoring on the photograph rather than on the place's kept point changes the
 * verdict for 2 of those 1,284, because the kept point already IS the photograph for 1,312 of the
 * 1,403 validated places — so this sentence REPORTS the comparison rather than altering it, and
 * nothing in the detector or in a stored distance moves. Account:
 * `docs/phoenix-crm-integrity-settlement.md` §12.
 *
 * It concludes nothing. "Sits with the pin" says where the later readings are, never who was where,
 * and the ordinary cause closes the sentence: a visit is saved where the phone is when the box is
 * filled in, which is not always the door. Null whenever there is no photograph or no visit.
 */
export function visitsAgainstThePhotographSentence(input: CaseStoryInput): string | null {
  const photograph = input.readings.find((reading) => reading.label === CASE_READING_LABELS.photograph);
  if (photograph === undefined) return null;
  const visits = input.nearbyVisits.filter((visit) => Number.isFinite(visit.lat) && Number.isFinite(visit.lon));
  if (visits.length === 0) return null;
  const nearestTo = (point: { lat: number; lon: number }): number =>
    Math.min(...visits.map((visit) => distanceMeters({ lat: visit.lat, lon: visit.lon }, point)));
  const fromPhotograph = nearestTo(photograph);
  const whose = input.customerName !== "" && input.customerName !== "—" ? ` saved for ${input.customerName}` : "";
  const opening =
    visits.length === 1
      ? `The one visit${whose} sits about ${formatDistance(fromPhotograph)} from the photograph`
      : `Of the ${visits.length} visits${whose}, the nearest sits about ${formatDistance(fromPhotograph)} from the photograph`;
  const cause = "A visit is saved where the phone is when the box is filled in, which is not always the door.";

  // The other place reading, as a reader sees it: the furthest of this case's remaining readings from
  // the photograph, with readings on one coordinate named together. A case whose other readings all
  // sit ON the photograph has nothing to compare, and says only where the visits are.
  const others = groupReadings(input.readings.filter((reading) => reading.label !== CASE_READING_LABELS.photograph))
    .filter((group) => distanceMeters({ lat: group.reading.lat, lon: group.reading.lon }, photograph) > 0);
  if (others.length === 0) return `${opening}. ${cause}`;
  const other = others.reduce((furthest, group) =>
    distanceMeters({ lat: group.reading.lat, lon: group.reading.lon }, photograph) >
    distanceMeters({ lat: furthest.reading.lat, lon: furthest.reading.lon }, photograph)
      ? group
      : furthest,
  );
  const fromOther = nearestTo(other.reading);
  const otherName = lowerFirst(spokenLabelList(other.labels));
  // Clearly nearer, not merely nearer: 100 m AND half the distance, so a phone's own margin cannot
  // decide it. Anything closer than that says so rather than picking a side.
  const clearlyNearer = (near: number, far: number): boolean => far - near > 100 && near <= far / 2;
  const standing = clearlyNearer(fromOther, fromPhotograph)
    ? ` — so what the rep saved later sits with ${otherName}, not with the photograph`
    : clearlyNearer(fromPhotograph, fromOther)
      ? ` — so what the rep saved later sits with the photograph, not with ${otherName}`
      : " — about as far from each, so the later visits settle nothing between them";
  return `${opening} and about ${formatDistance(fromOther)} from ${otherName}${standing}. ${cause}`;
}

/** An activity code as words — `sales_day` is not a sentence. */
function spokenActivity(value: string): string {
  return value.replace(/_/g, " ");
}

// ── What the reader is looking at ───────────────────────────────────────────────────────────────

/** The thing this case is about, in words: the venue's own name when there is one, else the customer. */
function subjectPhrase(input: CaseStoryInput): string {
  if (input.subjectLabel !== null && input.subjectLabel.trim() !== "") return input.subjectLabel;
  if (input.customerName !== "" && input.customerName !== "—") return `the place saved for ${input.customerName}`;
  return "the place";
}

/** The opening sentence: who captured what, and when, in the reader's own terms. */
function openingSentence(input: CaseStoryInput): string {
  const who = input.repName !== "" ? input.repName : "The rep";
  const listPart = input.customerList !== null && input.customerList !== "" ? ` on the ${input.customerList} list` : "";
  const specialityPart = input.customerSpeciality !== null && input.customerSpeciality !== "" ? ` (${input.customerSpeciality})` : "";
  if (input.subjectKind === "visit") {
    return `${who} saved a visit to ${input.customerName}${specialityPart}${listPart}.`;
  }
  if (input.subjectKind === "shared_place") {
    return `${who} captured the venue ${subjectPhrase(input)}.`;
  }
  if (input.subjectKind === "customer") {
    return `This is about ${input.customerName}${specialityPart}${listPart}, not about one capture.`;
  }
  // `subjectPhrase` already names the customer when the venue has no name of its own, so appending
  // the "for <customer>" clause printed the name twice — "the place saved for X for X", which is
  // the first thing a reader sees and the first reason the panel read as nonsense.
  const subject = subjectPhrase(input);
  const named = input.customerName !== "" && input.customerName !== "—";
  const forPart = named && !subject.includes(input.customerName) ? ` for ${input.customerName}` : "";
  return `${who} captured ${subject}${forPart}${specialityPart}${listPart}.`;
}

// ── One sentence per finding, and the ordinary reason for it ────────────────────────────────────

/** The location-reader probe's codes in words (location-reader-probe.ts); null when none were sent. */
const READER_FINDING_WORDS: Record<string, string> = {
  navigator_own_property: "the reader was set on the page itself",
  reader_not_engine_object: "the reader was not the browser's own object",
  method_own_property: "its functions were set on the page itself",
  method_not_engine_code: "its functions were not the browser's own code",
  position_not_engine_object: "the readings it handed back were not the browser's own",
};

function readerFindingWords(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const words = value.map((code) => (typeof code === "string" ? READER_FINDING_WORDS[code] : undefined)).filter((text): text is string => Boolean(text));
  return words.length === 0 ? null : words.join("; ");
}

/**
 * The measured fact for a flag, written with this case's own numbers.
 *
 * Null means "this module has nothing specific to say", and the caller then falls back to the label
 * the board already prints — which is always something, never a code.
 */
function flagFact(flag: string, input: CaseStoryInput): string | null {
  const signals = input.signals;
  const replay = asRecord(signals.replay);
  const travel = asRecord(signals.travel);
  const day = asRecord(signals.day);
  const coarse = asRecord(signals.coarse);
  const metresApart = asNumber(signals.metresApart);
  const gapSeconds = asNumber(signals.gapSeconds);

  switch (flag) {
    // ── The phone's own answer ──────────────────────────────────────────────────────────────────
    case "mock_provider":
      return "The phone itself reported that a mock-location app was active when the reading was taken.";
    case "location_reader_replaced": {
      const found = readerFindingWords(signals.readerFindings);
      return found === null
        ? "When this was saved, the browser's own location reader had been replaced by something on the page."
        : `When this was saved, the browser's own location reader had been replaced by something on the page: ${found}.`;
    }

    // ── Position, over this rep's own history ───────────────────────────────────────────────────
    case "coordinate_replay": {
      const minutes = asNumber(replay.minutesApart);
      const whose = input.replayByName !== null ? ` by ${input.replayByName}` : " earlier, by the same person";
      const when = minutes === null ? "" : ` about ${spokenGap(minutes * 60)} earlier`;
      return `This exact coordinate had already been recorded${whose}${when}.`;
    }
    case "impossible_travel": {
      const metres = asNumber(travel.meters);
      const minutes = asNumber(travel.minutes);
      const kmh = asNumber(travel.kmh);
      if (metres === null || minutes === null) return "The distance from the previous reading is further than the time between them allows.";
      return `The reading is ${formatDistance(metres)} from the previous one, ${spokenGap(minutes * 60)} earlier — about ${kmh ?? "?"} km/h.`;
    }
    case "zero_jitter": {
      const fixes = asNumber(day.fixes);
      const customers = asNumber(day.customers);
      const spread = asNumber(day.spreadMeters);
      const span = asNumber(day.spanMinutes);
      if (fixes === null || spread === null) return "Every reading of the day sits on the same point.";
      return `${fixes} readings that day${customers === null ? "" : `, across ${customers} customers`}${span === null ? "" : ` and ${spokenGap(span * 60)}`}, all sit within ${formatDistance(spread)} of each other.`;
    }
    case "constant_accuracy": {
      const accuracy = asNumber(signals.constantAccuracy);
      return accuracy === null
        ? "Every reading of the day reported exactly the same accuracy."
        : `Every reading of the day reported exactly ${accuracy} m of accuracy.`;
    }
    case "typed_coordinate":
      return "The coordinate is round to fewer decimal places than a measured reading carries.";
    case "coarse_location": {
      const accuracy = asNumber(coarse.accuracyMeters) ?? input.accuracyMeters;
      const threshold = asNumber(coarse.thresholdMeters);
      const measured = accuracy === null ? "The reading is too coarse to locate a doorway" : `The reading is accurate to about ${formatDistance(accuracy)}`;
      return `${measured}${threshold === null ? "" : `, past the ${formatDistance(threshold)} line`}, so the precision checks are not applied to it at all.`;
    }

    // ── The pin against the photograph's own reading ────────────────────────────────────────────
    case "photo_pin_identical":
      return "The pin saved for the place and the photograph's own reading are the same coordinate, to the last digit.";
    case "photo_pin_drifted":
      return metresApart === null
        ? "The pin and the photograph's own reading are further apart than one doorway."
        : `The pin and the photograph's own reading are ${formatDistance(metresApart)} apart — further than one doorway.`;
    case "photo_pin_disagrees":
      return metresApart === null
        ? "The pin and the photograph's own reading are in different places."
        : `The pin and the photograph's own reading are ${formatDistance(metresApart)} apart.`;
    case "photo_pin_gap_long": {
      if (gapSeconds === null) return "The photograph and the pin were taken a long way apart in time.";
      const order = gapSeconds < 0 ? "before" : "after";
      return `The photograph was taken ${spokenGap(gapSeconds)} ${order} the pin was saved.`;
    }

    // ── The signboard in the photograph ─────────────────────────────────────────────────────────
    case "sign_other_name": {
      const people = spokenList(asStrings(signals.personNames));
      const places = spokenList(asStrings(signals.placeNames));
      const read = people !== "" ? people : places;
      return read === ""
        ? `The sign in the photograph does not carry the name the list holds, ${input.customerName}.`
        : `The sign in the photograph reads ${read}; the list holds ${input.customerName}.`;
    }
    case "sign_no_name": {
      const note = typeof signals.note === "string" && signals.note.trim() !== "" ? ` The reading says: ${signals.note}` : "";
      return `No name could be read on the sign in the photograph.${note}`;
    }

    // ── The photograph itself ───────────────────────────────────────────────────────────────────
    case "photo_exact_duplicate": {
      const compared = asNumber(signals.comparedWith);
      return `The identical picture file had been sent before${compared === null ? "" : `, out of ${compared} compared`}.`;
    }
    case "photo_near_identical": {
      const compared = asNumber(signals.comparedWith);
      const nearest = asNumber(signals.nearestDistance);
      if (nearest === null) return "The picture is all but identical to one sent before.";
      return `The nearest of ${compared ?? "the"} pictures compared differs by ${nearest} of 64 points — all but the same picture.`;
    }

    // ── The day's own record ────────────────────────────────────────────────────────────────────
    case "visit_on_leave":
      return `The visit is dated ${input.visitDate ?? "a day"} and that day is recorded as approved full-day leave.`;
    case "visit_on_full_day_activity": {
      const activities = spokenList(asStrings(signals.awayActivities).map(spokenActivity));
      return activities === ""
        ? "The day is recorded as a full day away from the field."
        : `The day is recorded as ${activities} — a full day away from the field.`;
    }
    case "companion_off_duty": {
      const names = spokenList(input.companionNames);
      return names === ""
        ? "A colleague named on the visit was recorded off duty that day."
        : `${names} was named on the visit and was recorded off duty that day.`;
    }

    // ── How often ──────────────────────────────────────────────────────────────────────────────
    case "customer_revisited_fast": {
      const days = asStrings(signals.visitDays);
      const window = asNumber(signals.windowDays);
      return days.length === 0
        ? `${input.customerName} was called three times inside a week.`
        : `${input.customerName} was called on ${spokenList(days)} — ${days.length} calls inside ${window ?? 7} days.`;
    }

    // ── The visit against the photograph of its place (2026-10-13) ─────────────────────────────
    //
    // 🔴 BOTH SENTENCES PRINT THE FILED METRES, never a figure re-derived here. The pass measured
    // the visit against the photograph it actually chose — the nearest one captured before the
    // visit — and the panel must say the same number the detector judged, or a reader checking the
    // two coordinates by hand would find the sentence and the evidence disagreeing.
    case "visit_far_from_photo": {
      const metres = asNumber(signals.metresFromPhotograph);
      const far = asNumber(signals.farMeters);
      const line = far === null ? "" : ` — past the ${formatDistance(far)} the settings call far`;
      return metres === null
        ? "The visit was saved further from the photograph of the place than the settings call far."
        : `The visit was saved ${formatDistance(metres)} from the photograph taken at the place${line}.`;
    }
    case "visit_very_far_from_photo": {
      const metres = asNumber(signals.metresFromPhotograph);
      return metres === null
        ? "And more than a kilometre from it."
        : `That is ${formatDistance(metres)} — more than a kilometre from the door the picture was taken at.`;
    }

    // ── The brick ──────────────────────────────────────────────────────────────────────────────
    case "place_brick_far": {
      const km = asNumber(input.signals.brickDistanceKm) ?? input.brickDistanceKm;
      const brick = input.brickName !== null && input.brickName !== "" ? ` (${input.brickName})` : "";
      return km === null
        ? `The place sits outside the brick it is filed under${brick}.`
        : `The place sits ${formatDistance(km * 1000)} from the brick it is filed under${brick}.`;
    }

    default:
      return null;
  }
}

/**
 * The ordinary, innocent reason a finding looks like this.
 *
 * 🔴 EVERY FLAG HAS ONE, AND THAT IS THE POINT OF THE WHOLE MODULE. The reader is deciding whether a
 * reading needs a second look; a measurement with no ordinary explanation beside it reads as proof.
 */
function flagOrdinaryCause(flag: string): string | null {
  switch (flag) {
    case "mock_provider":
      return "Some handsets report this for a navigation or developer setting the person may not know is switched on.";
    case "location_reader_replaced":
      return "A browser add-on that blurs or blocks location for privacy replaces the reader in the same way, without moving anybody.";
    case "coordinate_replay":
      return "A phone that cannot get a fresh reading indoors commonly hands back the last one it held.";
    case "impossible_travel":
      return "A reading taken in a moving car, or one of the two being the phone's cached position, produces this.";
    case "zero_jitter":
      return "A phone left on an approximate reading repeats the same point all day, whatever the person does.";
    case "constant_accuracy":
      return "Indoor positioning from nearby networks reports one fixed figure rather than a measured one.";
    case "typed_coordinate":
      return "A phone that rounds what it reports, or a reading copied from a map, looks like this.";
    case "coarse_location":
      return "Android's approximate-location setting does exactly this, and it can be switched on for the whole phone.";
    case "photo_pin_identical":
      return "A one-tap capture takes one reading and uses it for both the pin and the picture, so this is the expected result there.";
    case "photo_pin_drifted":
      return "A picture taken at the door and the pin saved a few steps away gives this.";
    case "photo_pin_disagrees":
      return "One of the two readings being the phone's cached position explains most of these.";
    case "photo_pin_gap_long":
      return "A picture taken at the door and the pin saved from the car does this, and so does a form left open.";
    case "sign_other_name":
      return "A shared clinic, a building or landlord's sign, or a colleague's name on the same door all read like this.";
    case "sign_no_name":
      return "A tilted photograph, glare on the glass, or a sign in a script the reading could not take.";
    case "photo_exact_duplicate":
      return "The same picture sent twice from a form that was submitted twice gives this.";
    case "photo_near_identical":
      return "Two pictures of the same door minutes apart are all but identical, which is ordinary at one place.";
    case "visit_on_leave":
      return "Leave approved after the visit was saved, or a visit entered against the wrong day.";
    case "visit_on_full_day_activity":
      return "A day recorded as away that in fact held field work too, or a visit entered on the wrong day.";
    case "companion_off_duty":
      return "A colleague who came out on a day off, or a leave record entered later than the visit.";
    case "customer_revisited_fast":
      return "A repeat call to deliver something, or two people's calls filed under one name.";
    case "place_brick_far":
      return "A place near a boundary, or a brick list that has not caught up with where the person works.";
    case "visit_far_from_photo":
      return "A visit is saved where the phone is when the box is filled in — the car outside, the lift, or the next clinic along — which is not always the door.";
    case "visit_very_far_from_photo":
      return "A phone handing back the position it last held indoors, or a form filled in after the rep had moved on, reaches this on its own.";
    default:
      return null;
  }
}

/** Each finding as a sentence, falling back to the label the board already prints, then to its own words. */
export function integrityFlagSentence(flag: string, input: CaseStoryInput, labelled: string | null): string {
  const fact = flagFact(flag, input);
  if (fact !== null) return fact;
  if (labelled !== null && labelled !== "" && labelled !== flag) return `${labelled}.`;
  // A detector added to the table without a sentence here. Visible, in words, never as a code — and
  // it says plainly that the explanation is missing rather than pretending this is the explanation.
  return `${flag.replace(/_/g, " ")}. No plain-English note has been written for this finding yet; the measurements below are what was recorded.`;
}

// ── The story ──────────────────────────────────────────────────────────────────────────────────

/** The one-sentence fact for the row: the first finding, which is the strongest one filed. */
function headlineOf(input: CaseStoryInput, flagSentences: ReadonlyArray<string>): string {
  if (flagSentences.length > 0) return flagSentences[0]!;
  if (input.source === "capture_trust" && input.spreadMeters !== null) {
    return input.spreadMeters <= 0
      ? "The pin and the photograph are the same reading."
      : `The pin and the photograph are ${formatDistance(input.spreadMeters)} apart.`;
  }
  return `${integritySourceStoryLabel(input.source)} recorded something worth a second look, with no finding named.`;
}

/** The raw measurements, so the sentences can be checked rather than trusted. */
function evidenceOf(input: CaseStoryInput): CaseEvidence[] {
  const evidence: CaseEvidence[] = [];
  const push = (label: string, value: string | null): void => {
    if (value !== null && value !== "") evidence.push({ label, value });
  };

  // "Filed by" reads as a person, and the value is a check: "Filed by: Pin and photograph".
  push("What raised it", integritySourceStoryLabel(input.source));
  push("Strength", input.strong ? "Strong on its own" : "Corroborating only");
  // Two readings at the identical coordinate are ONE reading the panel printed twice under two
  // different names — three lines where two carried the same numbers, which is what made a
  // capture-trust case unreadable. Group them and say so on the one line.
  for (const group of groupReadings(input.readings)) {
    const reading = group.reading;
    const precision = reading.accuracyMeters === null ? ", accuracy not reported" : `, accurate to about ${formatDistance(reading.accuracyMeters)}`;
    const shared = group.labels.length > 1 ? " — one reading, under both names" : "";
    push(spokenLabelList(group.labels), `${reading.lat.toFixed(6)}, ${reading.lon.toFixed(6)}${precision}${shared}`);
  }
  if (input.spreadMeters !== null) {
    push("Furthest two readings apart", input.spreadMeters <= 0 ? "the same reading, to the bit" : formatDistance(input.spreadMeters));
  }
  if (input.placeDistanceMeters !== null) push("Saved from the place", formatDistance(input.placeDistanceMeters));
  // The anchor's own figure, as the detector filed it: the metres between the visit and the
  // photograph. Printed beside "Saved from the place" rather than instead of it — they are two
  // different readings, and on the 91 places whose kept point is the PIN they differ.
  const fromPhotograph = asNumber(input.signals.metresFromPhotograph);
  if (fromPhotograph !== null) push("From the photograph of the place", formatDistance(fromPhotograph));
  if (input.brickDistanceKm !== null) {
    push("From its brick", `${formatDistance(input.brickDistanceKm * 1000)}${input.brickName === null || input.brickName === "" ? "" : ` (${input.brickName})`}`);
  }
  const gapSeconds = asNumber(input.signals.gapSeconds);
  if (gapSeconds !== null) {
    push("Time between the pin and the picture", `${spokenGap(gapSeconds)} ${gapSeconds < 0 ? "(the picture first)" : "(the pin first)"}`);
  }
  if (input.deviceMocked !== null) push("Phone reported a mock location", input.deviceMocked ? "yes" : "no");
  push("Photograph kept", input.photoPath === null ? "none kept" : "yes");
  return evidence;
}

/**
 * The two locations the case is a comparison between.
 *
 * 🔴 THE VALIDATION SIDE PREFERS THE PHOTOGRAPH, NEVER THE PIN. The photograph saved for the place
 * is the anchor the owner ruled on (13 October 2026) and the pin is dropped from the judgement, so
 * where both exist the photograph is what the capture is shown against. The pin is still printed in
 * the measurements, so nothing is hidden — it simply is not the thing being compared.
 *
 * Null when there is nothing to compare: fewer than two distinct coordinates, which is every replay
 * case and any case whose readings all sit on one point.
 */
export function caseComparison(input: CaseStoryInput): CaseComparison | null {
  const find = (label: string): CaseStoryReading | null => input.readings.find((r) => r.label === label) ?? null;
  const capture =
    find(CASE_READING_LABELS.visitSaved) ?? find(CASE_READING_LABELS.placeCaptured) ?? input.readings[0] ?? null;
  if (capture === null) return null;
  const sameSpot = (a: CaseStoryReading, b: CaseStoryReading): boolean =>
    a.lat.toFixed(6) === b.lat.toFixed(6) && a.lon.toFixed(6) === b.lon.toFixed(6);
  const validation =
    [
      find(CASE_READING_LABELS.placePhotograph),
      find(CASE_READING_LABELS.photograph),
      find(CASE_READING_LABELS.placeOnList),
      find(CASE_READING_LABELS.pin),
      ...input.readings,
    ].find((reading): reading is CaseStoryReading => reading !== null && reading !== capture && !sameSpot(reading, capture)) ??
    null;
  if (validation === null) return null;
  const metres = distanceMeters({ lat: capture.lat, lon: capture.lon }, { lat: validation.lat, lon: validation.lon });
  const side = (reading: CaseStoryReading): CaseComparisonSide => ({
    label: reading.label,
    coordinates: `${reading.lat.toFixed(6)}, ${reading.lon.toFixed(6)}`,
    accuracy: reading.accuracyMeters === null ? null : `accurate to about ${formatDistance(reading.accuracyMeters)}`,
    at: reading.atIso,
  });
  return {
    capture: side(capture),
    validation: side(validation),
    apart: metres <= 0 ? "the same reading" : formatDistance(metres),
    apartMeters: metres <= 0 ? 0 : metres,
  };
}

/**
 * The whole story for one case: the headline for the row, the numbered points for the panel, the
 * two locations it compares, and the measurements behind all of it.
 */
export function caseStory(input: CaseStoryInput): CaseStory {
  const flagSentences = input.flags.map((flag, index) => integrityFlagSentence(flag, input, input.reasons[index] ?? null));
  const causes: string[] = [];
  for (const flag of input.flags) {
    const cause = flagOrdinaryCause(flag);
    if (cause !== null && !causes.includes(cause)) causes.push(cause);
  }

  // 🔴 POINT 1 IS WHAT HAPPENED, AND THE POINTS AFTER IT ARE WHY IT IS HERE. Nothing else gets a
  // point of its own: the two locations have their own panel above these points, the photograph is
  // on the screen where a line describing it was pure noise, and the measurements are one click
  // away. He asked for 1, 2, 3 — so five is the ceiling and four is the usual case.
  // Which of the readings is the odd one out, and where the customer's own visits stand against the
  // photograph — the anchor, with the pin dropped from the judgement (his instruction, 13 Oct 2026).
  const odd = oddReadingSentence(input);
  const visitStanding = visitsAgainstThePhotographSentence(input);
  // The ordinary innocent reason, on ONE line however many flags there are. It used to be a heading
  // plus a line per cause, which read as an accusation with a list of excuses under it.
  const usually = causes.length === 0 ? null : `Usually: ${spokenList(causes).replace(/, and /, " or ")}.`;
  // 🔴 A PHOTOGRAPH GETS NO POINT OF ITS OWN. Only its ABSENCE is worth words, because an empty
  // frame reads as a missing file rather than as the design: a one-tap visit keeps no picture at
  // all. The "as it was sent" line that used to sit here was wrong on the ninth detector too, where
  // the picture belongs to whoever validated the place and not to this rep.
  const noPhotograph = input.photoPath === null ? "No photograph was kept — a one-tap visit keeps none." : null;

  // 🔴 BUILT IN PRIORITY ORDER AND CAPPED, so the cap can never silently eat the ordinary cause —
  // which is the one line that keeps a reading from reading as an accusation. A case with four flags
  // prints the two strongest and the cause, never four findings and no explanation.
  const points: string[] = [openingSentence(input), ...flagSentences.slice(0, 2)];
  for (const line of [visitStanding, odd, usually, noPhotograph]) {
    if (line !== null && points.length < 5) points.push(line);
  }

  return {
    headline: headlineOf(input, flagSentences),
    story: points,
    comparison: caseComparison(input),
    evidence: evidenceOf(input),
  };
}
