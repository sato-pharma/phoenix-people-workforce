/**
 * Retention register domain service — HR Business Partner job description §3.
 *
 * The register answers one business question that Phoenix could not answer before: *why do people
 * leave, and what is holding the ones still here?* Individual conversations are the evidence; the
 * theme roll-up is the answer.
 *
 * Confidentiality is the design constraint. A stay discussion is an employee telling HR what they
 * think of their manager and their pay, and an exit interview is the same in the past tense. The
 * `retention` permission resource is therefore held by HR Advisory, Super Admin and the CEO only —
 * deliberately not by HR Operations, and never by a line manager.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { conflictError, validationError } from "@/lib/http/api-errors";
import type { AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  CreateRetentionConversationInput,
  RetentionConversation,
  RetentionConversationKind,
  RetentionConversationTheme,
  RetentionDashboardData,
  RetentionRisk,
  RetentionStats,
  RetentionTheme,
  RetentionThemeInput,
  RetentionThemeRollup,
  RetentionThemeSentiment,
  UpdateRetentionConversationInput,
} from "./types";

const retentionKinds: RetentionConversationKind[] = ["stay", "exit"];
const retentionRisks: RetentionRisk[] = ["low", "medium", "high"];
const retentionSentiments: RetentionThemeSentiment[] = ["driver", "blocker"];

/** How far back the coverage and roll-up figures look. A year of conversations is the useful lens. */
const ROLLUP_WINDOW_DAYS = 365;

type ThemeRow = {
  theme_key: string;
  label: string;
  description: string | null;
  sort_order: number;
};

type ConversationRow = {
  id: string;
  kind: RetentionConversationKind;
  employee_hr_id: string;
  employee_name: string;
  job_title: string | null;
  line_name: string | null;
  conducted_on: string;
  conducted_by: string | null;
  resignation_id: string | null;
  retention_risk: RetentionRisk | null;
  is_regrettable: boolean | null;
  would_rejoin: boolean | null;
  summary: string;
  follow_up_action: string | null;
  follow_up_due: string | null;
  follow_up_done_at: string | null;
  created_at: string;
  updated_at: string;
};

type ConversationThemeRow = {
  conversation_id: string;
  theme_key: string;
  sentiment: RetentionThemeSentiment;
  note: string | null;
};

export function retentionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "Retention request failed.");
  }
  return "Retention request failed.";
}

/**
 * True when the retention tables have not reached this environment. Kept distinct from a real
 * failure so the page says so rather than rendering a misleading zero (AGENTS.md §7).
 */
export function isRetentionSchemaMissing(error: unknown): boolean {
  const message = retentionErrorMessage(error).toLowerCase();
  return (
    message.includes("hr_retention_") &&
    (message.includes("does not exist") ||
      message.includes("could not find") ||
      message.includes("schema cache") ||
      message.includes("relation"))
  );
}

