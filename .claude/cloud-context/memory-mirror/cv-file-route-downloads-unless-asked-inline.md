---
name: cv-file-route-downloads-unless-asked-inline
description: "The recruitment file routes serve Content-Disposition attachment by default, so any plain link to them downloads the CV instead of showing it; only CvPreviewModal reliably displays one"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T19:56:48.326Z
---

**Both recruitment file routes serve `Content-Disposition: attachment` unless the caller passes
`?disposition=inline`** — `app/api/recruitment/files/[id]/download/route.ts` and
`app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts`. So **any
plain `<a href>` at those routes downloads the CV**, and the page shows nothing. That is not a
browser quirk; it is the server instructing the browser to save the file.

This shipped as a real defect: the hiring-manager candidate card's control labelled **"View CV"**
was such a link, so the portal had **no way to read a CV at all**. Reported 2026-08-14 as *"when I
press on view CV it tells me failed to fetch and the CV is download"*. Fixed and **LIVE on prod
2026-08-14 21:27 Cairo as `7996e393` (#2146) — do NOT redo or undo it.**

**Adding `?disposition=inline` to a link is NOT the fix.** An inline anchor still hands the document
to the browser's own PDF handling, and a user whose Chrome is set to download PDFs gets a silent
download from an inline URL too — no error, nothing detectable server-side. That exact incident is
why `CvPreviewModal` paints PDF pages onto `<canvas>` with pdfjs-dist instead of using an iframe.
**Only the modal reliably displays a CV.** `tests/recruitment-portal-cv-view.test.ts` therefore
asserts on the ELEMENT TYPE (must be `<Button>` opening the modal, never an `<a>`), because a
URL-based assertion would pass on the broken inline-anchor version.

**`"Failed to fetch"` here means a DOWNLOAD-MANAGER EXTENSION killed the request — not a stale
chunk.** (That was this note's first guess on 2026-08-14 and it was wrong; the failure is
reproducible, not a redeploy artefact.) IDM and its relatives hook any response that *looks like a
downloadable document* — `Content-Type: application/pdf` **plus** a `.pdf` filename in
`Content-Disposition` — and **cancel the page's own request** so they can fetch the file
themselves. The tell is exact: the in-page render dies with the browser's bare `"Failed to fetch"`
while **the same URL downloads fine seconds later, at the right size**, through the extension.

**No header can opt out** — the extension matches on precisely the headers a correct file response
must send. So the renderer must stop requesting something that looks like a file:
**`?format=base64` returns the bytes as `text/plain` with `nosniff`, no filename and NO
`Content-Disposition`**, and the client decodes them (`recruitmentFileResponse` in
`src/lib/recruitment/file-response.ts`; `base64ToBytes` in the modal). Proven byte-identical on the
CV that failed — 145,253 bytes, `%PDF-1.5`. **LIVE on prod 2026-08-14 (#2147) — do NOT undo, and
never "simplify" the renderer back to fetching the inline URL.** Images render from a blob built
from those same bytes for the same reason, which also covers photographed CVs from WhatsApp. The
`inline` mode survives only for the "Open the CV in a new tab" escape hatch beside any failure —
that link IS still grabbed by such an extension, which is expected and acceptable.

**Storage facts worth not re-deriving:** Drive is NOT configured in production (no `GOOGLE_DRIVE_*`
var among the 69) — `getRecruitmentFileStorage()` falls to **Supabase Storage**, bucket
`recruitment-files`, and the object path is stored in the **`ats_files.drive_file_id`** column. A
populated `drive_file_id` therefore does not mean Google Drive. Related:
[[never-silent-drop-count-and-flag-instead]], [[railway-merge-is-the-production-deploy]].
