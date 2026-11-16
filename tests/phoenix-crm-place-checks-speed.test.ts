import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatPhoenixDateTime, formatPhoenixLongDate, formatPhoenixMonth, formatPhoenixTime } from "../src/lib/i18n/format.ts";
import {
  REVIEW_SUBJECTS_SELECT,
  SIGNBOARD_CHECK_KEYS_SELECT,
  SIGNBOARD_KEYS_THE_BOARD_READS,
  signboardCheckRead,
} from "../src/lib/phoenix-crm/place-checks-slim-read.ts";
import { signboardHoldStillReading, signboardReadsRecorded, signboardRetakeWaiting } from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — Place checks reads only what it draws, in as few requests as it can, and stamps its
 * rows with formatters it builds once (owner, 16 Nov 2026: "fix the place checks slowness").
 *
 * Measured against production as the SFE Manager before the change: the page's reads took 7.3 s together
 * — the places in use 16.2 MB in 12 requests, every decision 6.4 MB in 34 — and building a date
 * formatter for every stamp cost 2.2 s of the server's time per page. Three changes, each of which a
 * tidy-up can quietly undo, so each is pinned here:
 *
 *   1. THE SIGNBOARD COLUMN BY ITS KEYS. Both reads ask for the six keys of `signboard_check` the board
 *      reads, never the whole column (7.7 of the 18 MB). A narrowed read disarms every reader downstream
 *      of it — a key a reader starts using would read as absent and nothing would go red — so the list
 *      is held against every reader: the ones in signboard-rules.ts by WATCHING which keys they touch,
 *      and `signboardOf` by the keys its body reads.
 *   2. THE DECISIONS' CUSTOMERS AND PLACES COME JOINED. PostgREST joins them into each review over the
 *      two named foreign keys, so the ~30 lookups by id after the pages are gone; every decision's pages
 *      are asked for together.
 *   3. THE CAIRO DATE FORMATTERS ARE BUILT ONCE. Counted by wrapping `Intl.DateTimeFormat` itself.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  // Read at call time, never at module load, so a break test sees the edited file.
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

