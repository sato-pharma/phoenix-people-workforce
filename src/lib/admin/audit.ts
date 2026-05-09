import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType = "auth_session" | "permission_override" | "user";

export type AuditLogInput = {
  actorHrId?: string | null;
  actorLoginId?: string | null;
  actorRole?: string | null;
  entityId?: string | null;
  entityType: AuditEntityType;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  requestIp?: string | null;
  summary: string;
  userAgent?: string | null;
};

export async function writeAuditLog(input: AuditLogInput) {
  const supabase = getSupabaseAdmin();
  const fullInsert = {
    actor_hr_id: input.actorHrId ?? null,
    actor_login_id: input.actorLoginId ?? "system",
    actor_role: input.actorRole ?? null,
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    request_ip: input.requestIp ?? null,
    summary: input.summary,
    user_agent: input.userAgent ?? null,
  };

  const result = await supabase.from("audit_logs").insert(fullInsert);
  if (!result.error) {
    return;
  }

  const errorCode = (result.error as { code?: string }).code;
  if (errorCode !== "42703") {
    throw result.error;
  }

  const fallbackResult = await supabase.from("audit_logs").insert({
    actor_login_id: input.actorLoginId ?? "system",
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: input.summary,
  });

  if (fallbackResult.error) {
    throw fallbackResult.error;
  }
}
