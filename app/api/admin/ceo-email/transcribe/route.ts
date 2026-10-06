import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseCeoEmail } from "@/lib/ceo-email/access";
import { CEO_DICTATION_MAX_BYTES, transcribeCeoDictation } from "@/lib/ceo-email/dictation";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Three minutes of audio over a hotel connection, then a few seconds of decoding.
export const maxDuration = 90;

/**
 * The words of one dictation. Owner 2026-10-06: he may "open the mic".
 *
 * 🔴 NOTHING IS STORED. The bytes arrive, are transcribed and are dropped — no bucket, no row, no
 * path, no retention. This is DICTATION, not the CRM's voice note, which is a stored artefact with
 * its own columns; the two must not be described as one another.
 *
 * A POST although it only reads, and deliberately: it spends money per second of audio at a third
 * party, so it carries the same same-origin refusal as a write and is never cacheable or
 * prefetchable. It is classified as a read in the access registry because it changes nothing.
 *
 * The limit is 20 a minute — he speaks a paragraph, reads it back and speaks again; a burst past
 * that is a stuck button, and each one carries up to three minutes of audio upstream.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canUseCeoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "ceo-email:transcribe",
      windowMs: 60_000,
    });

    const form = await request.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!form || !(audio instanceof File)) {
      return NextResponse.json({ message: "No recording was sent." }, { status: 400 });
    }

    // Before the bytes are read into memory, not only inside the transcriber.
    if (audio.size > CEO_DICTATION_MAX_BYTES) {
      return NextResponse.json(
        { message: "That recording is too long to turn into words. Record a shorter one, or type it instead." },
        { status: 413 },
      );
    }

    const result = await transcribeCeoDictation({
      audio: new Uint8Array(await audio.arrayBuffer()),
      contentType: audio.type,
      // The language he picked beside the microphone. It is NAMED rather than detected because
      // omitting it makes the speech service translate him into English — see
      // src/lib/ceo-email/dictation.ts. An unrecognised code becomes Arabic rather than a lost clip.
      language: form.get("language"),
    });

    // 200 with a `problem` rather than a 5xx: the box this feeds is a TEXT box with a microphone
    // beside it, so every failure has the same recovery — type it — and the sentence says so. An
    // error status would put a red banner on a screen where nothing is actually broken.
    if ("problem" in result) return NextResponse.json({ problem: result.problem });
    return NextResponse.json({ text: result.text });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: "Too many recordings in a row — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The words could not be written. Type it instead.") },
      { status: 500 },
    );
  }
}
