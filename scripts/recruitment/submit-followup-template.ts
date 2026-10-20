// =============================================================================
// Submit the "Ask again" WhatsApp template to Meta, once (owner, 2026-10-20)
// =============================================================================
// "Ask again" (src/lib/recruitment/inbound/whatsapp-followup-template.ts) writes to an applicant who
// went quiet days ago — outside WhatsApp's 24-hour window, where only a template Meta has approved may
// be sent. Nothing in the codebase creates templates (src/lib/whatsapp-inbox/graph.ts only reads
// them), so this submits the one he chose, once:
//
//   phx_application_followup · English · UTILITY · one named parameter, {{name}}
//   "Hello {{name}}, thank you for applying to Sato Pharma. A few questions about your application
//    are still unanswered. Reply to this message to continue."
//
// The words are read from FOLLOWUP_TEMPLATE_BODY in that module, never retyped here, so what is
// submitted and what the button sends can never differ. It is submitted to the RECRUITMENT line's
// business account — a template belongs to one account, and "Ask again" always sends from that line.
//
// SENDS NOTHING TO ANYONE. Meta reviews the template (minutes to a day); until it is APPROVED the
// button reads "Waiting for Meta approval" and sends nothing.
//
// Usage — the dry run prints the request and Meta's current status for the name, and submits nothing:
//   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
//     --experimental-loader ./scripts/alias-loader.mjs scripts/recruitment/submit-followup-template.ts
// Submit (refused when Meta already holds a template of this name and language):
//   ... scripts/recruitment/submit-followup-template.ts --apply
// =============================================================================

import {
  FOLLOWUP_TEMPLATE_BODY,
  FOLLOWUP_TEMPLATE_LANGUAGE,
  FOLLOWUP_TEMPLATE_NAME,
} from "@/lib/recruitment/inbound/whatsapp-followup-template-rules";
import { readTemplateStatus } from "@/lib/whatsapp-inbox/graph";
import { whatsAppInboxLines } from "@/lib/whatsapp-inbox/lines";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "submit-followup-template",
  entry: import.meta.url,
  known: ["--apply", "--dry-run"],
});

const DEFAULT_GRAPH_API_VERSION = "v23.0";

/** The request body Meta's `message_templates` endpoint takes for this template. */
export function followupTemplateRequest(): Record<string, unknown> {
  return {
    category: "UTILITY",
    components: [
      {
        example: { body_text_named_params: [{ example: "Dr Ahmed", param_name: "name" }] },
        text: FOLLOWUP_TEMPLATE_BODY,
        type: "BODY",
      },
    ],
    language: FOLLOWUP_TEMPLATE_LANGUAGE,
    name: FOLLOWUP_TEMPLATE_NAME,
    parameter_format: "NAMED",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--apply") && argv.includes("--dry-run")) throw new Error("Choose either --dry-run or --apply, not both.");
  const apply = argv.includes("--apply");

  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is required.");
  const line = whatsAppInboxLines()[0];
  const version = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
  const request = followupTemplateRequest();
  const status = await readTemplateStatus(line.businessAccountId, FOLLOWUP_TEMPLATE_NAME, FOLLOWUP_TEMPLATE_LANGUAGE);

  const summary = { businessAccount: line.label, currentStatus: status, request };
  if (!apply) {
    console.log(JSON.stringify({ ...summary, mode: "dry-run", status: "dry_run_ok" }, null, 2));
    return;
  }
  if (status !== "missing") {
    throw new Error(
      `Meta already holds ${FOLLOWUP_TEMPLATE_NAME} (${FOLLOWUP_TEMPLATE_LANGUAGE}) with status "${status}". Nothing submitted.`,
    );
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
