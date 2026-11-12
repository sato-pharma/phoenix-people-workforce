/**
 * Did something OTHER than the app rewrite this page's text before React hydrated it?
 *
 * React hydration error #418 with `args[]=text` means the text the server sent is not the text
 * the client rendered. A browser machine-translation does exactly that, and it is the last cause
 * left standing here: #418 concentrates in PEOPLE, not pages — one reader produced 63 events
 * across 23 unrelated routes — and an exhaustive sweep of the two worst routes' import graphs
 * (154 and 155 files) found no app-code cause at all.
 *
 * `app/layout.tsx` USED to opt out, with `translate="no"` and the `google: notranslate` meta,
 * shipped 2026-09-08 in #3487 and REMOVED 2026-09-11 at the owner's instruction. Its own comment
 * named the falsification test: if the routes went quiet the diagnosis was right, and if they kept
 * erroring it was not the cause. They did not go quiet — /employee-portals/recruitment-candidates
 * kept throwing from Samsung Internet, whose translator is Samsung's own and honours neither
 * signal, so the opt-out was costing every Arabic-speaking reader the translate offer and buying
 * nothing measurable.
 *
 * That is why this exists, and why it now carries the whole weight. The opt-out was a fix applied
 * to a plausible cause; this makes the next occurrence SAY whether the DOM was rewritten, so the
 * question is settled by evidence rather than re-argued. Read `domRewriter=` in the stack before
 * anybody proposes putting the attribute back. It changes nothing a user sees and costs a handful of bytes on a row
 * that is only written when something already went wrong.
 *
 * PURE, and separate from the reporter, so it is testable without a DOM — the reporter reads the
 * four values off `document` and hands them here.
 */

/** What `app/layout.tsx` serves on `<html lang>`. A different value means someone changed it. */
const SERVER_RENDERED_LANG = "en";

export type DomRewriterProbe = {
  /**
   * The app emits no `<font>` element anywhere — it is a legacy tag, and the only places it
   * appears in this repo are an editor's sanitizer and OOXML strings, neither of which reaches
   * the page. Google Translate wraps every text node it rewrites in one, so any count above
   * zero is a foreign rewrite, whichever browser did it.
   */
  fontElementCount: number;
  /** Microsoft's translator stamps `_msttexthash` on every node it touches. */
  hasMicrosoftTranslateAttribute: boolean;
  /** Google Translate puts `translated-ltr` or `translated-rtl` on `<html>`. */
  htmlClassName: string;
  /** A translator that rewrote the page usually rewrites this too. */
  htmlLang: string;
  /**
   * Every attribute name on `<html>`, and on `<body>`. The app emits exactly `lang`, `class` and
   * `style` on the first and `class` and `style` on the second (`app/layout.tsx` sets lang and both
   * classNames; the display-scale script writes `documentElement.style`, and several portal
   * components write `body.style.overflow` for a modal). So ANY other attribute on those two
   * elements was put there by something that is not this app.
   *
   * This is the marker that names the mutator for error #412, where the translator probe above comes
   * back clean and `readyState=complete` says the DOM was changed from outside React. Extensions
   * stamp these constantly — Dark Reader writes `data-darkreader-*`, Grammarly
   * `data-gr-ext-installed` and `data-new-gr-c-s-check-loaded`, ColorZilla `cz-shortcut-listen` —
   * and Grammarly's in particular is one of the best-known causes of a React hydration mismatch.
   */
  htmlAttributeNames: readonly string[];
  bodyAttributeNames: readonly string[];
  /**
   * Links an iPhone's or iPad's own phone-number detection wrapped around page text. WebKit stamps
   * every one with `x-apple-data-detectors`, and the app never emits that attribute — its own call
   * links are plain `tel:` anchors. A direct order prints its pharmacy's 10-digit distributor
   * customer code ("0001518652"), which reads as a phone number to that detector; the only two #418s
   * ever recorded on a direct order (an iPhone, 26 and 27 Oct 2026) had no app cause, and until this
   * the probe could not see a link like that. Optional so an older probe still describes.
   */
  appleDataDetectorCount?: number;
  /**
   * Addresses Cloudflare's Email Address Obfuscation rewrote (`data-cfemail` / `a.__cf_email__`).
   * `no-transform` on every page Cloudflare forwards (#6718; since 12 Nov 2026 only on a request carrying `cf-ray`, because it also switches off Next's compression) ended it; a count here means a page escaped that header.
   */
  cloudflareEmailCount?: number;
};

