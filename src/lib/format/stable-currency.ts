// A money formatter whose BYTES do not depend on how old the reader's browser is.
//
// Drop-in for `new Intl.NumberFormat(locale, options)` — same `.format(value)` shape — for the
// currency sites that live inside `"use client"` components.
//
// THE BUG. `style: "currency"` with a currency CODE puts a space between the code and the digits,
// and WHICH space that is changed with the locale data: current ICU emits U+00A0, a non-breaking
// space, where older builds emit an ordinary U+0020. `EGP 1,234,567` looks identical either way —
// and an invisible character is still a text node. A client component renders that text twice, once
// on the server and once in the browser on hydrate, and React discards the server HTML when they
// differ: hydration error #418.
//
// Measured on production 2026-09-11 on /employee-portals/team-performance, from the same District
// Sales Manager on Samsung Internet 20 whose Cairo timestamps were failing the same way one axis
// over (see src/lib/format/cairo-zone.ts). Same disease: text that two engines build from data
// they were shipped with rather than from data we shipped.
//
// THE FIX is the one already used for dates in cairo-datetime.ts, where `applyStableMonth`
// normalises U+202F back to a plain space for exactly this reason: pick the character, rather than
// letting the engine pick it. A plain space is what every engine can produce and what already
// renders today.
//
// SERVER-ONLY currency sites do NOT need this, and that is a real line rather than an unfinished
// migration. Text that is rendered once is never compared against a second rendering, so the
// character cannot cause a mismatch there. The ones that matter are the ones React hydrates.

/** The separators locale data has moved between. Normalised to the plain space every engine has. */
const VARIABLE_SPACES = /[\u00a0\u202f]/g;

/** Drop-in for `new Intl.NumberFormat(locale, options)` — same `.format(value)` shape. */
export function stableCurrencyFormatter(
  locale: string | string[] | undefined,
  options: Intl.NumberFormatOptions,
): { format(value: number): string } {
  const display = new Intl.NumberFormat(locale, options);
  return {
    format(value: number): string {
      return display.format(value).replace(VARIABLE_SPACES, " ");
    },
  };
}

/** One-shot form, for a call site that does not keep its formatter. */
export function formatStableCurrency(
  value: number,
  locale: string | string[] | undefined,
  options: Intl.NumberFormatOptions,
): string {
  return stableCurrencyFormatter(locale, options).format(value);
}
