import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

/**
 * "View CV" must VIEW the CV, and a failed preview must never be a dead end.
 *
 * The hiring-manager portal card offered a control labelled "View CV" that was a bare <a> at
 * /api/recruitment/hiring-manager/candidates/:id/files/:fileId. That route serves
 * `Content-Disposition: attachment` unless the caller asks for `disposition=inline` (see the
 * route and its sibling under app/api/recruitment/files/[id]/download), so the browser was being
 * TOLD to save the file. It obeyed. The CV downloaded, nothing was ever displayed, and the portal
 * had no way to read a CV at all — reported from production 2026-08-14 as "when I press on view
 * CV it tells me failed to fetch and the CV is download, I want to view the CV".
 *
 * The admin workspace had already been given an inline viewer (CvPreviewModal, which paints PDF
 * pages onto <canvas> via pdfjs-dist rather than trusting the browser's PDF handling). The portal
 * button was simply never moved onto it. So the invariant is about the CONTROL, not the route:
 * the thing labelled "View CV" must open the in-page viewer, never navigate at the file URL.
 *
 * Asserting on the element type is deliberate. A test that only checked for the string
 * "disposition=inline" would pass on an anchor carrying that parameter — but an inline anchor
 * still hands the document to the browser's own PDF handling, which is exactly the failure mode
 * CvPreviewModal exists to avoid: a user whose Chrome is set to download PDFs gets a silent
 * download from an inline URL too, with no error anywhere. Only the modal is immune.
 */
export async function runRecruitmentPortalCvViewTests(): Promise<void> {
  const portalSource = readFileSync(
    new URL("../src/components/employee-portal/recruitment-candidates-portal.tsx", import.meta.url),
    "utf8",
  );

  // ── "View CV" must be a Button that opens the preview, not an anchor ────────────────────────
  // Comments are stripped first: the code around this control is deliberately commented, and
  // those comments name "View CV" and "<a>" while explaining the bug. Matching raw source would
  // find the explanation instead of the element and report on prose rather than on behaviour.
  const code = portalSource
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  const viewCvAt = code.indexOf("View CV");
  assert.ok(viewCvAt > 0, "the portal must still offer a control labelled \"View CV\"");

  // Walk back to the element that owns this label. Whichever opening tag is nearest before the
  // label is the element rendering it.
  const beforeLabel = code.slice(0, viewCvAt);
  const anchorAt = beforeLabel.lastIndexOf("<a");
  const buttonAt = beforeLabel.lastIndexOf("<Button");
  assert.ok(
    buttonAt > anchorAt,
    "\"View CV\" must be rendered by <Button> (opening CvPreviewModal), not by an <a> at the file " +
      "route — an anchor there serves Content-Disposition: attachment and downloads the CV instead " +
      "of showing it",
  );

  // ...and that Button must actually open the preview modal.
  const buttonOpening = code.slice(buttonAt, viewCvAt);
  assert.match(
    buttonOpening,
    /setPreviewOpen\(true\)/,
    "the \"View CV\" button must open the in-page CV preview (setPreviewOpen(true))",
  );

  // The modal must be wired to the same file, or the button opens an empty viewer.
  assert.match(
    portalSource,
    /<CvPreviewModal/,
    "the portal must render CvPreviewModal — it is what actually displays the CV",
  );

  // ── A failed render must still offer a way to read the CV ───────────────────────────────────
  const modalSource = readFileSync(
    new URL("../src/components/recruitment/cv-preview-modal.tsx", import.meta.url),
    "utf8",
  );

  // Production redeploys while a tab is open, and the lazily-imported renderer chunk then 404s;
  // the browser's own wording for that is a bare "Failed to fetch", which tells a reader nothing
  // and left them with no route to the document. The failure notice must carry an escape hatch.
  assert.match(
    modalSource,
    /Open the CV in a new tab/,
    "a failed preview must offer to open the CV directly — otherwise the reader is stuck with a " +
      "raw browser error and no way to see the document",
  );

  const noticeAt = modalSource.indexOf("Open the CV in a new tab");
  const noticeAnchor = modalSource.slice(Math.max(0, noticeAt - 400), noticeAt);
  assert.match(
    noticeAnchor,
    /href=\{inlineUrl\}/,
    "the fallback link must point at inlineUrl (disposition=inline) so the browser DISPLAYS the " +
      "CV — the plain downloadUrl would save it to disk, which is the bug this fixes",
  );

  // The notice only helps if it is actually rendered when a render fails.
  assert.match(
    modalSource,
    /\{failureNotice\}/,
    "the failure notice must be rendered in the document body, not merely defined",
  );

  // ── The renderer must never request something that LOOKS like a downloadable file ───────────
  // A download-manager extension (IDM and relatives) cancels the page's own request whenever the
  // response carries a document content-type plus a filename, so it can grab the file itself.
  // That is what produced the bare "Failed to fetch" in production on 2026-08-14 while the same
  // URL downloaded fine THROUGH the extension. The renderer therefore asks for base64 text.
  assert.match(
    modalSource,
    /const bytesUrl = `\$\{downloadUrl\}\$\{separator\}format=base64`/,
    "the modal must build a base64 bytes URL for in-page rendering",
  );
  assert.match(
    modalSource,
    /await fetch\(bytesUrl\)/,
    "the renderer must fetch the base64 URL",
  );
  assert.doesNotMatch(
    modalSource,
    /await fetch\(inlineUrl\)/,
    "the renderer must NOT fetch the inline URL — that response is a real PDF, which a " +
      "download-manager extension cancels, surfacing as \"Failed to fetch\" with nothing rendered",
  );
  // The <img> path must not re-request the file either, or the same extension eats photographed
  // CVs (the WhatsApp intake path) instead of showing them.
  assert.doesNotMatch(
    modalSource,
    /<img[^>]*src=\{inlineUrl\}/,
    "images must render from the already-fetched bytes (a blob URL), not a second request",
  );

  // ── Both file routes must offer that mode, with nothing for an extension to match on ────────
  const responseSource = readFileSync(
    new URL("../src/lib/recruitment/file-response.ts", import.meta.url),
    "utf8",
  );
  // Comments are stripped for the same reason as above: this branch is deliberately commented
  // and its comment NAMES the headers it must not send, so raw source would match the
  // explanation rather than the code.
  const responseCode = responseSource.replace(/^[ \t]*\/\/.*$/gm, "");
  const base64Branch = responseCode.slice(responseCode.indexOf("format\") === \"base64\""));
  const base64Body = base64Branch.slice(0, base64Branch.indexOf("const inline"));
  assert.match(
    base64Body,
    /"Content-Type": "text\/plain; charset=utf-8"/,
    "the base64 mode must not advertise the file's real mime type — that is half of what a " +
      "download manager matches on",
  );
  assert.doesNotMatch(
    base64Body,
    /Content-Disposition/,
    "the base64 mode must send NO Content-Disposition — a filename is the other half of what a " +
      "download manager matches on",
  );
  assert.match(
    base64Body,
    /"X-Content-Type-Options": "nosniff"/,
    "nosniff must stop the browser re-deriving the real type from the bytes, which would hand " +
      "the extension its trigger straight back",
  );

  for (const route of [
    "../app/api/recruitment/files/[id]/download/route.ts",
    "../app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts",
  ]) {
    const routeSource = readFileSync(new URL(route, import.meta.url), "utf8");
    assert.match(
      routeSource,
      /return recruitmentFileResponse\(request, download\)/,
      `${route} must serve bytes through the shared response builder, so both routes offer the ` +
        "base64 mode the renderer depends on",
    );
  }
}
