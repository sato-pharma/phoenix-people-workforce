// Recruitment / ATS — the candidate's LinkedIn profile, read and made safe to link to.
//
// Its own small module rather than a part of rule-extraction/patterns.ts, because the screens need
// it too: the profile panel builds its button in the browser, and patterns.ts pulls the whole
// governorate dictionary in with it. The CV reader and the button therefore share ONE matcher, so
// the link a recruiter presses is always the link the reader found — never a second guess at it.

const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9%_-]+(?:\/[A-Za-z0-9%_-]+)*/gi;

/**
 * The candidate's LinkedIn profile, canonicalised to https://www.linkedin.com/in/<slug>.
 *
 * Prefers the LONGEST match, which is what makes it correct on the 13% of CVs where pdf-parse
 * emitted a markdown link: the visible label is a TRUNCATED copy of the URL
 * ("linkedin.com/in/aban") sitting right beside the real one, and the short one resolves to
 * nobody.
 */
export function findLinkedInUrl(text: string): string | null {
  const matches = [...text.matchAll(LINKEDIN)].map((match) => match[0]);
  if (matches.length === 0) return null;
  const best = matches.sort((a, b) => b.length - a.length)[0];
  const slug = best.replace(/^.*linkedin\.com\/(?:in|pub)\//i, "").replace(/\/+$/, "");
  return slug ? `https://www.linkedin.com/in/${slug}` : null;
}

/**
 * What a LinkedIn button may open for this record, or null when there is nothing to open.
 *
 * Nothing guarantees the stored `linkedin_url` IS a LinkedIn profile: the AI reader, a record merge
 * and a hand edit all write that column, and none of them checks the host. A button labelled
 * LinkedIn that opened some other page would be wrong, and a stored `javascript:` value handed
 * straight to an `href` would run in the recruiter's session. So the
 * value goes back through the same matcher the reader used, and the button links only to the
 * https://www.linkedin.com/in/ address that comes out — a fixed host and a slug of letters, digits,
 * `%`, `_` and `-`, nothing else.
 */
export function linkedInProfileHref(value: string | null | undefined): string | null {
  if (!value) return null;
  return findLinkedInUrl(value);
}
