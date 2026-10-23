import { createHash } from "node:crypto";

import { maskApiPath, type ScreenKind } from "@/lib/error-monitor/screen-capture-rules";
import { USER_ERROR_SCREENS_TABLE } from "@/lib/error-monitor/screen-intake";
import { redactSecretsFromRoute } from "@/lib/error-monitor/redact-route";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import type { getSupabaseAdmin } from "@/lib/supabase/server";
import { COLLAPSE_GAP_MS, MAX_SOURCE_REFS } from "@/lib/system-audit/collapse";
import { scanBounds } from "@/lib/system-audit/detectors/sync-runs";
import type { PersonDirectory, PersonRecord } from "@/lib/system-audit/person-directory";
import { resolveSidebarLabel, type SidebarLabel } from "@/lib/system-audit/sidebar-label";
import { messageTemplate } from "@/lib/system-audit/signature";
import type { ScreenPruneResult } from "@/lib/system-audit/user-screens";
import {
  emptyDetectorResult,
  SILENT_DATA_MESSAGE,
  type AuditDetector,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type DetectorContext,
  type DetectorResult,
} from "@/lib/system-audit/types";

/**
 * The `user_screens` detector — every screenshot of an error or a block a person met, folded into the
 * ledger as one row per operation, family `user_screen` (owner, 23 Oct 2026; docs/system-audit.md,
 * "What the person saw").
 *
 * Reads `user_error_screens` in `(created_at, id)` keyset pages strictly after its watermark, up to two
 * minutes ago (a picture is inserted after it is taken, so the newest rows are left to settle). Each
 * screen is signed by WHAT the person met — the kind, the API route with its record ids masked (the
 * page, for an error screen), the status and the message's engine-neutral template — and screens of
 * one signature by one person within ten minutes of each other are ONE operation, the same gap the
 * error fold uses (collapse.ts). The occurrence carries the screens' ids (≤ 50) in its evidence and
 * its source refs, which is how the row drawer finds the pictures.
 *
 * Column 6 is the EXACT words the response carried, as captured — never invented. An error screen
 * reads "Error screen shown — <its message>"; a refusal or failure that carried no words says so
 * and points at the picture.
 *
 * EVERY WRITE CARRIES ITS WATERMARK, and an operation never spans two writes (each batch folds on its
 * own), so a re-run lands on the same dedupe keys and `max` keeps them as they were.
 *
 * AFTER the fold, on a cron run only, the 90-day retention: at most 1,000 pictures older than 90 days —
 * and never past the watermark, so a picture is always in the ledger before it goes — counted in the
 * run's report (user-screens.ts `pruneUserErrorScreens`). A night that stops at that cap with pictures
 * still past their 90 days raises its own issue on the board (`buildRetentionCapFinding`).
 *
 * An error screen and the `app_error_fold` row for the same crash may both appear: one is the picture
 * of what the person saw, the other the error the browser reported. That is expected and documented.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

export const USER_SCREENS_DETECTOR = "user_screens";
const DETECTOR_VERSION = 1;
export const USER_SCREEN_SIGNATURE_VERSION = 1;
/** A picture younger than this may still be on its way into the table; read next run. */
const SETTLE_MS = 2 * 60 * 1000;
/** Rows read and written per batch — never more occurrences than one repository chunk (500). */
const READ_PAGE = 500;
const MAX_EVIDENCE_SCREENS = 50;

export type UserScreenRow = {
  id: string;
  created_at: string;
  hr_id: string | null;
  login_id: string | null;
  role: string | null;
  kind: ScreenKind;
  http_status: number | null;
  method: string | null;
  api_path: string | null;
  page_path: string | null;
  message: string | null;
  release: string | null;
  is_test: boolean;
};

export type UserScreenCursor = { createdAt: string; id: string };

export interface UserScreenSource {
  /** Rows ordered by `(created_at, id)`, strictly after `after`, before `before`, inside `window` when given. */
  readPage(request: { after: UserScreenCursor | null; before: string; limit: number; window: { fromIso: string; toIso: string | null } | null }): Promise<UserScreenRow[]>;
}

// ─── The signature ────────────────────────────────────────────────────────────────────────────────

