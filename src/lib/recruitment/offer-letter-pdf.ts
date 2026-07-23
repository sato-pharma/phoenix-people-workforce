// Server-side PDF generation for the formal offer letter (carries salary; attached to the
// offer email). Renders the existing print-ready `renderOfferLetterHtml` output with headless
// Chromium for exact fidelity to the on-screen letter.
//
// This module is reachable from the shared offers/service graph, which some client components
// transitively import. puppeteer-core pulls Node built-ins (child_process, fs, …), so it is
// loaded via a `turbopackIgnore` dynamic import: never bundled (client or server), resolved at
// runtime from node_modules on the server (kept there by `serverExternalPackages`). The loader
// only ever runs on the server.
//
// Runtime requirement: a Chromium executable. In the Cloud Run image this is Alpine's system
// `chromium` (installed in the Dockerfile) at PUPPETEER_EXECUTABLE_PATH. Locally, set
// PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary to exercise it.
import type { SendPhoenixEmailAttachment } from "@/lib/email/send-phoenix-email";
import { renderOfferLetterHtml, type OfferLetterVersion } from "@/lib/recruitment/offer-letters";

function resolveChromiumPath(): string {
  return (
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROMIUM_PATH ||
    "/usr/bin/chromium-browser"
  );
}

/** Render a full HTML document to a PDF byte buffer via headless Chromium (A4, print media). */
export async function renderHtmlToPdf(html: string): Promise<Uint8Array> {
  // turbopackIgnore: do NOT bundle puppeteer-core (it drags in Node built-ins that break any
  // client bundle this module is transitively reachable from). It is resolved at runtime from
  // node_modules on the server, where this function exclusively runs.
  const puppeteer = (await import(/* turbopackIgnore: true */ "puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumPath(),
    headless: true,
    // --no-sandbox is required in the container; --disable-dev-shm-usage avoids the small
    // /dev/shm crashing Chromium under Cloud Run's constrained memory.
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.emulateMediaType("print");
    // puppeteer-core 25+ moved to the BiDi protocol, which dropped the CDP-only
    // "networkidle0"/"networkidle2" wait states — "load" (waits for images/fonts too) is the
    // closest supported equivalent for ensuring the letter's branding assets are painted.
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
    });
  } finally {
    await browser.close();
  }
}

/** Build the offer-letter PDF as an email attachment. Best-effort: throws on Chromium failure
 *  so callers can decide whether to send the email without it. */
export async function buildOfferLetterPdfAttachment(
  version: OfferLetterVersion,
): Promise<SendPhoenixEmailAttachment> {
  // The generated letter includes a screen-only "Print / Save as PDF" toolbar — strip it so it
  // never appears in the rendered document.
  const html = renderOfferLetterHtml(version).replace(/<div class="toolbar">[\s\S]*?<\/div>/i, "");
  const pdf = await renderHtmlToPdf(html);
  const offerCode = String(
    (version.snapshot as Record<string, unknown>).offerCode ?? version.offerId,
  ).replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    filename: `Offer-Letter-${offerCode}.pdf`,
    content: Buffer.from(pdf).toString("base64"),
    contentType: "application/pdf",
  };
}
