import { NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/observability/log";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { drainInboundIntake } from "@/lib/recruitment/inbound/intake-worker";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { refuseOnPageServer } from "@/lib/platform/worker-only-route";
import { cacheInboxMedia, linkInboxChatsByPhone } from "@/lib/whatsapp-inbox/store";
import { fetchPendingInboundVideos } from "@/lib/whatsapp-videos/inbox";
import { thankDueFtpVideoSenders } from "@/lib/whatsapp-videos/thanks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Drains the inbound-CV intake queue (ats_inbound_intake_queue). The WhatsApp webhook and the email
// poller only ENQUEUE; this worker does the media download + AI + candidate creation, with retries
// and dead-lettering. Runs frequently so a queued CV becomes a candidate within a couple of
// minutes. A clean no-op when the queue is empty.
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/inbound-intake");
  if (denied) return denied;
  const wrongProcess = refuseOnPageServer("cron/inbound-intake");
  if (wrongProcess) return wrongProcess;
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    const maxItems = Number.isFinite(limit) && limit > 0 ? Math.min(25, Math.floor(limit)) : undefined;
    // Slug matches the live Cloud Scheduler job name (phoenix-inbound-intake).
    const result = await withDeadMansSwitch("phoenix-inbound-intake", () => drainInboundIntake(maxItems));
    const deadLettered = result.results.filter((r) => r.status === "dead").length;
    if (result.processed > 0) {
      logInfo("Inbound intake queue drained", {
        labels: { deadLettered, event: "inbound_intake_drained", job: "inbound-intake", processed: result.processed },
      });
    }

    // Inbound VIDEOS ride this same tick rather than getting a cron job of their own. Two reasons,
    // and neither is laziness: the scheduler is cron-job.org, whose REST API allows 100 requests a
    // DAY and cannot roll a bulk edit back, so adding a job is a change to live infrastructure for
    // something that does nothing at all until the HR handset is linked; and this tick is already
    // where a WhatsApp media id gets redeemed for bytes, so its failure mode is one somebody here
    // already knows how to read.
    //
    // Deliberately OUTSIDE the dead man's switch, and its errors deliberately swallowed. That
    // switch reports on the CV queue — it is what the alarm was built for — and a video backlog
    // must never be able to mark that job unhealthy. The CV drain above has also already happened
    // by this point, so its result must be returned whatever happens here.
    const videos = await fetchPendingInboundVideos().catch((videoError) => {
      logError("Inbound WhatsApp video fetch failed", {
        error: videoError,
        labels: { event: "whatsapp_video_fetch_threw", job: "inbound-intake" },
      });
      return null;
    });

    // The FTP video thank-you (owner 2026-09-13): sent here, after the fetch, to senders who have gone
    // quiet with an unanswered video. Same reasoning as the fetch — outside the switch, never fatal.
    const thanks = await thankDueFtpVideoSenders().catch((thanksError) => {
      logError("FTP video thank-you tick failed", {
        error: thanksError,
        labels: { event: "ftp_video_thanks_tick_threw", job: "inbound-intake" },
      });
      return null;
    });

    // The WhatsApp Inbox's attachments: Meta keeps a media file for a limited time only, so each photo,
    // file and voice note is copied into Phoenix's own storage soon after it arrives. Same terms as the
    // two above — outside the switch, never fatal, bounded per tick.
    const inboxMedia = await cacheInboxMedia().catch((inboxError) => {
      logError("WhatsApp Inbox media copy failed", {
        error: inboxError,
        labels: { event: "whatsapp_inbox_media_cache_threw", job: "inbound-intake" },
      });
      return null;
    });

    // Whoever a chat can only mean, once their record exists. Same terms: outside the switch, never fatal.
    const inboxLinks = await linkInboxChatsByPhone().catch((linkError) => {
      logError("WhatsApp Inbox phone linking failed", {
        error: linkError,
        labels: { event: "whatsapp_inbox_phone_links_threw", job: "inbound-intake" },
      });
      return null;
    });

    return NextResponse.json({ success: true, ...result, inboxLinks, inboxMedia, thanks, videos });
  } catch (error) {
    logError("Inbound intake worker failed", {
      error,
      labels: { event: "cron_failed", job: "inbound-intake" },
    });
    const message = clientSafeErrorMessage(error, "Inbound intake worker failed.");
    return NextResponse.json({ error: "inbound_intake_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