/** Where the screen happened: the masked API route, or the masked page for an error screen. */
export function userScreenWhere(row: Pick<UserScreenRow, "kind" | "api_path" | "page_path">): string {
  const where = row.kind === "error_screen" ? maskApiPath(row.page_path) : maskApiPath(row.api_path);
  return where ?? "unknown";
}

/**
 * The key every screen of the same kind of refusal shares, whoever met it and on whichever record:
 * kind + masked route + status + the message's template (numbers, ids and quoted values masked).
 * Versioned: a rule change bumps USER_SCREEN_SIGNATURE_VERSION and the key carries it.
 */
export function userScreenSignature(row: Pick<UserScreenRow, "kind" | "api_path" | "page_path" | "http_status" | "message">): string {
  const parts = [USER_SCREEN_SIGNATURE_VERSION, row.kind, userScreenWhere(row), row.http_status ?? null, messageTemplate(row.message)];
  const hash = createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
  return `screen:v${USER_SCREEN_SIGNATURE_VERSION}:${hash}`;
}

/** `SCREEN-1A2B3C4D` — column 7's short reference, from the signature's own hash. */
export function userScreenErrorCode(signatureKey: string): string {
  const hash = signatureKey.split(":").pop() ?? "";
  return `SCREEN-${hash.slice(0, 8).toUpperCase()}`;
}

const NO_WORDS = "the answer carried no message; the screenshot shows what was on the screen";

/** Column 6: the exact words captured, or what is known when there were none. */
export function userScreenMessage(row: Pick<UserScreenRow, "kind" | "http_status" | "message">): string {
  const words = row.message?.trim() || null;
  if (row.kind === "error_screen") return words ? `Error screen shown — ${words}` : "Error screen shown";
  if (words) return words;
  if (row.kind === "refused_request") return `Refused (HTTP ${row.http_status ?? "status not recorded"}) — ${NO_WORDS}`;
  return row.http_status ? `Failed (HTTP ${row.http_status}) — ${NO_WORDS}` : `No answer — the request failed on the network; the screenshot shows what was on the screen`;
}

/** One readable line per signature. */
export function userScreenIssueTitle(row: Pick<UserScreenRow, "kind" | "api_path" | "page_path" | "http_status" | "method" | "message">): string {
  const where = userScreenWhere(row);
  const words = row.message?.trim() ? ` — ${row.message.trim().slice(0, 160)}` : "";
  const method = row.method ? `${row.method} ` : "";
  let title: string;
  if (row.kind === "error_screen") title = `Error screen shown on ${where}${words}`;
  else if (row.kind === "refused_request") title = `Refused — ${method}${where} (HTTP ${row.http_status ?? "?"})${words}`;
  else if (row.http_status) title = `Failed — ${method}${where} (HTTP ${row.http_status})${words}`;
  else title = `No answer — ${method}${where} (network failure)${words}`;
  return title.slice(0, 300);
}

function technicalMessage(row: UserScreenRow): string {
  const api = redactSecretsFromRoute(row.api_path) ?? row.api_path;
  const page = redactSecretsFromRoute(row.page_path) ?? row.page_path;
  let what: string;
  if (row.kind === "error_screen") what = `The error screen was shown on ${page ?? "a page with no recorded address"}.`;
  else if (row.http_status) what = `${row.method ?? "A request to"} ${api ?? "an API"} answered HTTP ${row.http_status}${page ? ` on ${page}` : ""}.`;
  else what = `${row.method ?? "A request to"} ${api ?? "an API"} got no answer (network failure)${page ? ` on ${page}` : ""}.`;
  return (row.message?.trim() ? `${what} Message: ${row.message.trim()}` : what).slice(0, 1000);
}

// ─── The fold ─────────────────────────────────────────────────────────────────────────────────────

function actorKeyOf(row: UserScreenRow): string {
  const login = canonicalHrIdKey(row.login_id);
  if (row.is_test) return `test:${login ?? canonicalHrIdKey(row.hr_id) ?? "unknown"}`;
  const hr = canonicalHrIdKey(row.hr_id);
  if (hr) return `hr:${hr}`;
  return login ? `login:${login}` : "unknown";
}

type PersonColumns = { hrKey: string | null; display: string | null; name: string | null; role: string | null };

