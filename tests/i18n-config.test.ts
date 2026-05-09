import assert from "node:assert/strict";
import {
  defaultIntlLocale,
  localeDirection,
  resolveLocale,
} from "../src/lib/i18n/config.ts";
import {
  formatCurrencyValue,
  formatDateValue,
  formatDateTimeValue,
  formatNumberValue,
} from "../src/lib/i18n/format.ts";

export function runI18nConfigTests() {
  assert.equal(resolveLocale("ar"), "ar");
  assert.equal(resolveLocale("ar-EG"), "ar");

  assert.equal(resolveLocale("fr"), "en");
  assert.equal(resolveLocale(null), "en");

  assert.equal(localeDirection("ar"), "rtl");
  assert.equal(localeDirection("en"), "ltr");

  assert.equal(defaultIntlLocale("ar"), "ar-EG");
  assert.equal(defaultIntlLocale("en"), "en-EG");

  assert.match(formatCurrencyValue(1250), /EGP|ج\.م|E£/);
  assert.equal(formatNumberValue(1234), "1,234");
  assert.equal(formatDateValue("2026-05-09T00:00:00Z"), "May 09, 2026");
  assert.equal(formatDateValue(null), "-");
  assert.equal(formatDateTimeValue("not-a-date"), "not-a-date");
}
