// Recruitment / ATS — "CV as a link" support for emails that carry a share link instead of an
// attachment ("my CV: <drive link>"). STRICTLY allowlisted to known file hosts: following an
// arbitrary link from an untrusted sender would be an SSRF / abuse vector, so only these hosts are
// ever fetched, and the fetch is size/type/redirect-guarded.
//
// Measured in production on 2026-09-03: this path had captured ZERO CVs in its whole lifetime —
// 4 links received, 4 lost. Applicants paste the address out of the Drive/Docs UI, which is the
// VIEWER url (`/file/d/<id>/view`, `/document/d/<id>/edit`). Fetching that returns Google's HTML
// page, not the file, so the content-type check rejected it and the caller silently fell back to
// "no attachment" — filing a real applicant under the same outcome as a newsletter.
//
// Two changes close that: normalizeCvDownloadUrl turns a viewer url into the matching DOWNLOAD
// endpoint before the fetch, and fetchCvFromUrl now returns a REASON instead of null, so a failure
// is recorded on the intake event and shows up on Inbound Intake Health.

const ALLOWED_HOST_PATTERNS: RegExp[] = [
  /(^|\.)drive\.google\.com$/i,
  /(^|\.)docs\.google\.com$/i,
  /(^|\.)dropbox\.com$/i,
  /(^|\.)1drv\.ms$/i,
  /(^|\.)onedrive\.live\.com$/i,
  /(^|\.)wetransfer\.com$/i,
  /(^|\.)we\.tl$/i,
];

// Hosts an allowlisted link may legitimately land on AFTER redirects. Every provider here serves the
// bytes from a host other than the one the share link names: drive.google.com/uc?export=download
// hands off to drive.usercontent.google.com, a Docs export to <id>.googleusercontent.com, a Dropbox
// dl=1 link to dropboxusercontent.com. These are download endpoints only — allowed as a redirect
// TARGET, never as a link we would follow from an untrusted sender in the first place.
const ALLOWED_REDIRECT_HOST_PATTERNS: RegExp[] = [
  ...ALLOWED_HOST_PATTERNS,
  /(^|\.)usercontent\.google\.com$/i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)dropboxusercontent\.com$/i,
  /(^|\.)1drv\.com$/i,
  /(^|\.)wetransfer\.net$/i,
];

export function isAllowlistedCvRedirectHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return ALLOWED_REDIRECT_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

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

const DRIVE_FILE_ID_IN_PATH = /\/file\/d\/([A-Za-z0-9_-]+)/;
const DOCS_EDITOR_IN_PATH = /\/(document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]+)/;

/**
 * Rewrites a share/viewer URL into the host's DIRECT-DOWNLOAD equivalent.
 *
 * This is the whole fix for the 0-of-4 capture rate: every applicant sends the viewer link, and
 * every viewer link serves HTML. The HOST is never changed — only the path and query — so the
 * allowlist check above and the post-redirect re-check below both still hold.
 *
 * Anything it does not recognise is returned UNCHANGED rather than guessed at: a WeTransfer link
 * genuinely cannot be resolved without a browser session, and failing with a clear reason beats
 * inventing an endpoint.
 */
export function normalizeCvDownloadUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = url.hostname.trim().toLowerCase();

  // drive.google.com/file/d/<id>/view  and  /open?id=<id>  ->  the uc download endpoint.
  if (/(^|\.)drive\.google\.com$/i.test(host)) {
    const id = url.pathname.match(DRIVE_FILE_ID_IN_PATH)?.[1] ?? url.searchParams.get("id");
    return id ? `https://drive.google.com/uc?export=download&id=${id}` : rawUrl;
  }

  // A CV written in Google Docs is a real CV — export it rather than reading the editor chrome.
  // Presentations take a different export path shape than documents and spreadsheets.
  if (/(^|\.)docs\.google\.com$/i.test(host)) {
    const editor = url.pathname.match(DOCS_EDITOR_IN_PATH);
    if (editor) {
      const kind = editor[1];
      const id = editor[2];
      return kind === "presentation"
        ? `https://docs.google.com/presentation/d/${id}/export/pdf`
        : `https://docs.google.com/${kind}/d/${id}/export?format=pdf`;
    }
    const id = url.searchParams.get("id");
    return id ? `https://docs.google.com/uc?export=download&id=${id}` : rawUrl;
  }

  // Dropbox serves its preview page unless dl=1, and links are pasted carrying dl=0.
  if (/(^|\.)dropbox\.com$/i.test(host)) {
    url.searchParams.set("dl", "1");
    return url.toString();
  }

  // OneDrive's web view; download=1 asks for the bytes instead.
  if (/(^|\.)onedrive\.live\.com$/i.test(host)) {
    url.searchParams.set("download", "1");
    return url.toString();
  }

  return rawUrl;
}

const SUPPORTED_LINK_CONTENT_TYPES = /(pdf|wordprocessingml|msword|^image\/)/i;

/** A share host answering with a sign-in / permission / interstitial page rather than the file. */
function looksLikeHtml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

export type CvLinkFetchResult =
  | { ok: true; bytes: Buffer; mimeType: string; fileName: string }
  | { ok: false; reason: string };

/** A share link hands off once or twice to its download host; more than this is not a download. */
const MAX_REDIRECT_HOPS = 5;

type CvLinkHopResult = { ok: true; response: Response } | { ok: false; reason: string };

