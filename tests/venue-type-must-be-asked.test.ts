import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_VENUE_TYPE,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  VENUE_TYPES,
  choiceRequiresDistributorCode,
  normalizeVenueType,
  parseVenueTypeChoice,
  venueTypeChoiceLabel,
  venueTypeIsAnswered,
} from "../src/lib/venues/venue-type.ts";

// A venue type nobody answered is not a pharmacy.
//
// The nursery picker shipped on 2026-08-23 at 10:09 Cairo (PR #2320) and it worked — but it came
// pre-selected on `Pharmacy`. `حضانه النيل` was registered through it at 15:31 the same day, five
// hours later, with that pre-selection untouched, and sat mistyped in production until the owner
// spotted it three days on. A question that is already answered on screen is not being asked.
//
// The admin registry form was worse: it posted no venue type at all, so `normalizeVenueType` filled
// in `pharmacy` server-side and nobody was ever presented with the question.
//
// So capture reads the same column two different ways on purpose, and that is the whole change:
//
//   normalizeVenueType   — READING a stored row. Absent means "written before the column existed",
//                          which really was a pharmacy. Must stay forgiving.
//   parseVenueTypeChoice — REGISTERING a venue now. Absent means unanswered, and every caller
//                          refuses rather than guessing.
//
// Losing this fails silently and looks like nothing: a nursery files as a pharmacy, gets an invented
// distributor code to satisfy the pharmacy rule, and that fabricated code then resolves `exact`
// forever in `source_of_sales_customer_map`.

const DIRECT_ORDER_SERVICE = "src/lib/direct-orders/service.ts";
const MARKETING_SERVICE = "src/lib/marketing-requests/service.ts";
const SUBMIT_FORM = "src/components/direct-orders/direct-order-submit-form.tsx";
const REGISTRY_MANAGER = "src/components/direct-orders/pharmacy-registry-manager.tsx";
const VALIDATION_WORKSPACE = "src/components/employee-portal/marketing-validation-workspace.tsx";

/** The three screens a venue can be registered from. */
const CAPTURE_SCREENS = [SUBMIT_FORM, REGISTRY_MANAGER, VALIDATION_WORKSPACE];

/** Source with comments stripped — a comment naming a call is not a call. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/** Every argument any surviving `normalizeVenueType(...)` call is applied to, in one file. */
function normalizeVenueTypeArguments(path: string): string[] {
  return [...code(path).matchAll(/normalizeVenueType\(([^()]*)\)/g)].map((match) => match[1].trim());
}

/**
 * The two readings diverge on exactly the inputs that matter, and agree everywhere else.
 *
 * Asserted side by side deliberately: the point is not that one of them returns null, it is that
 * the same value means two different things depending on whether it came out of the database or off
 * a form. A future session that "unifies" these two functions undoes the whole fix.
 */
function testAnUnansweredVenueTypeIsNotAPharmacy() {
  for (const input of [null, undefined, "", "  ", 7, {}, "hospital", "NURSERY_"]) {
    assert.equal(
      normalizeVenueType(input),
      "pharmacy",
      `${String(input)} must still READ as a pharmacy — an old row is not being asked anything`,
    );
    assert.equal(
      parseVenueTypeChoice(input),
      null,
      `${String(input)} must be unanswered at CAPTURE — silently filing it as a pharmacy is the bug`,
    );
  }

  // A real answer means the same thing on both paths, including the sloppy casing a form can send.
  for (const [input, expected] of [
    ["nursery", "nursery"],
    ["Nursery", "nursery"],
    ["  NURSERY  ", "nursery"],
    ["pharmacy", "pharmacy"],
    ["  Pharmacy", "pharmacy"],
  ] as const) {
    assert.equal(normalizeVenueType(input), expected);
    assert.equal(parseVenueTypeChoice(input), expected);
  }

  // The read fallback itself is untouched — this change narrows where it applies, not what it says.
  assert.equal(DEFAULT_VENUE_TYPE, "pharmacy");
}

/**
 * Unknown is not "yes".
 *
 * Demanding a distributor code before anyone has said what the venue is asks a nursery for a code it
 * can never have — which is exactly how `0000`, `0001000000` and `0001511111` came to exist.
 */
function testNothingIsDemandedOfAVenueNobodyHasNamed() {
  assert.equal(venueTypeIsAnswered(null), false);
  assert.equal(choiceRequiresDistributorCode(null), false);

  for (const venueType of VENUE_TYPES) {
    assert.equal(venueTypeIsAnswered(venueType), true);
  }
  assert.equal(choiceRequiresDistributorCode("pharmacy"), true);
  assert.equal(choiceRequiresDistributorCode("nursery"), false);

  // Owner's standing rule: never show a raw token, and never show a blank where a name belongs.
  const unanswered = venueTypeChoiceLabel(null);
  assert.ok(unanswered.trim().length > 0, "an unanswered venue still needs a word on screen");
  assert.ok(
    !(VENUE_TYPES as readonly string[]).includes(unanswered.toLowerCase()),
    "an unanswered venue must not be labelled as one of the answers",
  );
  assert.equal(venueTypeChoiceLabel("nursery"), "Nursery");
  assert.equal(venueTypeChoiceLabel("pharmacy"), "Pharmacy");
}

