import { NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/observability/log";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { parseHandoffWamids, type HandoffSenderId } from "@/lib/whatsapp-videos/handoff-contract";
import { listSubmissionIdsForSenders, listUnclaimedVideos, markVideosHandedOff } from "@/lib/whatsapp-videos/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Future Talents Portal's door into the WhatsApp video inbox. Server to server only: the portal
// calls this from a server action and never exposes the token to a browser.
//
// On its OWN token, FTP_VIDEO_HANDOFF_SECRET, and never CRON_SECRET. Passing `secret` makes
// assertCronAuthorized fail closed when that token is unset instead of falling back to the shared
// cron secret — so a portal misconfiguration can never be answered by a credential that also runs
// payroll jobs, and rotating one never breaks the other.
const JOB = "integrations/ftp-videos";

/**
 * Lists videos whose bytes are safe here and that the portal has not claimed, with download links,
 * and the submission ids their senders typed.
 *
 * The ids are best-effort and SAY so: if they cannot be read the videos are still listed, with
 * `senderIdsAvailable: false`, so the portal matches by number alone and tells the coordinator why
 * rather than reading an empty list as "nobody sent an id".
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, JOB, { secret: process.env.FTP_VIDEO_HANDOFF_SECRET });
  if (denied) return denied;
  try {
    const videos = await listUnclaimedVideos();
    let senderIds: HandoffSenderId[] = [];
    let senderIdsAvailable = true;
    try {
      senderIds = await listSubmissionIdsForSenders(videos.map((video) => video.waId));
    } catch (error) {
      senderIdsAvailable = false;
      logError("Could not list submission ids for the portal", {
        error,
        labels: { event: "ftp_videos_sender_ids_failed", job: JOB },
      });
    }
    return NextResponse.json({ senderIds, senderIdsAvailable, videos });
  } catch (error) {
    logError("Could not list WhatsApp videos for the portal", {
      error,
      labels: { event: "ftp_videos_list_failed", job: JOB },
    });
    return NextResponse.json({ error: "ftp_videos_list_failed" }, { status: 500 });
  }
}

/** Records which videos the portal has copied, so they are never listed again. Body: `{ wamids }`. */
export async function POST(request: Request) {
  const denied = assertCronAuthorized(request, JOB, { secret: process.env.FTP_VIDEO_HANDOFF_SECRET });
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  const wamids = parseHandoffWamids(body);
  if (!wamids) {
    return NextResponse.json({ error: "invalid_claim" }, { status: 400 });
  }

  try {
    const handedOff = await markVideosHandedOff(wamids);
    logInfo("WhatsApp videos handed off to the portal", {
      labels: { event: "ftp_videos_handed_off", handedOff, job: JOB, requested: wamids.length },
    });
    return NextResponse.json({ handedOff });
  } catch (error) {
    logError("Could not mark WhatsApp videos handed off", {
      error,
      labels: { event: "ftp_videos_handoff_failed", job: JOB },
    });
    return NextResponse.json({ error: "ftp_videos_handoff_failed" }, { status: 500 });
  }
}
