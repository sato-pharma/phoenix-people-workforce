import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cairoDateTime, stableEnGbFormatter } from "../src/lib/format/cairo-datetime.ts";
import { cairoOffsetMinutes } from "../src/lib/format/cairo-zone.ts";
import { CAIRO_ZONE_TRANSITIONS } from "../src/lib/format/cairo-zone-transitions.ts";
import { stableCurrencyFormatter } from "../src/lib/format/stable-currency.ts";
import { stripComments } from "./support/comment-strip.ts";

// The SECOND axis of React hydration error #418, and the one that outlived every fix aimed at the
// first.
//
// react-418-hydration-safe-text.test.ts pins the LOCALE data: CLDR renamed en-GB's abbreviated
// September, so the month names now ship with the code. That closed the error for everybody except
// one reader, who kept throwing it on the two pages she uses for eight more days.
//
// Her axis is the ZONE data. Egypt abolished daylight saving in 2014 and BROUGHT IT BACK IN 2023,
// and Intl.DateTimeFormat answers timeZone "Africa/Cairo" from whatever timezone tables the engine
// was built with. Samsung Internet 20 is Chrome 106, built September 2022, so it puts Cairo at
// UTC+2 all year; the server knows Egypt is on UTC+3 from late April to late October. The same
// instant renders 14:47 on the server and 13:47 on her phone — one digit, in a text node a client
// component renders twice, which is exactly #418.
//
// Measured on production 2026-09-11: 20 events, one person, every other #418 on the platform
// already silent. She was also being shown times an hour wrong, which is the half of this that
// matters even to somebody who does not care about the error.
//
// So the offset ships with the code, like the month names, and the formatter reads the digits off
// in UTC — the one zone with no rules for two engines to disagree about.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
const codeOnly = (source: string) =>
  stripComments(source);

/** Egypt's offset as the engine running this test believes it to be. */
function engineOffsetMinutes(value: Date): number {
  const parts: Record<string, number> = {};
  const reader = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  for (const part of reader.formatToParts(value)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - value.getTime()) / 60000);
}