/**
 * What THIS app puts on `<html>` and `<body>`. Anything else is foreign.
 *
 * `style` is allow-listed on both deliberately and must stay: `app/layout.tsx`'s display-scale
 * script sets a custom property on `documentElement.style`, and the portal's modals set
 * `body.style.overflow`. Without it every error row from a page with an open modal would accuse an
 * extension that was never there — and a probe that cries wolf is one the next session stops
 * believing, which is the whole failure mode this file was written to avoid.
 *
 * `data-route-transition-ready` and `data-route-transition-pending` are the same story on `<html>`:
 * RouteTransitionProvider (src/components/layout/route-transition-provider.tsx) sets the first in a
 * mount effect and toggles the second on every navigation. Neither is in the server markup, and the
 * effect runs on essentially every page, so before they were allow-listed the false positive
 * stamped `foreignAttrs=data-route-transition-ready` on 175 of 175 probe rows in a 30-day
 * production window (measured 2026-10-07) — the whole `foreignAttrs=` channel was noise, burying any
 * real extension. They are the app's own, so they belong here beside `style`.
 */
const APP_HTML_ATTRIBUTES = new Set([
  "lang",
  "class",
  "style",
  "data-route-transition-ready",
  "data-route-transition-pending",
]);
const APP_BODY_ATTRIBUTES = new Set(["class", "style"]);

/** Attribute-name prefixes and exact names whose owner is known, so the marker can NAME it. */
const KNOWN_MUTATORS: ReadonlyArray<{ marker: string; test: (attr: string) => boolean }> = [
  { marker: "dark-reader", test: (a) => a.startsWith("data-darkreader") },
  { marker: "grammarly", test: (a) => a.startsWith("data-gr-") || a.startsWith("data-new-gr-") },
  { marker: "colorzilla", test: (a) => a === "cz-shortcut-listen" },
  { marker: "lastpass", test: (a) => a.startsWith("data-lastpass") },
];

/**
 * Markers for whatever rewrote the DOM, or an empty array when the page looks untouched.
 *
 * Empty is the overwhelmingly common answer, and the reporter writes nothing at all in that
 * case — an absent marker costs no bytes on the 99% of rows that are ordinary app errors.
 */
export function describeDomRewriters(probe: DomRewriterProbe): string[] {
  const markers: string[] = [];

  if (/\btranslated-(?:ltr|rtl)\b/.test(probe.htmlClassName)) markers.push("google-translate");
  if (probe.hasMicrosoftTranslateAttribute) markers.push("microsoft-translate");
  if (probe.fontElementCount > 0) markers.push(`fontTags=${probe.fontElementCount}`);
  if ((probe.appleDataDetectorCount ?? 0) > 0) markers.push(`ios-data-detectors=${probe.appleDataDetectorCount}`);
  if ((probe.cloudflareEmailCount ?? 0) > 0) markers.push(`cloudflare-email=${probe.cloudflareEmailCount}`);

  const lang = probe.htmlLang.trim();
  if (lang && lang.toLowerCase() !== SERVER_RENDERED_LANG) markers.push(`lang=${lang}`);

  // Whatever else is sitting on <html>/<body> that this app did not put there. A named mutator is
  // reported by name; the rest are listed verbatim, because the NEXT unknown extension is the one
  // worth reading and a bare count would say nothing about it.
  const foreign = [
    ...foreignAttributes(probe.htmlAttributeNames, APP_HTML_ATTRIBUTES),
    ...foreignAttributes(probe.bodyAttributeNames, APP_BODY_ATTRIBUTES),
  ];
  if (foreign.length > 0) {
    const named = new Set<string>();
    const unnamed: string[] = [];
    for (const attr of foreign) {
      const hit = KNOWN_MUTATORS.find((m) => m.test(attr));
      if (hit) named.add(hit.marker);
      else unnamed.push(attr);
    }
    for (const marker of [...named].sort()) markers.push(marker);
    // Sorted and de-duplicated so the same page always produces the same marker string — a row that
    // reads differently on every load cannot be grouped in a census.
    if (unnamed.length > 0) markers.push(`foreignAttrs=${[...new Set(unnamed)].sort().join("|")}`);
  }

  return markers;
}

/** The attribute names on one element that the app itself never emits. Case-insensitive: HTML
 * lower-cases attribute names, but a probe fed from a test fixture need not. */
function foreignAttributes(names: readonly string[], allowed: ReadonlySet<string>): string[] {
  return names
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0 && !allowed.has(name));
}