/** One exported function's text, comments stripped: from its declaration to the next top-level export. */
function exportedFunction(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is still in validation-reviews.ts`);
  const end = source.indexOf("\nexport ", start + declaration.length);
  return source.slice(start, end < 0 ? undefined : end);
}

/**
 * The argument of every `.select(` call in a function's text, read to its matching `)` with string
 * literals tracked — a pattern that hops from one string's closing quote to the next one's opening quote
 * would read the code between them (`place.signboard_check`) as part of a select.
 */
function selectArguments(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\.select\(/g)) {
    let depth = 0;
    let quote: string | null = null;
    const open = match.index! + match[0].length - 1;
    for (let index = open; index < body.length; index += 1) {
      const character = body[index];
      if (quote) {
        if (character === "\\") index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) {
        found.push(body.slice(open + 1, index));
        break;
      }
    }
  }
  return found;
}

/** The aliased keys a select fragment asks for, as PostgREST reads it: `alias:signboard_check->key`. */
function aliasedSignboardKeys(select: string): Array<{ alias: string; key: string }> {
  return [...select.matchAll(/(\w+):signboard_check->(\w+)/g)].map((match) => ({ alias: match[1]!, key: match[2]! }));
}

/** A stored check carrying every key the reader writes, the heavy ones included. */
function fullCheck(attempts: number | undefined): Record<string, unknown> {
  return {
    verdict: "other_name",
    problem: "far",
    reason: "other_name",
    signText: "صيدلية النور",
    retake: { advice: "Stand across the street and take the whole sign.", problem: "cut_off", requestedAt: "2026-11-15T08:00:00.000Z" },
    ...(attempts === undefined ? {} : { attempts }),
    signs: Array.from({ length: 12 }, (_, index) => ({ text: `sign ${index}`, clarity: "clear", box: [index, index, 10, 10] })),
    note: "The reader's long note about every sign in the frame.".repeat(20),
    personNames: ["Dr Ahmed"],
    placeNames: ["El Nour"],
    checkedAt: "2026-11-15T07:59:00.000Z",
    strongRead: true,
  };
}

/** What PostgREST answers for one place under `SIGNBOARD_CHECK_KEYS_SELECT`: each alias, the key's value or null. */
function asReadBySlimSelect(stored: Record<string, unknown> | null): Record<string, unknown> {
  const row: Record<string, unknown> = { id: "place-1" };
  for (const { alias, key } of aliasedSignboardKeys(SIGNBOARD_CHECK_KEYS_SELECT)) row[alias] = stored && key in stored ? stored[key] : null;
  return row;
}

function checkTheSelectAsksForEveryKeyOnTheList() {
  const asked = aliasedSignboardKeys(SIGNBOARD_CHECK_KEYS_SELECT);
  assert.deepEqual(
    asked.map((pair) => pair.key),
    [...SIGNBOARD_KEYS_THE_BOARD_READS],
    "the select asks for exactly the keys on the list, one aliased column each",
  );
  assert.equal(new Set(asked.map((pair) => pair.alias)).size, asked.length, "and no two keys share an alias");
  assert.doesNotMatch(SIGNBOARD_CHECK_KEYS_SELECT, /\bsignboard_check\b(?!->)/, "and never the whole column");
}

function checkTheSlimRowReadsAsTheWholeColumnDid() {
  for (const attempts of [undefined, 1, 2, 3]) {
    const full = fullCheck(attempts);
    const slim = signboardCheckRead(asReadBySlimSelect(full));
    assert.ok(slim, "a stored check comes back as a check");
    assert.equal("signs" in slim, false, "without the signs it never needed");
    assert.equal("note" in slim, false, "or the reader's note");
    assert.deepEqual(signboardRetakeWaiting(slim), signboardRetakeWaiting(full), "the retake request reads the same");
    assert.equal(signboardReadsRecorded(slim), signboardReadsRecorded(full), `the reads recorded are the same (attempts ${attempts})`);
    for (const pending of [true, false]) {
      assert.equal(
        signboardHoldStillReading({ pending, signboardHold: true, isTest: false, stored: slim }),
        signboardHoldStillReading({ pending, signboardHold: true, isTest: false, stored: full }),
        "and the hold reads as still being read exactly when it did",
      );
    }
    for (const key of SIGNBOARD_KEYS_THE_BOARD_READS) {
      assert.deepEqual(slim[key], full[key], `${key} comes back as stored`);
    }
  }
  assert.equal(signboardCheckRead(asReadBySlimSelect(null)), null, "a place never read is still no check at all");
  assert.equal(signboardReadsRecorded(signboardCheckRead(asReadBySlimSelect(null))), signboardReadsRecorded(null));
}

function checkEveryReaderInSignboardRulesTouchesOnlyListedKeys() {
  const touched = new Set<string>();
  // Several shapes, keys missing included: a reader that falls back to another key when one is absent
  // (`attempts ?? …`) only shows that key on a check that lacks the first.
  const withoutRetake = Object.fromEntries(Object.entries(fullCheck(2)).filter(([key]) => key !== "retake"));
  const shapes: Array<Record<string, unknown>> = [fullCheck(1), fullCheck(undefined), withoutRetake, { ...fullCheck(3), retake: { problem: "cut_off" } }, { verdict: "match" }];
  for (const shape of shapes) {
    const watched = new Proxy(shape, {
      get(target, key, receiver) {
        if (typeof key === "string") touched.add(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        if (typeof key === "string") touched.add(key);
        return Reflect.has(target, key);
      },
    });
    signboardRetakeWaiting(watched);
    signboardReadsRecorded(watched);
    for (const pending of [true, false]) signboardHoldStillReading({ pending, signboardHold: true, isTest: false, stored: watched });
  }
  assert.ok(touched.size > 0, "the readers were watched reading the check");
  const listed = new Set<string>(SIGNBOARD_KEYS_THE_BOARD_READS);
  for (const key of touched) {
    assert.ok(listed.has(key), `a signboard reader reads "${key}", which the Place checks select does not ask for — add it to SIGNBOARD_KEYS_THE_BOARD_READS`);
  }
}

function checkSignboardOfReadsOnlyListedKeys() {
  const source = stripComments(read("src/lib/phoenix-crm/server/validation-reviews.ts"));
  const body = exportedFunction(source, "export function signboardOf(");
  const keys = [...body.matchAll(/\bcheck\.(\w+)/g)].map((match) => match[1]!);
  assert.ok(keys.length >= 4, "signboardOf's reads of the check were found");
  const listed = new Set<string>(SIGNBOARD_KEYS_THE_BOARD_READS);
  for (const key of keys) {
    assert.ok(listed.has(key), `signboardOf reads "${key}", which the Place checks select does not ask for — add it to SIGNBOARD_KEYS_THE_BOARD_READS`);
  }
}

function checkNeitherReadDownloadsTheWholeColumn() {
  const source = stripComments(read("src/lib/phoenix-crm/server/validation-reviews.ts"));
  const wholeColumn = /\bsignboard_check\b(?!->)/;
  const places = exportedFunction(source, "export async function loadValidatedPlaces(");
  const placeSelects = selectArguments(places);
  assert.ok(placeSelects.length >= 1, "the places-in-use select was found");
  for (const select of placeSelects) assert.doesNotMatch(select, wholeColumn, "the places in use never ask for the whole signboard column");
  assert.ok(placeSelects.some((select) => select.includes("${SIGNBOARD_CHECK_KEYS_SELECT}")), "they ask for its keys");
  assert.ok(places.includes("signboardOf(signboardCheckRead(row))"), "and read the signboard from those keys");
  const reviews = exportedFunction(source, "export async function loadValidationReviews(");
  const reviewSelects = selectArguments(reviews);
  assert.ok(reviewSelects.length >= 1, "the decisions' select was found");
  for (const select of reviewSelects) assert.doesNotMatch(select, wholeColumn, "the decisions never ask for the whole signboard column either");
  assert.doesNotMatch(REVIEW_SUBJECTS_SELECT, /\bsignboard_check\b(?!->)/, "nor does the place joined into each decision");
  assert.ok(REVIEW_SUBJECTS_SELECT.includes(SIGNBOARD_CHECK_KEYS_SELECT), "which carries the signboard by its keys");
}

function checkTheDecisionsComeJoinedAndTogether() {
  assert.match(REVIEW_SUBJECTS_SELECT, /phoenix_crm_customers!phoenix_crm_validation_reviews_customer_id_fkey\(/, "the customer joins over its named key");
  assert.match(REVIEW_SUBJECTS_SELECT, /phoenix_crm_places!phoenix_crm_validation_reviews_place_id_fkey\(/, "and so does the place");
  for (const column of ["name", "list_type", "speciality", "status", "photo_path", "shared_place_id", "pin_accuracy_meters", "photo_accuracy_meters"]) {
    assert.match(REVIEW_SUBJECTS_SELECT, new RegExp(`\\b${column}\\b`), `the joins carry ${column}, which the board draws`);
  }
  const source = stripComments(read("src/lib/phoenix-crm/server/validation-reviews.ts"));
  const reviews = exportedFunction(source, "export async function loadValidationReviews(");
  assert.ok(reviews.includes("${REVIEW_SUBJECTS_SELECT}"), "the review read asks for the joins");
  assert.doesNotMatch(reviews, /selectByIds/, "so no customer or place is looked up by id after the pages");
  const waves = reviews.match(/concurrentPages:\s*options\.everyDecision\s*\?\s*(\d+)/);
  assert.ok(waves && Number(waves[1]) >= 2, "every decision's pages are asked for together, not one after another");
}

function checkTheCairoFormattersAreBuiltOnce() {
  const instant = new Date("2026-10-17T09:15:00.000Z");
  const real = Intl.DateTimeFormat;
  let built = 0;
  const counting = new Proxy(real, {
    construct(target, args, newTarget) {
      built += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  const stamps: string[] = [];
  Object.defineProperty(Intl, "DateTimeFormat", { value: counting, configurable: true, writable: true });
  try {
    for (let index = 0; index < 50; index += 1) {
      stamps.push(formatPhoenixDateTime(instant), formatPhoenixLongDate(instant), formatPhoenixMonth(instant), formatPhoenixTime(instant));
    }
  } finally {
    Object.defineProperty(Intl, "DateTimeFormat", { value: real, configurable: true, writable: true });
  }
  assert.ok(built <= 3, `two hundred stamps built ${built} formatters — they are built once each, never per stamp`);
  assert.equal(stamps[0], "12:15 PM, Saturday, 17 October 2026", "and the stamp is still the owner's exact wording, in Cairo");
  assert.equal(stamps[1], "Saturday, 17 October 2026");
  assert.equal(stamps[2], "October 2026");
  assert.equal(stamps[3], "12:15 PM");
  assert.equal(new Set(stamps.filter((_, index) => index % 4 === 0)).size, 1, "every call answers the same");
}

export function runPhoenixCrmPlaceChecksSpeedTests() {
  checkTheSelectAsksForEveryKeyOnTheList();
  checkTheSlimRowReadsAsTheWholeColumnDid();
  checkEveryReaderInSignboardRulesTouchesOnlyListedKeys();
  checkSignboardOfReadsOnlyListedKeys();
  checkNeitherReadDownloadsTheWholeColumn();
  checkTheDecisionsComeJoinedAndTogether();
  checkTheCairoFormattersAreBuiltOnce();
}