export function runCairoZoneOffsetTests() {
  // 1. The table says what Egypt actually does.
  assert.equal(
    cairoOffsetMinutes(new Date("2026-09-10T11:47:54.000Z")),
    180,
    "September is inside Egypt's summer time — Cairo is UTC+3, and this is the exact instant from the production event that found this bug",
  );
  assert.equal(
    cairoOffsetMinutes(new Date("2026-01-10T11:47:54.000Z")),
    120,
    "January is outside it — Cairo is UTC+2",
  );
  assert.equal(
    cairoOffsetMinutes(new Date("2021-07-01T00:00:00.000Z")),
    120,
    "Egypt had NO daylight saving between 2014 and 2023, which is why a browser built in 2022 is wrong only for the modern half of the data",
  );

  // 2. What the stale engine would have rendered, so this test explains itself.
  //
  // Not a simulation of her phone — a statement of the arithmetic. A pre-2023 engine computes Cairo
  // as a flat +2, which is what Etc/GMT-2 is.
  const event = new Date("2026-09-10T11:47:54.000Z");
  const staleEngine = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "Etc/GMT-2",
  }).format(event);
  assert.equal(staleEngine, "13:47", "a flat +2 engine renders 13:47");
  assert.ok(
    cairoDateTime(event.toISOString()).endsWith("14:47"),
    "the app must render the Cairo wall clock, 14:47, whatever the engine believes (got " +
      cairoDateTime(event.toISOString()) +
      ")",
  );

  // 3. Nothing on screen moved for a reader on a CURRENT engine.
  //
  // The whole point is that an old engine converges on the server's string, not that the string
  // changes. Swept hour by hour across 2023-2027, which spans nine daylight-saving transitions,
  // plus each transition to the minute on either side. Offenders are collected rather than asserted
  // one at a time: the first failed assert ends the test, so a bare assert inside the loop would
  // report the first difference and hide how wide the change was.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  const engineReader = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  const engineRendered = (value: Date) => {
    const parts: Record<string, string> = {};
    for (const part of engineReader.formatToParts(value)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return (
      parts.day + " " + MONTHS[Number(parts.month) - 1] + " " + parts.year + " · " + parts.hour + ":" + parts.minute
    );
  };

  const drift: string[] = [];
  const instants: Date[] = [];
  for (let at = Date.UTC(2023, 0, 1); at <= Date.UTC(2027, 11, 31); at += 3600000) instants.push(new Date(at));
  for (const [at] of CAIRO_ZONE_TRANSITIONS) {
    for (const delta of [-60000, -1, 0, 1, 60000]) instants.push(new Date(at + delta));
  }
  for (const value of instants) {
    const table = cairoDateTime(value.toISOString());
    const engine = engineRendered(value);
    if (table !== engine && drift.length < 10) {
      drift.push(value.toISOString() + ": table " + table + " vs engine " + engine);
    }
  }
  assert.deepEqual(
    drift,
    [],
    "the shipped table must agree with a CURRENT engine's own Africa/Cairo data, or this change moved what people see:\n  " +
      drift.join("\n  ") +
      "\nIf Egypt has changed the rule, regenerate with node scripts/generate-cairo-zone-transitions.mjs on an up-to-date Node.",
  );

  // 4. The table is still current.
  //
  // Narrowed to this year and its neighbours on purpose. A future decree lands in tzdata before it
  // lands here, and this is the check that says so — but only for the years anybody is looking at,
  // so a far-future tzdata refinement cannot redden CI over a date nothing renders.
  const thisYear = new Date().getUTCFullYear();
  const stale: string[] = [];
  for (let year = thisYear - 1; year <= thisYear + 1; year++) {
    for (let month = 0; month < 12; month++) {
      const probe = new Date(Date.UTC(year, month, 15, 12, 0, 0));
      const mine = cairoOffsetMinutes(probe);
      const theirs = engineOffsetMinutes(probe);
      if (mine !== theirs) stale.push(probe.toISOString() + ": table " + mine + " vs engine " + theirs);
    }
  }
  assert.deepEqual(
    stale,
    [],
    "src/lib/format/cairo-zone-transitions.ts disagrees with this engine's timezone data for the years in use — Egypt has probably changed the rule. Regenerate: node scripts/generate-cairo-zone-transitions.mjs\n  " +
      stale.join("\n  "),
  );

  // 5. The formatter must not ask the engine for Cairo at all.
  //
  // The behaviour above is only stable because the code path never names the zone. A future edit
  // that "simplifies" this back to timeZone "Africa/Cairo" would pass every check above on a
  // current engine — which is precisely the shape of the bug, since the server always had it right.
  const formatter = codeOnly(read("src/lib/format/cairo-datetime.ts"));
  assert.ok(
    !formatter.includes("Africa/Cairo"),
    "src/lib/format/cairo-datetime.ts must not name Africa/Cairo — the offset comes from cairo-zone.ts so that two engines cannot disagree about it. A current engine cannot detect this regression; only a reader on an old one can.",
  );

  // A Cairo-zoned caller of the generic helper must still get Cairo, through the same table.
  assert.equal(
    stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(
      new Date("2026-08-31T22:00:00.000Z"),
    ),
    "01 Sept 2026",
    "22:00 UTC on 31 August is already 1 September in Cairo at UTC+3 — the generic helper must route Cairo through the table too",
  );
  assert.equal(
    stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(
      new Date("2026-08-31T22:00:00.000Z"),
    ),
    "31 Aug 2026",
    "every other zone is passed through untouched — dragging a date-only value to Cairo is what shifts its calendar day",
  );

  // 6. Money: the same disease one axis over.
  //
  // style "currency" with a currency CODE separates it from the digits with U+00A0 on current
  // locale data and a plain U+0020 on older builds. Invisible, and still a text node. Her second
  // route, /employee-portals/team-performance, is this one.
  const money = stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(1234567);
  assert.ok(
    !/[\u00a0\u202f]/.test(money),
    "a client-rendered currency must carry no engine-chosen space (got " + JSON.stringify(money) + ")",
  );
  assert.equal(
    money.replace(/\s/g, " "),
    new Intl.NumberFormat("en-US", { currency: "EGP", maximumFractionDigits: 0, style: "currency" })
      .format(1234567)
      .replace(/\s/g, " "),
    "nothing but the space character may differ from what the platform renders today",
  );

  // 7. Repo-wide: no client component formats money through raw Intl.
  //
  // Server-rendered money is fine — text rendered once is never compared against a second
  // rendering. This sweep is the client half only, and it is what stops the next one being written.
  const offenders: string[] = [];
  const walk = (relativeDir: string) => {
    const absolute = path.join(REPO_ROOT, relativeDir);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("_wt-") || entry.name === ".next") continue;
        walk(relative);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(entry.name)) continue;
      const source = read(relative);
      if (!source.split("\n").slice(0, 5).join("\n").includes("use client")) continue;
      const body = codeOnly(source);
      if (!body.includes('style: "currency"')) continue;
      for (const call of body.matchAll(/new Intl\.NumberFormat\([\s\S]{0,400}?\)/g)) {
        if (call[0].includes('style: "currency"')) offenders.push(relative.replace(/\\/g, "/"));
      }
    }
  };
  walk("src");
  walk("app");
  const uniqueOffenders = [...new Set(offenders)];
  assert.deepEqual(
    uniqueOffenders,
    [],
    "these client components format money straight through Intl, so the separator between the currency code and the digits is whichever one the reader's browser was shipped with — React hydration error #418:\n  " +
      uniqueOffenders.join("\n  ") +
      "\nUse stableCurrencyFormatter from @/lib/format/stable-currency.",
  );
}
