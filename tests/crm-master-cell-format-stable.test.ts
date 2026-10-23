import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatDateOnly, formatDateTimeCairo, formatVendorLocal, formatVendorTimeOnly } from "../src/lib/crm/master-cell-format.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The portal CRM table (CrmMasterTable, a "use client" component) re-draws every cell on the phone,
 * and React compares it with the server's HTML. System Audit APP-69B45673: 11 hydration errors (#418,
 * text), 6 people, ALL on iPhones (Safari and Chrome), 16 Sep – 18 Oct 2026. The cell formatters
 * asked the platform for "6:13 PM" (WebKit puts U+202F before PM, Node 24 a plain space), for "Sept"
 * (an older engine says "Sep"), and for Cairo's offset (an older phone predates Egypt's 2023 return to
 * daylight saving). The record counts above the table used the phone's own number style.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// What the server printed before the fix — the platform formatters, exactly as they were.
const OLD = {
  dateOnlyUtc: new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }),
  dateCairo: new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }),
  timeCairo: new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "Africa/Cairo" }),
  timeUtc: new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "UTC" }),
};
const plain = (text: string) => text.replace(/[  ]/g, " ");

type Formatters = {
  formatDateOnly: (value: unknown) => string;
  formatDateTimeCairo: (value: unknown) => string;
  formatVendorLocal: (value: unknown) => string;
  formatVendorTimeOnly: (value: unknown) => string;
};

/** Every way the four formatters differ from the server's old text, over every hour of 2026 (both
 *  daylight-saving changes included) at minute 7. Empty = byte-identical. */
export function differencesFromServerText(f: Formatters): string[] {
  const out: string[] = [];
  for (let at = Date.UTC(2026, 0, 1, 0, 7); at < Date.UTC(2027, 0, 1); at += 3_600_000) {
    const iso = new Date(at).toISOString();
    const date = new Date(at);
    const expected = {
      formatDateOnly: plain(OLD.dateOnlyUtc.format(date)),
      formatDateTimeCairo: plain(`${OLD.dateCairo.format(date)}, ${OLD.timeCairo.format(date)}`),
      formatVendorLocal: plain(`${OLD.dateOnlyUtc.format(date)}, ${OLD.timeUtc.format(date)}`),
      formatVendorTimeOnly: plain(OLD.timeUtc.format(date)),
    };
    for (const name of Object.keys(expected) as Array<keyof Formatters>) {
      const got = f[name](iso);
      if (got !== expected[name]) out.push(`${name}(${iso}) = ${JSON.stringify(got)}, server printed ${JSON.stringify(expected[name])}`);
    }
    if (out.length > 5) break;
  }
  return out;
}

/** An Intl that answers like an older iPhone: U+202F before AM/PM, "Sep" not "Sept". */
function installIphoneLikeIntl(): () => void {
  const Real = Intl.DateTimeFormat;
  const swap = (text: string) => text.replace(/ (AM|PM)/g, " $1").replace(/\bSept\b/g, "Sep");
  (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function IphoneLike(locale?: string, options?: Intl.DateTimeFormatOptions) {
    const inner = new Real(locale, options);
    return {
      format: (d: Date) => swap(inner.format(d)),
      formatToParts: (d: Date) => {
        const parts = inner.formatToParts(d);
        return parts.map((part, i) => {
          if (part.type === "month") return { ...part, value: swap(part.value) };
          if (part.type === "literal" && parts[i + 1]?.type === "dayPeriod") return { ...part, value: " " };
          return part;
        });
      },
      resolvedOptions: () => inner.resolvedOptions(),
    };
  } as unknown as typeof Intl.DateTimeFormat;
  return () => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Real;
  };
}

export async function runCrmMasterCellFormatStableTests() {
  // (a) Nothing on screen or in the export changes: byte-identical to the server's old text.
  const live = { formatDateOnly, formatDateTimeCairo, formatVendorLocal, formatVendorTimeOnly };
  assert.deepEqual(differencesFromServerText(live), [], "the CRM cells read exactly as the server printed them before");
  assert.equal(formatVendorLocal("2026-09-16T18:13:00Z"), "16 Sept 2026, 6:13 PM", "the vendor wall clock is printed unshifted");
  assert.equal(formatDateTimeCairo("2026-07-11T13:59:00Z"), "11 Jul 2026, 4:59 PM", "a recorded UTC instant reads in Cairo summer time");
  assert.equal(formatVendorLocal("not a date"), "not a date", "an unreadable value is shown as it is");

  // (b) The phone's answers cannot move the text. The module is loaded fresh under an iPhone-like Intl.
  const restore = installIphoneLikeIntl();
  let onIphone: Formatters;
  try {
    onIphone = (await import(`../src/lib/crm/master-cell-format.ts?iphone=${Date.now()}`)) as Formatters;
    assert.deepEqual(differencesFromServerText(onIphone), [], "on an iPhone-like engine the CRM cells still read exactly as the server printed them");
  } finally {
    restore();
  }

  // (c) The record counts above the table are written en-US, never in the phone's own number style.
  const table = stripComments(fs.readFileSync(path.join(REPO_ROOT, "src/components/crm/crm-master-table.tsx"), "utf8"));
  const bare = table.match(/\.toLocale(?:String|DateString|TimeString)\(\s*\)/g) ?? [];
  assert.equal(bare.length, 0, `the CRM table writes its counts en-US — ${bare.length} locale-less call(s) write the reader's style (an Arabic phone: "١٬٢٣٤")`);
}
