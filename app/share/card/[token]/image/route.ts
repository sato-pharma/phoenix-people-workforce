import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { parsePlainDate } from "@/lib/milestones/periods";
import { renderMilestoneCardImage } from "@/lib/milestones/render";
import { buildMilestoneCardInput } from "@/lib/milestones/service";
import { loadPerformanceCard } from "@/lib/employee-portal/performance-card";
import { renderPerformanceCardPng } from "@/lib/employee-portal/performance-card-render";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { readShareCardToken, unpackShareFocus } from "@/lib/share/share-card-token";
import { renderRepSpotlightPng } from "@/lib/spotlight/pdf";
import { loadRepSpotlight, parseRepSpotlightRange } from "@/lib/spotlight/rep-self";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The share picture behind a public link — the og:image a scraper reads, and the picture a person
 * sees when they open the link.
 *
 * UNAUTHENTICATED BY DESIGN: a LinkedIn or Facebook crawler carries no session, and that is the whole
 * point of the feature. The signed token IS the security boundary. It names the subject and the card;
 * this route renders THAT card for THAT person and nothing else — it never reads an hr id off the URL
 * or a header. A forged, tampered, or expired token is indistinguishable from a missing one: they all
 * 404, so a prober learns nothing about which links exist.
 *
 * The card is rendered with the person's resolved photo at its default framing — a public link cannot
 * carry a live drag or an uploaded picture, and must not. A spotlight link renders only while the
 * period is still eligible, so a link cannot outlive the achievement it celebrates.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = readShareCardToken(token);
  if (!payload) return new Response("Not found", { status: 404 });

  try {
    // Rate-limited PER TOKEN: a valid link is unguessable, but one that leaked should not be a free
    // handle to unlimited Chromium renders. Key on the SIGNATURE (the part after the dot) — every
    // token's payload begins with the same base64 prefix (`{"v":1,"k":…`), so the payload head is a
    // constant and would collapse every link into one global bucket; the signature is unique per link.
    const rateKey = (token.split(".")[1] ?? token).slice(0, 24);
    await assertExportRateLimit({ actor: `share:${rateKey}`, request, scope: "share:card:image" });

    let png: ArrayBuffer;
    if (payload.k === "milestone") {
      const built = await buildMilestoneCardInput({
        hrId: payload.hr,
        spec: payload.spec,
        on: parsePlainDate(payload.on),
        // Honour a deliberate monogram choice carried in the token — never re-add the photo.
        withoutPhoto: payload.np === true,
        // The framing the rep dragged, so the shared card matches what he saw (record photo only).
        photoFocus: unpackShareFocus(payload),
        photoUpload: null,
      });
      png = new Uint8Array((await renderMilestoneCardImage(built.input, "trim")).png).buffer;
    } else if (payload.k === "performance") {
      // The card always covers every PUBLISHED month, so an old link keeps showing the rep's season
      // as it stands today rather than a frozen snapshot — and it stops resolving the moment there
      // is nothing published to draw, exactly as the spotlight link does.
      const card = await loadPerformanceCard(payload.hr);
      if (!card) return new Response("Not found", { status: 404 });
      png = new Uint8Array(await renderPerformanceCardPng(card)).buffer;
    } else {
      const range = parseRepSpotlightRange({ from: payload.from, to: payload.to });
      const spotlight = await loadRepSpotlight(payload.hr, range);
      // A link must never outlive the achievement it celebrates — if the month is no longer eligible
      // (unpublished, retargeted, fell below the floor), the link stops resolving.
      if (!spotlight.eligible || !spotlight.result) return new Response("Not found", { status: 404 });
      png = new Uint8Array(await renderRepSpotlightPng(spotlight.result)).buffer;
    }

    return new Response(png, {
      headers: {
        // Public and cacheable: the picture behind a token is stable, and a scraper should not
        // re-render it. Short enough that a spotlight going ineligible is not served for long from
        // a cache. No s-maxage: nothing shared sits in front of Railway, so it had no reader.
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "image/png",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) return new Response("Too many requests", { status: 429 });
    if (error instanceof ChromiumUnavailableError) return new Response("Unavailable", { status: 503 });
    // A subject whose data is gone (no hire date, no birthday, not found) is a dead link, not an error.
    return new Response("Not found", { status: 404 });
  }
}
