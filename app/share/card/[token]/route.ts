import { readShareCardToken } from "@/lib/share/share-card-token";
import { shareCardImageUrl, shareCardPublicUrl } from "@/lib/share/share-card-token";
import { systemDeployment } from "@/config/system-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public landing page for a shared card — the HTML a LinkedIn or Facebook crawler scrapes for its
 * post preview, and the page a person sees when they open the link.
 *
 * It is HTML, not a redirect to the image, because a crawler reads `og:image` from a page's <head>;
 * a bare image URL carries no card metadata. The page shows the same picture the meta points at, so a
 * human who clicks the shared post sees exactly what the preview showed. No auth — the signed token
 * is the capability (see the image route); a bad or expired token renders a plain "link expired" page
 * with no card and a 404, so a prober learns nothing.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = readShareCardToken(token);

  if (!payload) {
    const gone = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Link expired · Phoenix</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#94a3b8;margin:0}</style>
</head><body><main><h1>This link has expired</h1><p>Ask for a fresh one from the Phoenix portal.</p></main></body></html>`;
    return new Response(gone, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const image = shareCardImageUrl(token);
  const canonical = shareCardPublicUrl(token);
  const title =
    payload.k === "milestone"
      ? "A Sato Pharma milestone"
      : payload.k === "performance"
        ? "A Sato Pharma performance card"
        : "A Sato Pharma spotlight";
  const description =
    payload.k === "milestone"
      ? "A service anniversary or birthday at Sato Pharma."
      : payload.k === "performance"
        ? "A medical representative's achievement against target at Sato Pharma."
        : "A sales achievement recognised at Sato Pharma.";
  const portal = systemDeployment.productionUrl;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Phoenix</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Sato Pharma" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="og:image:alt" content="${escapeHtml(title)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #0b1220; color: #e2e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 460px; text-align: center; }
  .card { display: block; width: 100%; height: auto; border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 24px 60px rgba(0,0,0,0.5); background: #fff; }
  h1 { font-size: 18px; font-weight: 800; margin: 18px 0 4px; }
  p { margin: 0; color: #94a3b8; font-size: 14px; }
  a { display: inline-block; margin-top: 16px; color: #fb923c; font-weight: 700; text-decoration: none; font-size: 14px; }
</style>
</head>
<body>
<main>
  <img class="card" src="${escapeHtml(image)}" alt="${escapeHtml(title)}" />
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(description)}</p>
  <a href="${escapeHtml(portal)}">Phoenix · Sato Pharma</a>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      // No s-maxage: nothing shared sits in front of Railway, so it had no reader.
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
