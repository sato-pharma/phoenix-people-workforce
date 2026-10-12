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

import { formatDistance } from "@/lib/phoenix-crm/geo";

export type CaseStoryReading = {
  label: string;
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
  /** The paragraph, one sentence per line — what was captured, what was measured, what usually causes it. */
  story: string[];
  /** The raw measurements, so a reader can check the sentences rather than trust them. */
  evidence: CaseEvidence[];
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
  return `${who} captured ${subjectPhrase(input)} for ${input.customerName}${specialityPart}${listPart}.`;
}

// ── One sentence per finding, and the ordinary reason for it ────────────────────────────────────

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

  push("Filed by", integritySourceStoryLabel(input.source));
  push("Strength", input.strong ? "Strong on its own" : "Corroborating only");
  for (const reading of input.readings) {
    push(
      reading.label,
      `${reading.lat.toFixed(6)}, ${reading.lon.toFixed(6)}${reading.accuracyMeters === null ? ", accuracy not reported" : `, accurate to about ${formatDistance(reading.accuracyMeters)}`}`,
    );
  }
  if (input.spreadMeters !== null) {
    push("Furthest two readings apart", input.spreadMeters <= 0 ? "the same reading, to the bit" : formatDistance(input.spreadMeters));
  }
  if (input.placeDistanceMeters !== null) push("Saved from the place", formatDistance(input.placeDistanceMeters));
  if (input.brickDistanceKm !== null) {
    push("From its brick", `${formatDistance(input.brickDistanceKm * 1000)}${input.brickName === null || input.brickName === "" ? "" : ` (${input.brickName})`}`);
  }
  const gapSeconds = asNumber(input.signals.gapSeconds);
  if (gapSeconds !== null) {
    push("Between the pin and the picture", `${spokenGap(gapSeconds)} ${gapSeconds < 0 ? "(the picture first)" : "(the pin first)"}`);
  }
  if (input.deviceMocked !== null) push("Phone reported a mock location", input.deviceMocked ? "yes" : "no");
  push("Photograph kept", input.photoPath === null ? "none kept" : "yes");
  return evidence;
}

/**
 * The whole story for one case: the headline for the row, the paragraph for the panel, and the
 * measurements behind both.
 */
export function caseStory(input: CaseStoryInput): CaseStory {
  const flagSentences = input.flags.map((flag, index) => integrityFlagSentence(flag, input, input.reasons[index] ?? null));
  const causes: string[] = [];
  for (const flag of input.flags) {
    const cause = flagOrdinaryCause(flag);
    if (cause !== null && !causes.includes(cause)) causes.push(cause);
  }

  const story: string[] = [openingSentence(input), ...flagSentences];

  // A photograph is the one piece of evidence a reader can judge without any of the above, so the
  // paragraph says whether there is one. "None kept" is an ordinary answer: the one-tap visit keeps
  // no photograph at all, and a panel drawing an empty frame would read as a missing file.
  story.push(
    input.photoPath === null
      ? "No photograph is kept for this capture, so there is nothing to look at here — a one-tap visit keeps none by design."
      : "The photograph is below, as it was sent.",
  );

  if (causes.length > 0) {
    story.push(causes.length === 1 ? `Usually: ${causes[0]!}` : "Usually, one of these:");
    if (causes.length > 1) story.push(...causes);
  }

  // The last line is what he is actually deciding, and it is the same for every case: a reading, not
  // a conclusion. Nobody is told, and nothing happens to anybody, whichever way it goes.
  story.push(
    input.strong
      ? "This finding stands on its own, so it is worth a look. Settling it records that the look happened; nothing is sent to anybody either way."
      : "This finding only means something beside others, so on its own it is probably nothing. Settling it records that it was read; nothing is sent to anybody either way.",
  );

  return { headline: headlineOf(input, flagSentences), story, evidence: evidenceOf(input) };
}
