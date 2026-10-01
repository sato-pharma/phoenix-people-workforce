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
  // Hager's real pre-filled day in Alex East, 1 October 2026, in the form's order (biggest share first).
  const message = composeForecastMessage({
    day: "2026-10-01",
    lines: [
      { productName: "Tebofortine Forte 80", family: "Tebofortin", units: 94 },
      { productName: "Tebofortine 40 mg", family: "Tebofortin", units: 71 },
      { productName: "Rispadex 3 mg UPA", family: "Rispadex", units: 34 },
      { productName: "Conviban 25 mg", family: "Conviban", units: 27 },
      { productName: "Rispadex 1mg Syp", family: "Rispadex", units: 15 },
      { productName: "Tebofortin 120 mg Intens", family: "Tebofortin", units: 11 },
      { productName: "Dolabactin", family: "Dolabactin", units: 10 },
      { productName: "Conviban 50 mg", family: "Conviban", units: 0 },
      { productName: "Dopaminect 1mg", family: "Dopaminict", units: 5 },
    ],
    territoryName: "Alex East",
  });

  // 🔴 UNITS PER CONCENTRATION, PER PRODUCT (owner, 2026-10-01) — and the whole message, exactly.
  assert.equal(
    message,
    [
      "Daily forecast — Alex East",
      "1 October 2026",
      "",
      "*Tebofortin*",
      "Tebofortine Forte 80: 94",
      "Tebofortine 40 mg: 71",
      "Tebofortin 120 mg Intens: 11",
      "",
      "*Rispadex*",
      "Rispadex 3 mg UPA: 34",
      "Rispadex 1mg Syp: 15",
      "",
      "Conviban 25 mg: 27",
      "",
      "Dolabactin: 10",
      "",
      "Dopaminect 1mg: 5",
    ].join("\n"),
    `each product a block, each concentration its own line with its own boxes, the biggest first:\n${message}`,
  );
  // 🔴 NEVER A TOTAL. The first version ended "Total: 319 boxes" — 94 Tebofortine Forte + 71
  // Tebofortine 40 + … + 1 Dopaminict — and the owner ruled it out: boxes of different products, and of
  // different concentrations of one product, are not the same quantity and are never added.
  assert.doesNotMatch(message, /total/i, "no total line of any kind — boxes of unlike products are never added");
  assert.doesNotMatch(message, /\b(176|49|267)\b/, "and no figure that is a sum of the lines above it (176 Tebofortin, 49 Rispadex, 267 altogether)");
  assert.doesNotMatch(message, /Conviban 50 mg/, "a concentration with zero boxes must NOT appear — a list padded with zeroes says nothing");
  assert.doesNotMatch(message, /\*(Conviban|Dolabactin|Dopaminict)\*/, "a product with ONE line today is that line alone — no heading repeating its own name");
  assert.doesNotMatch(message, /…|\.\.\./, "no ellipsis anywhere — the owner's standing rule");

  // A line the master gives no family still appears, as its own group.
  assert.match(
    composeForecastMessage({ day: "2026-10-01", lines: [{ productName: "Tegretol CR 400", units: 3 }], territoryName: "Cairo 1" }),
    /\n\nTegretol CR 400: 3$/,
    "a product with no family is listed under its own name",
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
  assert.ok(url.includes(encodeURIComponent("Dopaminect 1mg: 5")), "the whole composed message must be in the link, or the rep still has to type");
  assert.ok(url.endsWith(encodeURIComponent(message)), "and nothing is added to it on the way");
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

  assert.match(
    tab,
    /family: line\.productFamily/,
    "the button hands each product's family through, or the message cannot group concentrations under their product",
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
