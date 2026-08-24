// Recruitment / ATS — turning a pasted block of Facebook group links into channel rows.
//
// Pure (no I/O). The realistic way this list gets built is one paste out of the browser sidebar,
// so the parser has to accept what a paste actually looks like: bare URLs, names with no URL,
// "Name | URL", "Name<TAB>URL", blank lines, and the stray heading someone copied along with it.

export type ParsedChannelLine = {
  name: string;
  url: string | null;
};

const SEPARATORS = /\s*[|\t]\s*/;

/**
 * Pulls a readable group name out of a Facebook group URL.
 *
 * Facebook group URLs come in two shapes: a numeric id (/groups/123456789) and a vanity slug
 * (/groups/medical.reps.egypt). Only the slug carries a name worth showing, so a numeric id gets a
 * placeholder the recruiter can rename rather than a fake one derived from digits.
 */
export function nameFromGroupUrl(url: string): string | null {
  const match = /facebook\.com\/groups\/([^/?#]+)/i.exec(String(url ?? ""));
  if (!match) return null;
  const slug = decodeURIComponent(match[1]).trim();
  if (slug.length === 0) return null;
  if (/^[0-9]+$/.test(slug)) return `Facebook group ${slug}`;
  return slug
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^(www\.)?facebook\.com\//i.test(value);
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Parses a pasted block into one entry per line.
 *
 * Lines that yield neither a name nor a URL are dropped silently — a paste picks up headings and
 * blank lines, and rejecting the whole block over them would be useless. Duplicate names within
 * one paste collapse to the first occurrence; the service layer separately skips names already
 * stored, so re-pasting a longer list only adds what is new.
 */
export function parseChannelPasteList(text: string): ParsedChannelLine[] {
  const seen = new Set<string>();
  const parsed: ParsedChannelLine[] = [];

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const parts = line.split(SEPARATORS).map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length === 0) continue;

    let name: string | null = null;
    let url: string | null = null;
    for (const part of parts) {
      if (url === null && looksLikeUrl(part)) url = normalizeUrl(part);
      else if (name === null) name = part;
    }

    // A bare URL still deserves a row — read the name off the link rather than making the
    // recruiter retype twenty group names he just copied.
    if (!name && url) name = nameFromGroupUrl(url);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ name, url });
  }

  return parsed;
}
