import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type PayrollLineageOperation =
  | "create_batch"
  | "decide_approval"
  | "import_expenses"
  | "replace_batch"
  | "save_expenses"
  | "set_approval"
  | "workflow_transition";

export interface WritePayrollLineageInput {
  batchId?: string | null;
  importJobId?: string | null;
  actorId: string;
  requestId?: string | null;
  sourceFileName?: string | null;
  operation: PayrollLineageOperation;
  entityType?: string;
  entityId?: string | null;
  /** Arbitrary serialisable value that gets hashed into payload_hash. */
  payloadIdentity?: unknown;
  /** Op-specific details stored in the jsonb meta column. */
  meta?: Record<string, unknown> | null;
}

/**
 * Append one structured lineage row for a payroll write operation.
 *
 * Failures are logged but never thrown — lineage writes must not abort the
 * primary business operation.
 */
export async function writePayrollLineage(input: WritePayrollLineageInput): Promise<void> {
  try {
    const payloadHash = input.payloadIdentity != null
      ? createHash("sha256").update(JSON.stringify(input.payloadIdentity)).digest("hex")
      : null;

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("payroll_data_lineage").insert({
      payroll_batch_id: input.batchId ?? null,
      import_job_id:    input.importJobId ?? null,
      actor_id:         input.actorId || "system",
      request_id:       input.requestId ?? null,
      source_file_name: input.sourceFileName ?? "",
      operation:        input.operation,
      entity_type:      input.entityType ?? "payroll_batch",
      entity_id:        input.entityId ?? null,
      payload_hash:     payloadHash,
      meta:             input.meta ?? null,
    });

    if (error) {
      console.error(JSON.stringify({
        event:     "payroll_lineage_write_failed",
        operation: input.operation,
        batchId:   input.batchId ?? null,
        actorId:   input.actorId,
        error:     error.message,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      event:     "payroll_lineage_write_exception",
      operation: input.operation,
      batchId:   input.batchId ?? null,
      actorId:   input.actorId,
      error:     err instanceof Error ? err.message : String(err),
    }));
  }
}
