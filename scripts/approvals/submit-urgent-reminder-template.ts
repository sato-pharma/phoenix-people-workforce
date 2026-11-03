// =============================================================================
// Submit the approval-reminder WhatsApp template to Meta, once (owner, 3 Nov 2026)
// =============================================================================
// The reminder (src/lib/approvals/urgent-whatsapp.ts) goes out to an approver who has not written to this number, so
// only a template Meta has approved may be sent. The words are read from APPROVAL_REMINDER_TEMPLATE_BODY, never retyped
// here, so what is submitted and what the job sends can never differ. A template belongs to one business account, so it
// goes to the account holding the third number.
//
// SENDS NOTHING TO ANYONE. Meta reviews it, and the job stays silent until it reads "approved".
//
// 🔴 ONLY ON THE OWNER'S WORD. With no flag it prints the request and Meta's current status and submits nothing.
// `--apply` submits, and is refused when Meta already holds this name and language.
// =============================================================================

import {
  APPROVAL_REMINDER_TEMPLATE_BODY,
  APPROVAL_REMINDER_TEMPLATE_LANGUAGE,
  APPROVAL_REMINDER_TEMPLATE_NAME,
} from "@/lib/approvals/urgent-whatsapp-rules";
import { readTemplateStatus } from "@/lib/whatsapp-inbox/graph";
import { whatsAppApprovalsLine } from "@/lib/whatsapp-inbox/lines";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "submit-urgent-reminder-template",
  entry: import.meta.url,
  known: ["--apply", "--dry-run"],
});

const DEFAULT_GRAPH_API_VERSION = "v23.0";

/** The request body Meta's `message_templates` endpoint takes for this template. */
export function urgentReminderTemplateRequest(): Record<string, unknown> {
  return {
    category: "UTILITY",
    components: [
      {
        example: { body_text_named_params: [{ example: "3", param_name: "count" }] },
        text: APPROVAL_REMINDER_TEMPLATE_BODY,
        type: "BODY",
      },
    ],
    language: APPROVAL_REMINDER_TEMPLATE_LANGUAGE,
    name: APPROVAL_REMINDER_TEMPLATE_NAME,
    parameter_format: "NAMED",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--apply") && argv.includes("--dry-run")) throw new Error("Choose either --dry-run or --apply, not both.");
  const apply = argv.includes("--apply");

  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is required.");
  const line = whatsAppApprovalsLine();
  if (!line) throw new Error("WHATSAPP_APPROVALS_PHONE_NUMBER_ID and WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID are required.");
  const version = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
  const request = urgentReminderTemplateRequest();
  const status = await readTemplateStatus(line.businessAccountId, APPROVAL_REMINDER_TEMPLATE_NAME, APPROVAL_REMINDER_TEMPLATE_LANGUAGE);

  const summary = { currentStatus: status, request };
  if (!apply) {
    console.log(JSON.stringify({ ...summary, mode: "dry-run", status: "dry_run_ok" }, null, 2));
    return;
  }
  if (status !== "missing") {
    throw new Error(`Meta already holds ${APPROVAL_REMINDER_TEMPLATE_NAME} with status "${status}". Nothing submitted.`);
  }

  const response = await fetch(`https://graph.facebook.com/${version}/${line.businessAccountId}/message_templates`, {
    body: JSON.stringify(request),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as { id?: string; status?: string; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(`Meta refused the template: ${body?.error?.message ?? `status ${response.status}`}`);
  console.log(JSON.stringify({ ...summary, metaId: body?.id ?? null, metaStatus: body?.status ?? null, mode: "apply", status: "submitted" }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
