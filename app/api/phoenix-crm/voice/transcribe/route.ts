import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { isVoiceTranscriptionConfigured, transcribeVoiceNote } from "@/lib/phoenix-crm/server/voice-transcribe";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = whether this path can write words at all, asked by the control BEFORE it promises any.
//
// A browser cannot see whether the key is configured, and the copy under the button is a promise: on a
// browser with no speech engine of its own, offering "the words are written when you stop" with nothing
// behind it is the failure the pinned wording exists to prevent — the rep finds out at a clinic door. So
// the screen asks, and the answer is a boolean and nothing else. It never says which service, which key,
// or why it is missing; that belongs in /admin/system-audit, not on a phone.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    return NextResponse.json({ success: true, transcription: { available: isVoiceTranscriptionConfigured() } });
  } catch (error) {
    return phoenixCrmFailure(error, "Phoenix could not check whether speech can be written out.");
  }
}

// POST = the words of a voice note this person just recorded, for a browser that has no speech engine of
// its own (Firefox). It takes the stored PATH, not the audio: the recording is already in the private
// bucket by the time the phone asks, so nothing is uploaded twice on a clinic's 3G.
//
// It is a POST although it reads rather than writes, and that is deliberate: it spends money per second
// of audio at a third party, so it carries the same same-origin refusal and the same create permission as
// a save, and it is never cacheable or prefetchable. `transcribeVoiceNote` narrows it further — only a
// note this person recorded, within two hours — which is a cost rule, not a privacy one (see that module).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const { text } = await transcribeVoiceNote(viewer, body);
    return NextResponse.json({ success: true, text });
  } catch (error) {
    return phoenixCrmFailure(error, "The words could not be written. Type the comment instead.");
  }
}