function isoDaysAgo(days: number, today: string): string {
  const base = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(base)) return today;
  return new Date(base - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Validate a conversation payload against the same rules the database enforces, so a mistake
 * reads as a sentence rather than a constraint violation. The CHECK constraint stays the
 * authority — this is presentation, not the gate.
 */
function assertKindFields(
  kind: RetentionConversationKind,
  risk: RetentionRisk | null | undefined,
  isRegrettable: boolean | null | undefined,
): void {
  if (!retentionKinds.includes(kind)) {
    throw new Error(`A conversation is either a stay discussion or an exit interview, not "${kind}".`);
  }
  if (kind === "stay") {
    if (!risk) throw new Error("A stay discussion needs a retention risk of low, medium or high.");
    if (!retentionRisks.includes(risk)) throw new Error(`Unknown retention risk "${risk}".`);
    if (isRegrettable !== null && isRegrettable !== undefined) {
      throw new Error("Regrettable applies to an exit interview, not a stay discussion.");
    }
    return;
  }
  if (isRegrettable === null || isRegrettable === undefined) {
    throw new Error("An exit interview needs to say whether the departure was regrettable.");
  }
  if (risk !== null && risk !== undefined) {
    throw new Error("Retention risk applies to a stay discussion, not an exit interview.");
  }
}

function normalizeThemes(themes: RetentionThemeInput[] | undefined): RetentionThemeInput[] {
  if (!themes?.length) return [];
  const seen = new Set<string>();
  const normalized: RetentionThemeInput[] = [];
  for (const theme of themes) {
    const key = theme.themeKey?.trim();
    if (!key) continue;
    if (!retentionSentiments.includes(theme.sentiment)) {
      throw new Error(`A theme is either a driver or a blocker, not "${theme.sentiment}".`);
    }
    // (theme, sentiment) is unique per conversation in the database; de-duplicated here so a
    // double-click is a no-op rather than a constraint error.
    const dedupeKey = `${key}::${theme.sentiment}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ themeKey: key, sentiment: theme.sentiment, note: theme.note?.trim() || null });
  }
  return normalized;
}

async function resolveNames(hrIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(hrIds.map((id) => id.trim()).filter(Boolean))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;

  const supabase = getSupabaseAdmin();
  // Chunked at 50 — a PostgREST `.in()` with hundreds of ids returns zero rows and no error.
  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50);
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname")
      .in("hr_id", chunk);
    if (error) {
      logError("Retention could not resolve interviewer names", {
        labels: { event: "retention_name_resolution_failed" },
        context: { requested: chunk.length },
        error,
      });
      continue;
    }
    for (const row of (data ?? []) as { hr_id: string; full_name: string; nickname: string | null }[]) {
      names.set(row.hr_id, resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id));
    }
  }
  return names;
}

function buildRollup(
  conversations: RetentionConversation[],
  themes: RetentionTheme[],
): RetentionThemeRollup[] {
  const labelOf = new Map(themes.map((theme) => [theme.themeKey, theme.label]));
  const sortOf = new Map(themes.map((theme) => [theme.themeKey, theme.sortOrder]));
  const buckets = new Map<string, RetentionThemeRollup>();

  for (const conversation of conversations) {
    for (const theme of conversation.themes) {
      let bucket = buckets.get(theme.themeKey);
      if (!bucket) {
        bucket = {
          themeKey: theme.themeKey,
          label: labelOf.get(theme.themeKey) ?? theme.label,
          driverCount: 0,
          blockerCount: 0,
          exitBlockerCount: 0,
          stayDriverCount: 0,
          total: 0,
        };
        buckets.set(theme.themeKey, bucket);
      }
      if (theme.sentiment === "driver") {
        bucket.driverCount += 1;
        if (conversation.kind === "stay") bucket.stayDriverCount += 1;
      } else {
        bucket.blockerCount += 1;
        if (conversation.kind === "exit") bucket.exitBlockerCount += 1;
      }
      bucket.total += 1;
    }
  }

  // Loudest theme first — the page's job is to say what is actually driving turnover. Ties fall
  // back to the catalogue order so the list is stable between loads.
  return [...buckets.values()].sort(
    (a, b) =>
      b.total - a.total ||
      (sortOf.get(a.themeKey) ?? 999) - (sortOf.get(b.themeKey) ?? 999) ||
      a.label.localeCompare(b.label),
  );
}

export async function getRetentionDashboardData(
  _access: AccessContext,
): Promise<RetentionDashboardData> {
  const supabase = getSupabaseAdmin();
  const today = currentCairoDateOnlyIso();
  const windowStart = isoDaysAgo(ROLLUP_WINDOW_DAYS, today);

  const [themesResult, conversationsResult] = await Promise.all([
    supabase
      .from("hr_retention_themes")
      .select("theme_key,label,description,sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("hr_retention_conversations")
      .select(
        "id,kind,employee_hr_id,employee_name,job_title,line_name,conducted_on,conducted_by,resignation_id,retention_risk,is_regrettable,would_rejoin,summary,follow_up_action,follow_up_due,follow_up_done_at,created_at,updated_at",
      )
      .gte("conducted_on", windowStart)
      .order("conducted_on", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);

  const emptyStats: RetentionStats = {
    stayCount: 0,
    exitCount: 0,
    highRisk: 0,
    regrettableExits: 0,
    wouldRejoin: 0,
    openFollowUps: 0,
    overdueFollowUps: 0,
    exitCoveragePercent: null,
    resignationsInWindow: 0,
  };

  if (themesResult.error) {
    if (isRetentionSchemaMissing(themesResult.error)) {
      return { conversations: [], themes: [], rollup: [], stats: emptyStats, schemaReady: false };
    }
    throw new Error(retentionErrorMessage(themesResult.error));
  }
  if (conversationsResult.error) {
    if (isRetentionSchemaMissing(conversationsResult.error)) {
      return { conversations: [], themes: [], rollup: [], stats: emptyStats, schemaReady: false };
    }
    throw new Error(retentionErrorMessage(conversationsResult.error));
  }

  const themes: RetentionTheme[] = ((themesResult.data ?? []) as ThemeRow[]).map((row) => ({
    themeKey: row.theme_key,
    label: row.label,
    description: row.description,
    sortOrder: row.sort_order,
  }));
  const labelOf = new Map(themes.map((theme) => [theme.themeKey, theme.label]));
  const rows = (conversationsResult.data ?? []) as ConversationRow[];

  const themesByConversation = new Map<string, RetentionConversationTheme[]>();
  for (let index = 0; index < rows.length; index += 50) {
    const ids = rows.slice(index, index + 50).map((row) => row.id);
    const { data, error } = await supabase
      .from("hr_retention_conversation_themes")
      .select("conversation_id,theme_key,sentiment,note")
      .in("conversation_id", ids);
    if (error) throw new Error(retentionErrorMessage(error));
    for (const row of (data ?? []) as ConversationThemeRow[]) {
      const entry: RetentionConversationTheme = {
        themeKey: row.theme_key,
        // Falls back to the key so a retired theme still renders as something, never as blank.
        label: labelOf.get(row.theme_key) ?? row.theme_key,
        sentiment: row.sentiment,
        note: row.note,
      };
      const bucket = themesByConversation.get(row.conversation_id);
      if (bucket) bucket.push(entry);
      else themesByConversation.set(row.conversation_id, [entry]);
    }
  }

  const names = await resolveNames(
    rows.map((row) => row.conducted_by).filter((value): value is string => Boolean(value)),
  );

  const conversations: RetentionConversation[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    jobTitle: row.job_title,
    lineName: row.line_name,
    conductedOn: row.conducted_on,
    conductedBy: row.conducted_by,
    conductedByName: row.conducted_by ? (names.get(row.conducted_by) ?? null) : null,
    resignationId: row.resignation_id,
    retentionRisk: row.retention_risk,
    isRegrettable: row.is_regrettable,
    wouldRejoin: row.would_rejoin,
    summary: row.summary,
    followUpAction: row.follow_up_action,
    followUpDue: row.follow_up_due,
    followUpDoneAt: row.follow_up_done_at,
    followUpOverdue: Boolean(
      row.follow_up_action && !row.follow_up_done_at && row.follow_up_due && row.follow_up_due < today,
    ),
    themes: (themesByConversation.get(row.id) ?? []).sort(
      (a, b) => a.sentiment.localeCompare(b.sentiment) || a.label.localeCompare(b.label),
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  // Exit coverage: how many of the people who actually left were interviewed. Counted against
  // resignations in the same window, and left null when nobody left — a percentage over an empty
  // base is a lie, not a zero.
  let resignationsInWindow = 0;
  const resignationCount = await supabase
    .from("employee_resignations")
    .select("id", { count: "exact", head: true })
    .gte("last_working_date", windowStart)
    .lte("last_working_date", today);
  if (resignationCount.error) {
    logError("Retention could not count resignations for exit coverage", {
      labels: { event: "retention_coverage_count_failed" },
      context: { windowStart, today },
      error: resignationCount.error,
    });
  } else {
    resignationsInWindow = resignationCount.count ?? 0;
  }

  const exitCount = conversations.filter((c) => c.kind === "exit").length;
  const stats: RetentionStats = {
    stayCount: conversations.filter((c) => c.kind === "stay").length,
    exitCount,
    highRisk: conversations.filter((c) => c.retentionRisk === "high").length,
    regrettableExits: conversations.filter((c) => c.isRegrettable === true).length,
    wouldRejoin: conversations.filter((c) => c.wouldRejoin === true).length,
    openFollowUps: conversations.filter((c) => c.followUpAction && !c.followUpDoneAt).length,
    overdueFollowUps: conversations.filter((c) => c.followUpOverdue).length,
    exitCoveragePercent:
      resignationsInWindow > 0
        ? Math.round((Math.min(exitCount, resignationsInWindow) / resignationsInWindow) * 100)
        : null,
    resignationsInWindow,
  };

  return { conversations, themes, rollup: buildRollup(conversations, themes), stats, schemaReady: true };
}

/** The theme rows phx_create_retention_conversation / phx_update_retention_conversation insert. */
function themeRows(themes: RetentionThemeInput[]) {
  return themes.map((theme) => ({
    theme_key: theme.themeKey,
    sentiment: theme.sentiment,
    note: theme.note ?? null,
  }));
}

/**
 * The error a failed retention write throws. A lost compare-and-set (40001 from
 * phx_update_retention_conversation: someone else saved the conversation since this editor loaded
 * it) is a 409 the route answers as such, never a 500; anything else keeps its plain message.
 */
function retentionWriteError(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "40001") return conflictError(retentionErrorMessage(error), "retention_conversation_changed");
  return new Error(retentionErrorMessage(error));
}

/** The updated_at the editor's screen loaded, when it sent one — refused if it is not a timestamp. */
function expectedUpdatedAtFromInput(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw validationError("The conversation's loaded version is not a valid timestamp. Reload the page and try again.");
  }
  return value;
}

export async function createRetentionConversation(
  input: CreateRetentionConversationInput,
  actor: string,
): Promise<string> {
  assertKindFields(input.kind, input.retentionRisk, input.isRegrettable);
  const summary = input.summary?.trim() ?? "";
  if (summary === "") throw new Error("A conversation needs a summary of what was said.");
  const employeeHrId = input.employeeHrId?.trim() ?? "";
  if (employeeHrId === "") throw new Error("A conversation needs the employee it was held with.");
  const themes = normalizeThemes(input.themes);

  const supabase = getSupabaseAdmin();
  // Snapshot the person: an exit interview is about someone who has left the directory by the
  // time anyone reads the roll-up.
  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("hr_id,full_name,nickname,job_title")
    .eq("hr_id", employeeHrId)
    .maybeSingle();
  if (employeeError) throw new Error(retentionErrorMessage(employeeError));
  if (!employee) throw new Error(`No employee found with HR ID ${employeeHrId}.`);

  const row = employee as { hr_id: string; full_name: string; nickname: string | null; job_title: string | null };
  // The conversation and its themes in ONE transaction (F-HR-011): a failure part-way leaves
  // nothing behind, so a retry can never make a duplicate of a half-written conversation.
  const { data, error } = await supabase.rpc("phx_create_retention_conversation", {
    p_conversation: {
      kind: input.kind,
      employee_hr_id: row.hr_id,
      employee_name: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      job_title: row.job_title,
      conducted_on: input.conductedOn || currentCairoDateOnlyIso(),
      conducted_by: actor,
      resignation_id: input.resignationId ?? null,
      retention_risk: input.kind === "stay" ? (input.retentionRisk ?? null) : null,
      is_regrettable: input.kind === "exit" ? (input.isRegrettable ?? null) : null,
      would_rejoin: input.kind === "exit" ? (input.wouldRejoin ?? null) : null,
      summary,
      follow_up_action: input.followUpAction?.trim() || null,
      follow_up_due: input.followUpDue || null,
      created_by: actor,
    },
    p_themes: themeRows(themes),
  });
  if (error) throw retentionWriteError(error);
  if (typeof data !== "string" || data === "") throw new Error("The conversation was not recorded.");

  const conversationId = data;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "hr_retention_conversation",
    entityId: conversationId,
    summary: `Recorded a ${input.kind === "stay" ? "stay discussion" : "exit interview"} with ${row.full_name}`,
    // Deliberately NOT the summary text. The audit row records that a confidential conversation
    // was captured and by whom; the content stays in the register behind its own permission.
    newValues: {
      kind: input.kind,
      employeeHrId: row.hr_id,
      conductedOn: input.conductedOn,
      themeCount: themes.length,
    },
  });
  return conversationId;
}

export async function updateRetentionConversation(
  input: UpdateRetentionConversationInput,
  actor: string,
): Promise<void> {
  // Validated before anything is read or written: the version the editor's screen loaded.
  const expectedUpdatedAt = expectedUpdatedAtFromInput(input.expectedUpdatedAt);
  const supabase = getSupabaseAdmin();
  const { data: before, error: beforeError } = await supabase
    .from("hr_retention_conversations")
    .select("id,kind,employee_name,retention_risk,is_regrettable,would_rejoin,follow_up_action,follow_up_due,follow_up_done_at,updated_at")
    .eq("id", input.id)
    .maybeSingle();
  if (beforeError) throw new Error(retentionErrorMessage(beforeError));
  if (!before) throw new Error("That conversation no longer exists.");

  const current = before as {
    kind: RetentionConversationKind;
    employee_name: string;
    retention_risk: RetentionRisk | null;
    is_regrettable: boolean | null;
    updated_at: string | null;
  };

  // Re-check the kind rules against the MERGED result, not the patch alone: clearing a stay
  // conversation's risk by sending `null` would otherwise slip past and hit the CHECK constraint.
  const mergedRisk =
    input.retentionRisk !== undefined ? input.retentionRisk : current.retention_risk;
  const mergedRegrettable =
    input.isRegrettable !== undefined ? input.isRegrettable : current.is_regrettable;
  assertKindFields(current.kind, mergedRisk, mergedRegrettable);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.summary !== undefined) {
    const summary = input.summary.trim();
    if (summary === "") throw new Error("A conversation needs a summary of what was said.");
    patch.summary = summary;
  }
  if (input.retentionRisk !== undefined) patch.retention_risk = current.kind === "stay" ? mergedRisk : null;
  if (input.isRegrettable !== undefined) patch.is_regrettable = current.kind === "exit" ? mergedRegrettable : null;
  if (input.wouldRejoin !== undefined) {
    patch.would_rejoin = current.kind === "exit" ? (input.wouldRejoin ?? null) : null;
  }
  if (input.followUpAction !== undefined) patch.follow_up_action = input.followUpAction?.trim() || null;
  if (input.followUpDue !== undefined) patch.follow_up_due = input.followUpDue || null;
  if (input.followUpDone !== undefined) {
    patch.follow_up_done_at = input.followUpDone ? new Date().toISOString() : null;
  }

  // Themes are normalised BEFORE anything is written, so a bad sentiment refuses the whole edit.
  const themes = input.themes !== undefined ? normalizeThemes(input.themes) : null;

  // The conversation patch and the themes commit together or not at all, and only if nobody else
  // changed the conversation since the editor's SCREEN loaded it (compare-and-set on the updated_at
  // it sent; the server's own read above only when an older client sent none) - F-HR-011.
  const { error } = await supabase.rpc("phx_update_retention_conversation", {
    p_conversation_id: input.id,
    p_patch: patch,
    p_themes: themes === null ? null : themeRows(themes),
    p_expected_updated_at: expectedUpdatedAt ?? current.updated_at ?? null,
  });
  if (error) throw retentionWriteError(error);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "hr_retention_conversation",
    entityId: input.id,
    summary: `Updated the ${current.kind === "stay" ? "stay discussion" : "exit interview"} with ${current.employee_name}`,
    // Field names only, never the confidential text — see the note on the create path.
    oldValues: { fields: Object.keys(patch).filter((key) => key !== "updated_at") },
    newValues: { themesReplaced: input.themes !== undefined, followUpDone: input.followUpDone ?? null },
  });
}
