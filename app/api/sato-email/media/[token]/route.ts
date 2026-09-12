import { NextResponse, type NextRequest } from "next/server";

import { readSatoEmailInlineMedia } from "@/lib/sato-email/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The picture inside a Sato email, fetched by the recipient's mail app.
 *
 * 🔴 WHY THIS IS UNAUTHENTICATED, AND WHY IT HAS TO BE. Gmail, Outlook and every other mail client
 * fetch a body image with a plain anonymous GET — Gmail through its own image proxy, which carries
 * no cookie of anybody's. There is no session to check and never will be. An `<img>` in an email is
 * public by construction, which is exactly why the sender is told so on the screen that uploads it.
 *
 * 🔴 WHY THE CALLER NEVER NAMES A STORAGE PATH. The only input is a token. Bucket and path are
 * resolved here from the row, and the lookup states `kind = 'inline'`, so an attachment — a
 * contract, a payslip, whatever somebody clipped to a mail — has no address to guess even if a bug
 * one day minted it a token. Accepting a path, even a signed one, would turn this into a read
 * primitive over the whole bucket, which is the rule the marketing share-file route already states.
 *
 * A miss of any kind answers the same bare 404: a wrong token, a revoked row, an object that is not
 * a picture. Distinguishing them would tell a guesser which half of the guess was right.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  void request;
  const { token } = await context.params;

  let media: Awaited<ReturnType<typeof readSatoEmailInlineMedia>> = null;
  try {
    media = await readSatoEmailInlineMedia(token);
  } catch {
    media = null;
  }

  if (!media) {
    return new NextResponse("Not found.", {
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow, noarchive" },
      status: 404,
    });
  }

  return new NextResponse(media.bytes, {
    headers: {
      // A year, and immutable: the object id in the path is random and never reused, so this URL can
      // only ever mean this picture. Mail clients and their proxies re-fetch a body image every time
      // somebody opens the mail, and a company announcement is opened by hundreds of people at once.
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "Content-Type": media.contentType,
      // The browser must not be allowed to sniff its way to a different type than the one the
      // allowlist admitted, and the picture must not become a search result.
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
    status: 200,
  });
}
