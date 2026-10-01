// The agreed daily forecast, handed to WhatsApp with nothing left for the rep to type.
//
// WHAT THIS GUARDS, and neither is a formatting preference:
//
//   1. 🔴 THE SHARE URL CARRIES NO PHONE NUMBER. `wa.me/?text=` opens WhatsApp's PICKER, which is the
//      only way to reach a group — no WhatsApp product can address a group, so the rep choosing it is
//      the mechanism, not a shortcut. `wa.me/<digits>?text=` opens a chat with THAT PERSON instead, so
//      a number creeping into the URL would quietly send the whole line's forecast to one individual
//      and nobody would see it in the group.
//   2. 🔴 THE DAY IS NEVER PARSED AS A `Date`. The value is already a Cairo business day, so
//      `new Date("2026-10-01")` is UTC midnight and prints as 30 September for any reader west of the
//      meridian. A forecast labelled with yesterday's date, in the line's own group, is worse than no
//      label — and this is the standing timezone trap in this repo.
//
// It also pins that the button appears only once the forecast is RECORDED. Offering the share before
// the figures are sent would put a number in the group that Phoenix does not hold.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  composeForecastMessage,
  forecastDayLabel,
  forecastWhatsAppShareUrl,
} from "@/lib/phoenix-crm/forecast-whatsapp";

export function runPhoenixCrmForecastWhatsAppTests(): void {
  // ── The message ───────────────────────────────────────────────────────────────────────────────
  const message = composeForecastMessage({
    day: "2026-10-01",
    lines: [
      { productName: "Depakine Chrono 500", units: 12 },
      { productName: "Nothing today", units: 0 },
      { productName: "Tegretol CR 400", units: 3 },
    ],
    territoryName: "Cairo 1",
  });

  assert.match(message, /^Daily forecast — Cairo 1\n1 October 2026\n\n/, `the heading must name the territory and the day:\n${message}`);
  assert.match(message, /Depakine Chrono 500: 12/, "a product's own NAME and its boxes, never a code");
  assert.match(message, /Tegretol CR 400: 3/, "every product with boxes appears");
  assert.doesNotMatch(
    message,
    /Nothing today/,
    "a product with zero boxes must NOT appear — a list padded with zeroes is longer, harder to read on a phone, and says nothing",
  );
  assert.match(message, /\nTotal: 15 boxes$/, `the total is spelled out, because the group's question is always "how much altogether":\n${message}`);
  assert.doesNotMatch(message, /…|\.\.\./, "no ellipsis anywhere — the owner's standing rule");

  // One box reads "box", not "boxes". Small, but it is the line's own group reading it.
  assert.match(
    composeForecastMessage({ day: "2026-10-01", lines: [{ productName: "Tegretol CR 400", units: 1 }], territoryName: "Cairo 1" }),
    /Total: 1 box$/,
    "a single box must not read as boxes",
  );

  // Every figure zero still says something, in words.
  assert.match(
    composeForecastMessage({ day: "2026-10-01", lines: [{ productName: "Tegretol CR 400", units: 0 }], territoryName: "Cairo 1" }),
    /No boxes forecast today\.$/,
    "a forecast of nothing must say so, not arrive as a bare heading",
  );

  // ── The day label, which is where a timezone bug would hide ───────────────────────────────────
  assert.equal(forecastDayLabel("2026-10-01"), "1 October 2026");
  assert.equal(forecastDayLabel("2026-01-31"), "31 January 2026");
  assert.equal(forecastDayLabel("2026-12-09"), "9 December 2026");
  // 🔴 THE OFF-BY-ONE, STATED AS AN ASSERTION. Were the label built with `new Date(day)`, this would
  // read "30 September 2026" in any timezone west of UTC. If this line ever fails, the implementation
  // started parsing the string as a Date.
  assert.equal(
    forecastDayLabel("2026-10-01"),
    "1 October 2026",
    "the Cairo business day must be formatted from its PARTS — `new Date(\"2026-10-01\")` is UTC midnight and prints as the day before west of the meridian",
  );
  // A value that is not a plain day is returned untouched rather than mangled into a wrong date.
  assert.equal(forecastDayLabel("not a day"), "not a day");

  // ── The share URL ─────────────────────────────────────────────────────────────────────────────
  const url = forecastWhatsAppShareUrl(message);
  assert.ok(url.startsWith("https://wa.me/?text="), `the picker form, so the rep can choose the CNS group: ${url}`);
  assert.doesNotMatch(
    url,
    /wa\.me\/\d/,
    "🔴 a phone number in the share URL opens a chat with THAT PERSON instead of the group picker — the line's forecast would go to one individual",
  );
  assert.ok(url.includes(encodeURIComponent("Total: 15 boxes")), "the whole composed message must be in the link, or the rep still has to type");
  assert.doesNotMatch(url, /\n/, "the message must be percent-encoded, not carried raw with newlines");

  // ── Where the button is allowed to appear ─────────────────────────────────────────────────────
  const tab = readFileSync("src/components/phoenix-crm/forecast-tab.tsx", "utf8");
  const sentBlock = tab.indexOf("form.sentAt ?");
  const buttonAt = tab.indexOf("<ForecastWhatsAppButton");
  assert.ok(buttonAt > 0, "forecast-tab.tsx no longer renders the WhatsApp button at all");
  assert.ok(sentBlock > 0, "forecast-tab.tsx no longer branches on form.sentAt, so the button's gate is gone");
  assert.ok(
    buttonAt > sentBlock,
    "🔴 the WhatsApp share must stay INSIDE the already-sent branch. Offered before the figures are " +
      "recorded, it puts a number in the CNS group that Phoenix does not hold, and the two disagree.",
  );

  // 🔴 COMMENTS STRIPPED FIRST, and this caught itself: the component EXPLAINS that the organogram
  //    button carries `rounded-md`, so a raw text search matched its own prose and failed a file whose
  //    only corner class is `rounded-none`. A guard that reads documentation as code is a guard people
  //    delete, so it reads the CODE.
  const component = stripComments(readFileSync("src/components/phoenix-crm/forecast-whatsapp-button.tsx", "utf8"));
  assert.match(
    component,
    /rounded-none/,
    "the square-edge golden rule: this control is square, whatever the organogram's own WhatsApp button does",
  );
  assert.doesNotMatch(
    component,
    /rounded-(sm|md|lg|xl|full)/,
    "🔴 a rounded corner here breaks the square-edge golden rule — the organogram's button carries rounded-md and is not the model for corners",
  );
  assert.match(component, /<a\b/, "a real anchor, not a scripted window.open a popup blocker can swallow");
}
