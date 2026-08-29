import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo } from "@/lib/observability/log";
import {
  pollAllSalesMailboxes,
  summarizeSalesPollFailures,
  type SalesMailboxPollSummary,
} from "@/lib/sales/inbox/poller";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Collect the distributor sales workbooks that arrived by email.
 *
 * WHAT IT REPLACES. Seventeen distributor files were imported for period 2026-07 (18 in June, 17
 * in May, 19 in April), and the July set took ten days to assemble. Every one arrived as an email
 * attachment and was then carried into Phoenix by hand: noticed, downloaded, matched to a
 * distributor in a dropdown, uploaded. This job does the noticing, the downloading and the
 * matching, and parks the file in the same `sales-imports` bucket the upload screen already reads
 * from — so the person doing the close finds the file waiting on the right step instead of hunting
 * for it in a mailbox.
 *
 * IT NEVER IMPORTS. An arrival is a file and a guess at who sent it, nothing more. The preview and
 * the commit stay exactly where they are: with a person. A monthly closing is the most
 * consequential number this company publishes, and an auto-import would be the one place in the
 * whole pipeline where nobody ever looked.
 *
 * IT NOTIFIES NOBODY. No mail, no in-app, no Telegram, no push. The arrivals surface inside the
 * Monthly Sales wizard, where the work already happens.
 *
 * INERT UNTIL CONFIGURED. With SALES_EMAIL_INBOXES_JSON unset there are no mailboxes, so every run
 * is a clean no-op — deliberately a success, not an error. The credential it needs cannot be
 * issued from here: Turbify app passwords are created browser-side from inside each mailbox.
 *
 * A MAILBOX THAT CANNOT BE REACHED IS A FAILURE, not a quiet 200. An expired app password would
 * otherwise leave this job green while distributor files piled up unread through an entire close.
 */
class SalesInboxPollError extends Error {
  constructor(
    readonly failures: string[],
    readonly summaries: SalesMailboxPollSummary[],
  ) {
    super(`Sales inbox intake failed for ${failures.length} mailbox/folder(s): ${failures.join("; ")}`);
    this.name = "SalesInboxPollError";
  }
}

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/sales-inbox-intake");
  if (denied) return denied;

  try {
    const summaries = await withDeadMansSwitch("phoenix-sales-inbox-intake", async () => {
      const result = await pollAllSalesMailboxes();
      const failures = summarizeSalesPollFailures(result);
      if (failures.length > 0) throw new SalesInboxPollError(failures, result);
      return result;
    });

    const folders = summaries.flatMap((mailbox) => mailbox.folders);
    const recorded = folders.reduce((total, folder) => total + folder.arrivalsRecorded, 0);
    const stalled = folders.filter((folder) => folder.stalledAtUid !== undefined);

    // Only a run that actually found something writes a line. This job ticks all day and the log
    // is worth nothing if every tick fills it with "found nothing", which is the normal state.
    if (recorded > 0) {
      logInfo("Sales inbox intake recorded new distributor workbooks", {
        labels: { event: "sales_inbox_arrivals_recorded", job: "sales-inbox-intake" },
        context: {
          arrivalsRecorded: recorded,
          mailboxes: summaries.map((mailbox) => mailbox.mailboxLabel),
        },
      });
    }

    // A held cursor is not a failed run — every later message was still read — but it does mean one
    // message is being re-read every cycle and will be until somebody looks at it. Said out loud
    // here because the alternative is a folder quietly re-reading the same message forever.
    if (stalled.length > 0) {
      logError("Sales inbox intake is holding a cursor on a message it could not process", {
        labels: { event: "sales_inbox_cursor_stalled", job: "sales-inbox-intake" },
        context: {
          stalled: stalled.map((folder) => ({
            cursorLabel: folder.cursorLabel,
            folderPath: folder.folderPath,
            stalledAtUid: folder.stalledAtUid,
          })),
        },
      });
    }

    return NextResponse.json({
      success: true,
      arrivalsRecorded: recorded,
      duplicates: folders.reduce((total, folder) => total + folder.duplicates, 0),
      oversizeSkipped: folders.reduce((total, folder) => total + folder.oversizeSkipped, 0),
      backlogRemaining: folders.some((folder) => folder.backlogRemaining),
      stalledFolders: stalled.length,
      mailboxesConfigured: summaries.length,
      mailboxes: summaries,
    });
  } catch (error) {
    logError("Sales inbox intake poll failed", {
      error,
      labels: { event: "cron_failed", job: "sales-inbox-intake" },
    });
    const message = clientSafeErrorMessage(error, "Sales inbox intake poll failed.");
    return NextResponse.json(
      {
        error: "sales_inbox_intake_failed",
        mailboxes: error instanceof SalesInboxPollError ? error.summaries : undefined,
        message,
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
