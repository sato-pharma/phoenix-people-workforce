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

/**
 * Fetches a CV from an allowlisted link, size/type/redirect-guarded.
 *
 * Returns a REASON rather than throwing, and rather than the old bare `null`: the caller writes
 * that reason onto the intake event, which is what puts the message on Inbound Intake Health
 * instead of losing it under `ignored_no_attachment`. Never follows a link to a non-allowlisted
 * host, even via redirect (the final response URL is re-checked).
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

  let response: Response;
  try {
    response = await fetch(parsed.toString(), { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch {
    return { ok: false, reason: `The CV link could not be reached — ${parsed.hostname} did not answer in time.` };
  }

  if (!response.ok) {
    return { ok: false, reason: `The CV link could not be downloaded — ${parsed.hostname} answered ${response.status}.` };
  }
  // Re-check the host AFTER redirects — a link that bounces off the allowlist is rejected.
  try {
    if (response.url && !isAllowlistedCvHost(new URL(response.url).hostname)) {
      return { ok: false, reason: "The CV link redirected to a host we do not download from." };
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
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: "The CV link started downloading but the transfer failed." };
  }
  if (bytes.length === 0) return { ok: false, reason: "The CV link returned an empty file." };
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `The linked CV is larger than the maximum accepted size (${maxBytes} bytes).` };
  }

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