/**
 * Follows redirects ONE HOP AT A TIME, and refuses a hop before it is requested.
 *
 * Until 13 Nov 2026 (integration audit, finding ISS-015) this was `redirect: "follow"` with the host
 * checked once, on the final response. That refused the wrong answer but had already SENT the request:
 * an allowlisted host that redirected to an address inside the private network would have made this
 * server call it. Now every hop must be https and on the redirect allowlist before it is fetched, so
 * no request ever leaves for a host that is not a known file host.
 */
async function fetchAlongAllowlistedHops(start: URL, signal: AbortSignal): Promise<CvLinkHopResult> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const response = await fetch(current.toString(), { redirect: "manual", signal });
    if (response.status < 300 || response.status > 399) return { ok: true, response };

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      return { ok: false, reason: `The CV link could not be downloaded — ${current.hostname} answered ${response.status}.` };
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { ok: false, reason: "The CV link redirected somewhere that could not be checked." };
    }
    if (next.protocol !== "https:" || !isAllowlistedCvRedirectHost(next.hostname)) {
      return { ok: false, reason: `The CV link redirected to ${next.hostname}, which we do not download from.` };
    }
    current = next;
  }
  return { ok: false, reason: "The CV link redirected too many times to be a file download." };
}

/**
 * Reads the body and stops at the cap. A host that declares no length (or a false one) used to be
 * read whole into memory before its size was looked at.
 */
async function readUpTo(response: Response, maxBytes: number): Promise<Buffer | "too_large"> {
  const reader = response.body?.getReader();
  if (!reader) {
    const whole = Buffer.from(await response.arrayBuffer());
    return whole.length > maxBytes ? "too_large" : whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetches a CV from an allowlisted link, size/type/redirect-guarded.
 *
 * Returns a REASON rather than throwing, and rather than the old bare `null`: the caller writes
 * that reason onto the intake event, which is what puts the message on Inbound Intake Health
 * instead of losing it under `ignored_no_attachment`. Never requests a non-allowlisted host, even
 * via redirect: every hop is checked before it is fetched (fetchAlongAllowlistedHops), the final
 * response URL is re-checked, and the body is read no further than `maxBytes`.
 *
 * The reasons are written for Talent Acquisition to read, per the owner's rule that a screen shows
 * human-readable words. The commonest real cause by far is a link left private, so that reason
 * says so and says what to ask the applicant for.
 */
export async function fetchCvFromUrl(url: string, maxBytes: number): Promise<CvLinkFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(normalizeCvDownloadUrl(url));
  } catch {
    return { ok: false, reason: "The CV link in this message could not be read as a web address." };
  }
  if (!isAllowlistedCvHost(parsed.hostname)) {
    return { ok: false, reason: `The CV link points at ${parsed.hostname}, which is not a file host we download from.` };
  }

  // Every host on the allowlist serves https; a link pasted as http is asked for over https.
  parsed.protocol = "https:";

  let response: Response;
  try {
    const hops = await fetchAlongAllowlistedHops(parsed, AbortSignal.timeout(15_000));
    if (!hops.ok) return hops;
    response = hops.response;
  } catch {
    return { ok: false, reason: `The CV link could not be reached — ${parsed.hostname} did not answer in time.` };
  }

  if (!response.ok) {
    return { ok: false, reason: `The CV link could not be downloaded — ${parsed.hostname} answered ${response.status}.` };
  }
  // Re-check the host AFTER redirects. Providers serve the bytes from a dedicated download host, so
  // this allowlist is wider than the link one — but it is still an allowlist, and it names the host
  // it refused so a future provider change is diagnosable instead of silent.
  try {
    if (response.url) {
      const landedOn = new URL(response.url).hostname;
      if (!isAllowlistedCvRedirectHost(landedOn)) {
        return { ok: false, reason: `The CV link redirected to ${landedOn}, which we do not download from.` };
      }
    }
  } catch {
    return { ok: false, reason: "The CV link redirected somewhere that could not be checked." };
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: `The linked CV is larger than the maximum accepted size (${maxBytes} bytes).` };
  }

  let bytes: Buffer;
  try {
    const read = await readUpTo(response, maxBytes);
    if (read === "too_large") {
      return { ok: false, reason: `The linked CV is larger than the maximum accepted size (${maxBytes} bytes).` };
    }
    bytes = read;
  } catch {
    return { ok: false, reason: "The CV link started downloading but the transfer failed." };
  }
  if (bytes.length === 0) return { ok: false, reason: "The CV link returned an empty file." };

  // The single commonest failure, and the one worth naming precisely: a share link that was never
  // made public serves a sign-in page. Checked on the BYTES as well as the header, because Drive
  // labels its interstitial as octet-stream, which the tolerance below would otherwise wave past.
  if (/text\/html/i.test(contentType) || looksLikeHtml(bytes)) {
    return {
      ok: false,
      reason:
        "The CV link opened a web page instead of a file — the share link is not public. " +
        "Ask the applicant to attach the CV, or to set the link so anyone with it can view.",
    };
  }

  // Content-type is often generic on share hosts, so accept when the type looks like a CV OR is
  // an unhelpful octet-stream (the downstream file-kind check + extractCvFieldsFromBytes' is_cv
  // gate are the real gate).
  if (!SUPPORTED_LINK_CONTENT_TYPES.test(contentType) && !/octet-stream/i.test(contentType)) {
    return { ok: false, reason: `The CV link returned a ${contentType} file, which is not a CV format we read.` };
  }

  const fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "cv") || "cv";
  return { ok: true, bytes, fileName, mimeType: contentType };
}