function personFor(row: UserScreenRow, people: ReadonlyMap<string, PersonRecord>): PersonColumns {
  if (row.is_test) {
    // Filed under the test login, never the employee it mirrors.
    const login = row.login_id?.trim() || null;
    return { hrKey: canonicalHrIdKey(login), display: login, name: "Test account", role: row.role };
  }
  const hrKey = canonicalHrIdKey(row.hr_id);
  if (hrKey) {
    const known = people.get(hrKey);
    return { hrKey, display: known?.hrIdDisplay ?? canonicalHrIdForDisplay(row.hr_id), name: known?.name ?? null, role: row.role ?? known?.role ?? null };
  }
  const byLogin = row.login_id ? people.get(canonicalHrIdKey(row.login_id) ?? "") : undefined;
  if (!byLogin) return { hrKey: null, display: null, name: null, role: row.role };
  return { hrKey: canonicalHrIdKey(byLogin.hrIdDisplay), display: byLogin.hrIdDisplay, name: byLogin.name, role: row.role ?? byLogin.role };
}

function compareRows(left: UserScreenRow, right: UserScreenRow): number {
  const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export type UserScreenFindings = { issues: AuditIssueInput[]; occurrences: AuditOccurrenceInput[] };

/**
 * Pure: one batch of screens → ledger rows. Screens of one signature by one person within ten minutes
 * of the last are one operation; anything else starts a new one. Exported for the test.
 */
export function buildUserScreenFindings(input: {
  rows: readonly UserScreenRow[];
  people: ReadonlyMap<string, PersonRecord>;
  label?: (input: { route: string | null; role: string | null; recentPageRoute: string | null }) => SidebarLabel;
}): UserScreenFindings {
  const label = input.label ?? ((args) => resolveSidebarLabel(args));
  const groups: Array<{ signatureKey: string; actorKey: string; rows: UserScreenRow[]; lastMs: number }> = [];
  const open = new Map<string, (typeof groups)[number]>();
  for (const row of [...input.rows].sort(compareRows)) {
    const signatureKey = userScreenSignature(row);
    const actorKey = actorKeyOf(row);
    const key = `${actorKey}\u0000${signatureKey}`;
    const at = Date.parse(row.created_at);
    const current = open.get(key);
    if (current && at - current.lastMs <= COLLAPSE_GAP_MS) {
      current.rows.push(row);
      current.lastMs = Math.max(current.lastMs, at);
      continue;
    }
    const fresh = { signatureKey, actorKey, rows: [row], lastMs: at };
    groups.push(fresh);
    open.set(key, fresh);
  }

  const issues = new Map<string, AuditIssueInput>();
  const occurrences: AuditOccurrenceInput[] = [];
  for (const group of groups) {
    const first = group.rows[0];
    const last = group.rows[group.rows.length - 1];
    const errorCode = userScreenErrorCode(group.signatureKey);
    const issue = issues.get(group.signatureKey);
    if (!issue) {
      issues.set(group.signatureKey, {
        signatureKey: group.signatureKey,
        family: "user_screen",
        errorCode,
        title: userScreenIssueTitle(first),
        firstSeenAt: first.created_at,
        lastSeenAt: last.created_at,
      });
    } else {
      if (Date.parse(first.created_at) < Date.parse(issue.firstSeenAt ?? first.created_at)) issue.firstSeenAt = first.created_at;
      if (Date.parse(last.created_at) > Date.parse(issue.lastSeenAt ?? last.created_at)) issue.lastSeenAt = last.created_at;
    }

    const person = personFor(first, input.people);
    const page = redactSecretsFromRoute(first.page_path) ?? first.page_path;
    const where = label({ route: page ?? first.api_path, role: person.role, recentPageRoute: page });
    const screenIds = group.rows.slice(0, MAX_EVIDENCE_SCREENS).map((row) => row.id);
    occurrences.push({
      dedupeKey: `${group.signatureKey}:${group.actorKey}:${first.id}`,
      signatureKey: group.signatureKey,
      correlationId: null,
      isRootSymptom: true,
      hrKey: person.hrKey,
      hrIdDisplay: person.display,
      employeeName: person.name,
      roleAtEvent: person.role,
      moduleLabel: where.label,
      moduleLabelSource: where.source,
      shell: where.shell,
      route: page,
      occurredAt: first.created_at,
      occurredAtKind: "failure",
      affectedDate: null,
      userMessage: userScreenMessage(first),
      isSilent: false,
      technicalMessage: technicalMessage(first),
      errorCode,
      relatedTable: USER_ERROR_SCREENS_TABLE,
      relatedId: first.id,
      attemptCount: group.rows.length,
      // A picture says nothing about page loads; one is the honest floor the ledger requires.
      pageLoads: 1,
      firstEventAt: first.created_at,
      lastEventAt: last.created_at,
      sourceRefs: group.rows.slice(0, MAX_SOURCE_REFS).map((row) => row.id),
      release: first.release,
      evidence: {
        actor: group.actorKey,
        screenKind: first.kind,
        httpStatus: first.http_status,
        method: first.method,
        where: userScreenWhere(first),
        screens: group.rows.length,
        screenIds,
        ...(where.href ? { sidebarHref: where.href } : {}),
      },
      isTest: first.is_test,
    });
  }
  return { issues: [...issues.values()], occurrences };
}

// ─── The source ───────────────────────────────────────────────────────────────────────────────────

const COLUMNS = "id, created_at, hr_id, login_id, role, kind, http_status, method, api_path, page_path, message, release, is_test";

function cursorAfter(row: Pick<UserScreenRow, "created_at" | "id">, after: UserScreenCursor | null): boolean {
  if (!after) return true;
  const rowMs = Date.parse(row.created_at);
  const afterMs = Date.parse(after.createdAt);
  if (rowMs !== afterMs) return rowMs > afterMs;
  // Same millisecond: the stored microseconds decide, then the id — the order the query used.
  if (row.created_at !== after.createdAt) return row.created_at > after.createdAt;
  return row.id > after.id;
}

export function createDatabaseUserScreenSource(supabase: Client): UserScreenSource {
  return {
    async readPage({ after, before, limit, window }) {
      const read = async (strict: boolean) => {
        let query = supabase
          .from(USER_ERROR_SCREENS_TABLE)
          .select(COLUMNS)
          .lt("created_at", before)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(limit);
        if (after) query = strict ? query.gt("created_at", after.createdAt) : query.gte("created_at", after.createdAt);
        if (window) {
          query = query.gte("created_at", window.fromIso);
          if (window.toIso) query = query.lt("created_at", window.toIso);
        }
        const { data, error } = await query;
        if (error) throw new Error(`System audit ${USER_ERROR_SCREENS_TABLE} read failed${error.code ? ` (${error.code})` : ""}: ${error.message}`);
        return (data ?? []) as UserScreenRow[];
      };
      const raw = await read(false);
      const rows = raw.filter((row) => cursorAfter(row, after));
      // A full page of rows tied with the cursor's own instant would never advance; skip past it.
      if (rows.length === 0 && raw.length >= limit && after) return read(true);
      return rows;
    },
  };
}

function asCursor(value: Record<string, unknown> | null): UserScreenCursor | null {
  if (!value) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;
  const id = typeof value.id === "string" ? value.id : null;
  return createdAt && id ? { createdAt, id } : null;
}

// ─── The removal's own alarm ──────────────────────────────────────────────────────────────────────

export const RETENTION_CAP_SIGNATURE = "screen:retention-cap";
export const RETENTION_CAP_ERROR_CODE = "SCREEN-RETENTION-CAP";
const SYSTEM_AUDIT_PAGE = "/admin/system-audit";

function cairoDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/**
 * The night's removal stopped at its cap with pictures still past their 90 days → one issue on the
 * board, so the morning message says so (owner, 23 Oct 2026: "alert when the nightly screenshot
 * removal hits its 1,000 cap"). Before this the only trace was `candidates` in the run report, which
 * nobody reads: after a day of more than 1,000 captures (an outage) pictures outlive the owner's 90
 * days for as many nights as the backlog takes, and nothing said so.
 *
 * ONE issue, ONE occurrence per Cairo night it happens, so the message carries it the first night
 * (a NEW issue) and again only if it comes back after being closed (REOPENED) — not every night of
 * the same backlog. A full batch that left nothing behind (exactly 1,000 due) raises nothing; an
 * unreadable count does raise it, saying the count could not be read — never "caught up".
 */
export function buildRetentionCapFinding(
  retention: ScreenPruneResult,
  nowIso: string,
  label: (input: { route: string | null; role: string | null; recentPageRoute: string | null }) => SidebarLabel = (args) =>
    resolveSidebarLabel(args),
): { issue: AuditIssueInput; occurrence: AuditOccurrenceInput } | null {
  if (!retention.capped || retention.remaining === 0) return null;
  const count = (value: number) => value.toLocaleString("en-US");
  const waiting =
    retention.remaining === null
      ? "how many are still waiting could not be counted"
      : `${count(retention.remaining)} picture${retention.remaining === 1 ? " is" : "s are"} still past their 90 days`;
  const where = label({ route: SYSTEM_AUDIT_PAGE, role: "Super Admin", recentPageRoute: null });
  const technical =
    `The nightly screenshot removal stopped at its cap of ${count(retention.cap)} ` +
    `(${count(retention.deletedRows)} removed, ${count(retention.keptForRetry)} kept for retry, cutoff ${retention.cutoff}); ` +
    `${waiting}. Each night removes up to ${count(retention.cap)} more, oldest first.`;
  return {
    issue: {
      signatureKey: RETENTION_CAP_SIGNATURE,
      family: "user_screen",
      errorCode: RETENTION_CAP_ERROR_CODE,
      title: `Screenshot removal hit its nightly cap of ${count(retention.cap)} — pictures are outliving their 90 days`,
      rootCauseLevel: "confirmed",
      rootCause: `More pictures fell past 90 days than one night removes (${count(retention.cap)} — SCREEN_PRUNE_BATCH in src/lib/system-audit/user-screens.ts).`,
      rootCauseEvidence: { cutoff: retention.cutoff, remaining: retention.remaining, deletedRows: retention.deletedRows },
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    },
    occurrence: {
      dedupeKey: `${RETENTION_CAP_SIGNATURE}:${cairoDay(nowIso)}`,
      signatureKey: RETENTION_CAP_SIGNATURE,
      hrKey: null,
      moduleLabel: where.label,
      moduleLabelSource: where.source,
      shell: where.shell,
      route: SYSTEM_AUDIT_PAGE,
      occurredAt: nowIso,
      occurredAtKind: "detected",
      userMessage: SILENT_DATA_MESSAGE,
      isSilent: true,
      technicalMessage: technical,
      errorCode: RETENTION_CAP_ERROR_CODE,
      relatedTable: USER_ERROR_SCREENS_TABLE,
      relatedId: null,
      evidence: {
        cap: retention.cap,
        cutoff: retention.cutoff,
        candidates: retention.candidates,
        deletedRows: retention.deletedRows,
        deletedFiles: retention.deletedFiles,
        keptForRetry: retention.keptForRetry,
        remaining: retention.remaining,
      },
    },
  };
}

// ─── The detector ─────────────────────────────────────────────────────────────────────────────────

export type UserScreensDetectorDeps = {
  source: UserScreenSource;
  people: PersonDirectory;
  /** The 90-day retention; omitted, nothing is removed (a test, or the historical runner). */
  prune?: (input: { nowMs: number; notAfter: string | null }) => Promise<ScreenPruneResult>;
};

export function createUserScreensDetector(deps: UserScreensDetectorDeps): AuditDetector {
  return {
    id: USER_SCREENS_DETECTOR,
    family: "user_screen",
    version: DETECTOR_VERSION,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const result = emptyDetectorResult();
      const before = new Date(ctx.now() - SETTLE_MS).toISOString();
      const window = ctx.window ? scanBounds(ctx, null) : null;
      let occurrencesWritten = 0;
      let testScreens = 0;
      let cursor: UserScreenCursor | null = null;
      let stage: string | null = "system_audit_watermarks";
      try {
        cursor = ctx.mode === "cron" ? asCursor(await ctx.sink.readCursor(USER_SCREENS_DETECTOR)) : null;
        result.watermarkFrom = cursor;
        result.watermarkTo = cursor;
        for (;;) {
          if (ctx.now() >= ctx.deadline) {
            result.status = "budget_exhausted";
            break;
          }
          stage = USER_ERROR_SCREENS_TABLE;
          const rows = await deps.source.readPage({
            after: cursor,
            before,
            limit: READ_PAGE,
            window: window ? { fromIso: window.fromIso, toIso: window.toIso } : null,
          });
          if (rows.length === 0) break;
          result.scanned += rows.length;
          testScreens += rows.filter((row) => row.is_test).length;

          stage = "employees / app_auth_users";
          const ids = Array.from(new Set(rows.filter((row) => !row.is_test).flatMap((row) => [row.hr_id, row.login_id]).filter((id): id is string => Boolean(id?.trim()))));
          const people = await deps.people.lookup(ids);
          const findings = buildUserScreenFindings({ rows, people });

          const last = rows[rows.length - 1];
          const next: UserScreenCursor = { createdAt: last.created_at, id: last.id };
          stage = null;
          const written = await ctx.sink.write(USER_SCREENS_DETECTOR, ctx.runId, {
            issues: findings.issues,
            occurrences: findings.occurrences,
            // Each operation is whole inside its batch, so a re-read lands on itself and changes nothing.
            merge: "max",
            // Historical runs leave the watermark to the runner.
            cursor: ctx.mode === "cron" ? next : null,
          });
          result.inserted += written.inserted;
          result.updated += written.updated;
          occurrencesWritten += findings.occurrences.length;
          cursor = next;
          result.watermarkTo = next;
          // Only an empty page ends the run: the source drops rows tied with the cursor, so a short
          // page does not prove there is nothing after it.
        }
      } catch (error) {
        result.status = "errored";
        result.error = error instanceof Error ? error.message : String(error);
        if (stage) result.unreadableSources.push(stage);
      }

      // The 90-day retention runs on the nightly sweep only, after the fold, and never past what the
      // ledger holds. A retention failure is reported, never allowed to undo the fold above.
      let retention: ScreenPruneResult | { error: string } | null = null;
      let retentionAlert: "raised" | "none" | { error: string } = "none";
      if (ctx.mode === "cron" && deps.prune) {
        try {
          const pruned = await deps.prune({ nowMs: ctx.now(), notAfter: cursor?.createdAt ?? null });
          retention = pruned;
          if (pruned.error && result.status === "ok") result.status = "partial";
          // A night that stopped at the cap with pictures still past 90 days goes on the board before
          // the sweep's morning message reads it. The watermark is left where the fold put it.
          const finding = buildRetentionCapFinding(pruned, new Date(ctx.now()).toISOString());
          if (finding) {
            try {
              const written = await ctx.sink.write(USER_SCREENS_DETECTOR, ctx.runId, {
                issues: [finding.issue],
                occurrences: [finding.occurrence],
                merge: "max",
                cursor: null,
              });
              result.inserted += written.inserted;
              result.updated += written.updated;
              retentionAlert = "raised";
            } catch (error) {
              retentionAlert = { error: error instanceof Error ? error.message : String(error) };
              if (result.status === "ok") result.status = "partial";
            }
          }
        } catch (error) {
          retention = { error: error instanceof Error ? error.message : String(error) };
          if (result.status === "ok") result.status = "partial";
        }
      }

      if (result.status === "ok" && result.unreadableSources.length > 0) result.status = "partial";
      result.report = { screens: result.scanned, testScreens, occurrencesWritten, settleBefore: before, window, retention, retentionAlert };
      return result;
    },
  };
}

/** The production detector. Built lazily so importing this module never reaches for the service-role client. */
export const userScreensDetector: AuditDetector = {
  id: USER_SCREENS_DETECTOR,
  family: "user_screen",
  version: DETECTOR_VERSION,
  async run(ctx) {
    const [{ getSupabaseAdmin }, { createPersonDirectory }, { pruneUserErrorScreens }] = await Promise.all([
      import("@/lib/supabase/server"),
      import("@/lib/system-audit/person-directory"),
      import("@/lib/system-audit/user-screens"),
    ]);
    const supabase = getSupabaseAdmin({ requestTimeoutMs: 20_000 });
    return createUserScreensDetector({
      source: createDatabaseUserScreenSource(supabase),
      people: createPersonDirectory(supabase),
      prune: (input) => pruneUserErrorScreens(input, supabase),
    }).run(ctx);
  },
};
