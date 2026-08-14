// Recruitment / ATS — "CV as a link" support for emails that carry a share link instead of an
// attachment ("my CV: <drive link>"). STRICTLY allowlisted to known file hosts: following an
// arbitrary link from an untrusted sender would be an SSRF / abuse vector, so only these hosts are
// ever fetched, and the fetch is size/type/redirect-guarded.

const ALLOWED_HOST_PATTERNS: RegExp[] = [
  /(^|\.)drive\.google\.com$/i,
  /(^|\.)docs\.google\.com$/i,
  /(^|\.)dropbox\.com$/i,
  /(^|\.)1drv\.ms$/i,
  /(^|\.)onedrive\.live\.com$/i,
  /(^|\.)wetransfer\.com$/i,
  /(^|\.)we\.tl$/i,
];

export function isAllowlistedCvHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

// Pull the first allowlisted URL out of the email body (plain text + HTML). Pure — the actual fetch
// is separate so this stays unit-testable and the parser has no network dependency.
export function extractAllowlistedCvUrl(text: string | null | undefined, html: string | null | undefined | false): string | null {
  const haystack = `${text ?? ""}\n${typeof html === "string" ? html : ""}`;
  const matches = haystack.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  for (const raw of matches) {
    try {
      const url = new URL(raw);
      if ((url.protocol === "https:" || url.protocol === "http:") && isAllowlistedCvHost(url.hostname)) {
        return url.toString();
      }
    } catch {
      /* not a parseable URL — skip */
    }
  }
  return null;
}

const SUPPORTED_LINK_CONTENT_TYPES = /(pdf|wordprocessingml|msword|^image\/)/i;

/**
 * Fetches a CV from an allowlisted link, size/type/redirect-guarded. Returns null (not a throw) on
 * anything unsafe or unusable — a non-allowlisted final URL after redirects, an oversized body, or a
 * non-CV content type — so the caller simply falls back to "no attachment". Never follows a link to
 * a non-allowlisted host, even via redirect (the final response URL is re-checked).
 */
export async function fetchCvFromUrl(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; mimeType: string; fileName: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isAllowlistedCvHost(parsed.hostname)) return null;

  try {
    const response = await fetch(parsed.toString(), { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    // Re-check the host AFTER redirects — a link that bounces off the allowlist is rejected.
    try {
      if (response.url && !isAllowlistedCvHost(new URL(response.url).hostname)) return null;
    } catch {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) return null;
    // Content-type is often generic on share hosts, so accept when the type looks like a CV OR is
    // an unhelpful octet-stream (the downstream file-kind check + extractCvFieldsFromBytes' is_cv
    // gate are the real gate).
    if (!SUPPORTED_LINK_CONTENT_TYPES.test(contentType) && !/octet-stream/i.test(contentType)) return null;

    const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "cv") || "cv";
    return { bytes, fileName, mimeType: contentType };
  } catch {
    return null;
  }
}