/** One sentence, so a rep meets the same words wherever they hit it. */
function testTheRefusalIsOneSentenceInOneVoice() {
  assert.match(VENUE_TYPE_UNANSWERED_MESSAGE, /pharmacy/i);
  assert.match(VENUE_TYPE_UNANSWERED_MESSAGE, /nursery/i);

  for (const screen of CAPTURE_SCREENS) {
    assert.match(
      code(screen),
      /VENUE_TYPE_UNANSWERED_MESSAGE/,
      `${screen} must refuse in the shared words, not invent its own`,
    );
  }
}

/**
 * No screen may pre-answer the question.
 *
 * This is the specific defect: the picker existed, was visible, and was already sitting on the wrong
 * answer. `null` is the only starting state that makes a rep look at it.
 */
function testEveryCapturePointStartsUnanswered() {
  for (const screen of [SUBMIT_FORM, REGISTRY_MANAGER]) {
    assert.match(
      code(screen),
      /useState<VenueTypeChoice>\(null\)/,
      `${screen} must open with no venue type selected`,
    );
  }

  assert.match(
    code(VALIDATION_WORKSPACE).slice(
      code(VALIDATION_WORKSPACE).indexOf("function newPharmacyLine"),
    ),
    /venueType: null,/,
    "a fresh marketing pharmacy line must open with no venue type selected",
  );

  for (const screen of CAPTURE_SCREENS) {
    const source = code(screen);
    assert.doesNotMatch(
      source,
      /useState[^\n]*\(\s*(?:DEFAULT_VENUE_TYPE|"pharmacy"|"nursery")\s*\)/,
      `${screen} must not pre-select an answer — a pre-selected picker is not a question`,
    );
    assert.doesNotMatch(
      source,
      /venueType: (?:DEFAULT_VENUE_TYPE|"pharmacy"|"nursery")/,
      `${screen} must not seed a venue type into a fresh row`,
    );
    // A screen that normalized its own state would fill the null back in before it ever posted.
    assert.doesNotMatch(
      source,
      /normalizeVenueType\(/,
      `${screen} captures, it does not read stored rows — normalizing here restores the default`,
    );
  }
}

/**
 * THE HEADLINE. A client can be bypassed; the server is the gate.
 *
 * Three functions create a venue — two in Direct Orders (the rep's form and the admin registry) and
 * one in marketing capture. All three must parse strictly and refuse, because the admin registry
 * proved a screen can simply omit the field and let the server invent the answer.
 */
function testEveryServerCreateSiteRefusesAnUnansweredType() {
  const directOrders = code(DIRECT_ORDER_SERVICE);
  const marketing = code(MARKETING_SERVICE);

  assert.equal(
    (directOrders.match(/parseVenueTypeChoice\(input\.venueType\)/g) ?? []).length,
    2,
    "both Direct Orders create sites must parse the venue type strictly",
  );
  assert.equal(
    (directOrders.match(/if \(!venueTypeIsAnswered\(venueTypeChoice\)\) badRequest\(VENUE_TYPE_UNANSWERED_MESSAGE\)/g) ?? []).length,
    2,
    "both Direct Orders create sites must refuse an unanswered venue type",
  );

  assert.match(
    marketing,
    /parseVenueTypeChoice\(inputPharmacy\.venueType\)/,
    "marketing capture must parse the venue type strictly",
  );
  assert.match(
    marketing,
    /if \(!venueTypeIsAnswered\(venueTypeChoice\)\) \{/,
    "marketing capture must refuse an unanswered venue type",
  );
}

/**
 * The other half, and the one a "cleanup" would take out.
 *
 * `normalizeVenueType` is still correct — for reading a stored column. Every surviving call must be
 * applied to a database row, never to capture input. Assert the shape rather than a count, so adding
 * a legitimate new read does not fail this and quietly teach the next session to delete it.
 */
function testNormalizeVenueTypeSurvivesOnlyOnTheReadPath() {
  for (const path of [DIRECT_ORDER_SERVICE, MARKETING_SERVICE]) {
    const args = normalizeVenueTypeArguments(path);
    assert.ok(args.length > 0, `${path} must still read a stored venue_type forgivingly`);
    for (const arg of args) {
      assert.match(
        arg,
        /\.venue_type$/,
        `${path}: normalizeVenueType(${arg}) reads capture input, not a stored row — use parseVenueTypeChoice`,
      );
    }
  }
}

export function runVenueTypeMustBeAskedTests() {
  testAnUnansweredVenueTypeIsNotAPharmacy();
  testNothingIsDemandedOfAVenueNobodyHasNamed();
  testTheRefusalIsOneSentenceInOneVoice();
  testEveryCapturePointStartsUnanswered();
  testEveryServerCreateSiteRefusesAnUnansweredType();
  testNormalizeVenueTypeSurvivesOnlyOnTheReadPath();
}
