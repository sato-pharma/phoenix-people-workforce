/**
 * Did something OTHER than the app rewrite this page's text before React hydrated it?
 *
 * React hydration error #418 with `args[]=text` means the text the server sent is not the text
 * the client rendered. A browser machine-translation does exactly that, and it is the last cause
 * left standing here: #418 concentrates in PEOPLE, not pages — one reader produced 63 events
 * across 23 unrelated routes — and an exhaustive sweep of the two worst routes' import graphs
 * (154 and 155 files) found no app-code cause at all.
 *
 * `app/layout.tsx` already opts out, with `translate="no"` and the `google: notranslate` meta,
 * shipped 2026-09-08 in #3487. Its own comment names the falsification test: if the routes go
 * quiet the diagnosis was right, and if they keep erroring it was not the cause. They did not go
 * quiet — /employee-portals/recruitment-candidates threw twice on 2026-09-09, on a release that
 * contains the opt-out, from Samsung Internet, whose translator is Samsung's own and honours
 * neither signal.
 *
 * That is why this exists. The opt-out was a fix applied to a plausible cause; this makes the
 * next occurrence SAY whether the DOM was rewritten, so the question is settled by evidence
 * rather than re-argued. It changes nothing a user sees and costs a handful of bytes on a row
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
};

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

  const lang = probe.htmlLang.trim();
  if (lang && lang.toLowerCase() !== SERVER_RENDERED_LANG) markers.push(`lang=${lang}`);

  return markers;
}
