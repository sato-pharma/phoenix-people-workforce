import { fetchAllRows } from "@/lib/supabase/paginated";
import type { getSupabaseAdmin } from "@/lib/supabase/server";
import { decodeErrorMessage } from "@/lib/error-monitor/message-decode";
import { redactSecretsFromRoute } from "@/lib/error-monitor/redact-route";
import { cairoOffsetMinutes } from "@/lib/format/cairo-zone";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { foldOccurrences, stillOpen, type FoldEvent, type FoldedOccurrence, type OpenOccurrence } from "@/lib/system-audit/collapse";
import { classifyAppErrorNoise, EXCLUDED_NOISE_CLASSES, thirdPartyScriptHost, type NoiseOptions } from "@/lib/system-audit/noise";
import type { PersonDirectory, PersonRecord } from "@/lib/system-audit/person-directory";
import { resolveSidebarLabel } from "@/lib/system-audit/sidebar-label";
import {
  appErrorCode,
  appErrorSignatureV1,
  guestActorKey,
  isAddress,
  parseClientContext,
  pathOnly,
  type AppErrorEventRow,
  type AppErrorSignatureParts,
} from "@/lib/system-audit/signature";
import {
  emptyDetectorResult,
  type AuditDetector,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type DetectorContext,
  type DetectorResult,
} from "@/lib/system-audit/types";

/**
 * The `app_error_fold` detector — every error a person met, as one ledger row per operation.
 *
 * Reads `app_error_events` in `(created_at, id)` keyset pages strictly after its watermark, and only
 * up to ten minutes ago (an operation still in progress is left to settle). Each row is classified
 * (noise.ts — every exclusion counted by class on the run, never dropped silently), signed
 * (signature.ts), folded with its retries (collapse.ts), named by the module the person's sidebar
 * showed (sidebar-label.ts) and attributed to a person (person-directory.ts), then written.
 *
 * EVERY WRITE CARRIES ITS WATERMARK. A batch is at most WRITE_BATCH events, so at most that many
 * occurrences — one database call, one transaction with the cursor (repository.ts chunks at 500 and
 * moves the cursor only with the last chunk; staying inside one chunk is what makes `add` safe).
 * A run that stops — budget spent, a read failed — has written exactly the events before its last
 * cursor, and the next run starts there. No event is ever folded twice, which is the whole of why
 * `add` counters can be trusted.
 *
 * NEVER calls logAppError. A failure here that wrote to the table it reads would feed itself.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

export const APP_ERROR_FOLD_DETECTOR_ID = "app_error_fold";
const DETECTOR_VERSION = 1;
/** Rows read per keyset page. */
const READ_PAGE = 1_000;
/** Events folded and written per call: never more occurrences than one repository chunk (500). */
const WRITE_BATCH = 500;
/** An operation younger than this may still be running; it is read on the next run. */
const SETTLE_MS = 10 * 60 * 1000;
/**
 * How far back an occurrence in the ledger may still be extended by a new event. The gap rule needs
 * ten minutes; a page load left open (a rep's tablet on Phoenix CRM all morning) needs longer, and
 * one fold extends it without limit. A day keeps a cron run and the historical runner in agreement
 * for any page load shorter than that.
 */
const OPEN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** How far back a person's page view may be to name an API error's module. */
const PAGE_TRAIL_WINDOW_MS = 30 * 60 * 1000;
const PAGE_TRAIL_PAGE = 1_000;
const PAGE_TRAIL_MAX_ROWS = 20_000;
const SOURCE_TABLE = "app_error_events";
const HEALTH_CHECK_LOGIN = "admin-hr";

export type AppErrorCursor = { createdAt: string; id: string };

export type AppErrorPageRequest = {
  /** Strictly after this row; null reads from the beginning. */
  after: AppErrorCursor | null;
  /** Strictly before this instant (ISO). */
  before: string;
  limit: number;
  /** Historical runs only: [fromIso, toIso) instants. */
  window?: { fromIso: string; toIso: string } | null;
};

export type PageTrailRequest = { eventId: string; hrIds: string[]; at: string };

/** Where the rows come from — the database in production, a snapshot for the historical runner. */
export interface AppErrorSource {
  readonly kind: "database" | "array";
  /** Rows ordered by `(created_at, id)` ascending, strictly after `after`, before `before` — every environment; noise.ts sorts them. */
  readPage(request: AppErrorPageRequest): Promise<AppErrorEventRow[]>;
  /** App-error occurrences in the ledger whose last event is at or after `sinceIso`. */
  readOpenOccurrences(sinceIso: string): Promise<OpenOccurrence[]>;
  /** event id → the person's last page address within 30 minutes before it. Optional. */
  recentPageViews?(requests: readonly PageTrailRequest[]): Promise<Map<string, string>>;
}

// ─── The two sources ──────────────────────────────────────────────────────────────────────────────

const EVENT_COLUMNS =
  "id, created_at, source, hr_id, login_id, role, module_key, module_label, route, route_type, message, stack, digest, release, environment, user_agent";

function cursorAfter(row: Pick<AppErrorEventRow, "created_at" | "id">, after: AppErrorCursor | null): boolean {
  if (!after) return true;
  const rowMs = Date.parse(row.created_at);
  const afterMs = Date.parse(after.createdAt);
  if (rowMs !== afterMs) return rowMs > afterMs;
  // Same millisecond: the database keeps microseconds JavaScript cannot, so the exact stored text
  // decides, then the id — the same order `order by created_at, id` produced.
  if (row.created_at !== after.createdAt) return row.created_at > after.createdAt;
  return row.id > after.id;
}

/** The snapshot the historical runner feeds in. Sorted and filtered here exactly as the database would. */
export function createArrayAppErrorSource(rows: readonly AppErrorEventRow[], open: readonly OpenOccurrence[] = []): AppErrorSource {
  const sorted = [...rows].sort((left, right) => {
    const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
    if (byTime !== 0) return byTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return {
    kind: "array",
    async readPage({ after, before, limit, window }) {
      const beforeMs = Date.parse(before);
      const out: AppErrorEventRow[] = [];
      for (const row of sorted) {
        if (out.length >= limit) break;
        const at = Date.parse(row.created_at);
        if (at >= beforeMs) break;
        if (window && (at < Date.parse(window.fromIso) || at >= Date.parse(window.toIso))) continue;
        if (!cursorAfter(row, after)) continue;
        out.push(row);
      }
      return out;
    },
    async readOpenOccurrences(sinceIso) {
      const since = Date.parse(sinceIso);
      return open.filter((occurrence) => Date.parse(occurrence.lastEventAt) >= since);
    },
  };
}

function readError(what: string, error: { message?: string; code?: string }): Error {
  const code = error.code ? ` (${error.code})` : "";
  return new Error(`System audit ${what} read failed${code}: ${error.message ?? "unknown error"}`);
}

type LedgerOpenRow = {
  dedupe_key: string;
  signature_key: string;
  occurred_at: string;
  first_event_at: string;
  last_event_at: string;
  evidence: Record<string, unknown> | null;
};

/** Production: `app_error_events`, the ledger's open occurrences, and `activity_events` page views. */
export function createDatabaseAppErrorSource(supabase: Client): AppErrorSource {
  return {
    kind: "database",
    async readPage({ after, before, limit, window }) {
      // `>=` on the time and the exact tie broken below, rather than a keyset `or(...)` — the stored
      // microseconds survive as text. Development rows are READ, not filtered here: a local run writes
      // to this table too, and noise.ts counts each one under "development" on the run, so leaving
      // them out of the query would drop them without a number.
      const read = async (strict: boolean) => {
        let query = supabase
          .from(SOURCE_TABLE)
          .select(EVENT_COLUMNS)
          .lt("created_at", before)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(limit);
        if (after) query = strict ? query.gt("created_at", after.createdAt) : query.gte("created_at", after.createdAt);
        if (window) query = query.gte("created_at", window.fromIso).lt("created_at", window.toIso);
        const { data, error } = await query;
        if (error) throw readError(SOURCE_TABLE, error);
        return (data ?? []) as AppErrorEventRow[];
      };
      const raw = await read(false);
      const rows = raw.filter((row) => cursorAfter(row, after));
      // A full page of rows tied with the cursor's own instant would never advance; skip past it.
      if (rows.length === 0 && raw.length >= limit && after) return read(true);
      return rows;
    },
    async readOpenOccurrences(sinceIso) {
      // Every open occurrence, paged: one left out here is folded again as a NEW occurrence beside it.
      let ledgerRows: LedgerOpenRow[];
      try {
        ledgerRows = await fetchAllRows<LedgerOpenRow>(
          () =>
            supabase
              .from("system_audit_occurrences")
              .select("dedupe_key, signature_key, occurred_at, first_event_at, last_event_at, evidence")
              .eq("family", "app_error")
              .gte("last_event_at", sinceIso)
              .order("last_event_at", { ascending: false }),
          "id",
        );
      } catch (error) {
        throw readError("system_audit_occurrences", error as { message?: string; code?: string });
      }
      const open: OpenOccurrence[] = [];
      for (const row of ledgerRows) {
        const evidence = row.evidence ?? {};
        const actor = typeof evidence.actor === "string" ? evidence.actor : null;
        if (!actor) continue;
        open.push({
          dedupeKey: row.dedupe_key,
          signatureKey: row.signature_key,
          actorKey: actor,
          routeFamily: typeof evidence.routeFamily === "string" ? evidence.routeFamily : null,
          occurredAt: row.occurred_at,
          firstEventAt: row.first_event_at,
          lastEventAt: row.last_event_at,
          lastPageLoadAt: typeof evidence.lastPageLoadAt === "string" ? evidence.lastPageLoadAt : null,
        });
      }
      return open;
    },
    async recentPageViews(requests) {
      const result = new Map<string, string>();
      if (requests.length === 0) return result;
      // One read per cluster of nearby errors, so a historical batch spanning weeks reads only the
      // half-hours that matter rather than every page view in between.
      const sorted = [...requests].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      const clusters: PageTrailRequest[][] = [];
      for (const request of sorted) {
        const cluster = clusters[clusters.length - 1];
        const lastAt = cluster ? Date.parse(cluster[cluster.length - 1].at) : Number.NEGATIVE_INFINITY;
        if (cluster && Date.parse(request.at) - lastAt <= PAGE_TRAIL_WINDOW_MS) cluster.push(request);
        else clusters.push([request]);
      }

      const views: { hrKey: string; path: string; at: number }[] = [];
      for (const cluster of clusters) {
        const fromIso = new Date(Date.parse(cluster[0].at) - PAGE_TRAIL_WINDOW_MS).toISOString();
        const toIso = new Date(Date.parse(cluster[cluster.length - 1].at)).toISOString();
        const keys = Array.from(new Set(cluster.flatMap((request) => request.hrIds.flatMap((id) => hrIdLookupKeys(id)))));
        for (let index = 0; index < keys.length; index += 200) {
          for (let offset = 0; ; offset += PAGE_TRAIL_PAGE) {
            // A trail cut short would name the wrong module without saying so; refuse it instead,
            // and the caller falls back to the API map and reports the source unreadable.
            if (offset >= PAGE_TRAIL_MAX_ROWS) throw new Error(`System audit activity_events read exceeded ${PAGE_TRAIL_MAX_ROWS} page views for one window`);
            const { data, error } = await supabase
              .from("activity_events")
              .select("hr_id, path, entered_at, created_at")
              .eq("event_type", "page_view")
              .in("hr_id", keys.slice(index, index + 200))
              .gte("created_at", fromIso)
              .lte("created_at", toIso)
              .order("created_at", { ascending: true })
              .order("id", { ascending: true })
              .range(offset, offset + PAGE_TRAIL_PAGE - 1);
            if (error) throw readError("activity_events", error);
            const page = (data ?? []) as { hr_id: string | null; path: string | null; entered_at: string | null; created_at: string }[];
            for (const view of page) {
              const hrKey = canonicalHrIdKey(view.hr_id);
              if (hrKey && view.path) views.push({ hrKey, path: view.path, at: Date.parse(view.entered_at ?? view.created_at) });
            }
            if (page.length < PAGE_TRAIL_PAGE) break;
          }
        }
      }
      for (const request of requests) {
        const at = Date.parse(request.at);
        const keysForPerson = new Set(request.hrIds.map((id) => canonicalHrIdKey(id)).filter(Boolean));
        let best: { path: string; at: number } | null = null;
        for (const view of views) {
          if (!keysForPerson.has(view.hrKey) || view.at > at || view.at < at - PAGE_TRAIL_WINDOW_MS) continue;
          if (!best || view.at > best.at) best = view;
        }
        if (best) result.set(request.eventId, best.path);
      }
      return result;
    },
  };
}

// ─── Turning rows into findings ───────────────────────────────────────────────────────────────────

type PreparedEvent = FoldEvent & {
  row: AppErrorEventRow;
  parts: AppErrorSignatureParts;
  isTest: boolean;
  hrKey: string | null;
  /** The ids to look the person up by: their HR id, and the login for a test or health-check row. */
  personIds: string[];
  thirdPartyHost: string | null;
};

/**
 * A signature template in words. Only the exact shapes messageTemplate emits are translated; any
 * other text (a masked message that merely contains a colon) is shown as it is.
 */
function readableTemplate(template: string): string {
  if (template === "masked-script-error") return "Browser-masked script error";
  if (template === "network:fetch-failed") return "Browser network request failed";
  if (template === "stale-chunk") return "Stale deployment — a code chunk failed to load";
  const shape = template.match(/^(react|react-switched|null-access|null-set|not-a-function|not-defined):(.+)$/);
  if (!shape) return template;
  const [, kind, detail] = shape;
  switch (kind) {
    case "react":
      if (!/^\d+$/.test(detail)) return template;
      // The template's argument is not part of the signature; "content" stands where React's
      // placeholder was, never an ellipsis that would read as a cut-off title.
      return decodeErrorMessage(`Minified React error #${detail}; visit https://react.dev/errors/${detail}`).display.replace(/…/g, "content");
    case "react-switched":
      if (detail === "unknown-cause") return "Server render failed, fell back to client rendering";
      return `Server render failed, fell back to client rendering — ${/^\d+$/.test(detail) ? `React error #${detail}` : readableTemplate(detail)}`;
    case "null-access":
      return `Read of '${detail}' on a missing value`;
    case "null-set":
      return `Write of '${detail}' on a missing value`;
    case "not-a-function":
      return `'${detail}' is not a function`;
    case "not-defined":
      return `'${detail}' is not defined`;
    default:
      return template;
  }
}

/** One readable line per signature: what failed, and where. */
export function appErrorIssueTitle(parts: AppErrorSignatureParts): string {
  const what = readableTemplate(parts.message);
  const where = parts.where ?? "";
  const [kind, ...rest] = where.split(":");
  const value = rest.join(":");
  let title = what;
  if (kind === "third-party") title = `Third-party script (${value}) — ${what}`;
  else if (kind === "component") title = `${what} (in ${value})`;
  else if (kind === "frame") title = `${what} (server: ${value})`;
  else if (kind === "job") title = `${what} (background job ${value})`;
  else if (kind === "route") title = `${what} (on ${value})`;
  if (parts.source === "server" && kind !== "frame" && kind !== "job") title = `Server: ${title}`;
  return title.slice(0, 300);
}

function technicalMessageOf(row: AppErrorEventRow): string | null {
  const raw = String(row.message ?? "").trim();
  if (!raw) return null;
  const decoded = decodeErrorMessage(raw, row.stack).display;
  return (redactSecretsFromRoute(decoded) ?? decoded).slice(0, 1000);
}

function prepare(row: AppErrorEventRow, isTest: boolean): PreparedEvent {
  const signature = appErrorSignatureV1(row);
  const login = row.login_id?.trim() || null;
  const hrId = row.hr_id?.trim() || null;
  // A test row carries the MIRRORED real person's hr_id; it is attributed to the test login so it
  // never lands on that person's line, and never merges with their own errors.
  const hrKey = isTest ? canonicalHrIdKey(login ?? hrId) : canonicalHrIdKey(hrId);
  // No HR id but a login: the login is the actor, so two logins sharing one browser never merge.
  // The directory may still name the person behind it (personFor).
  const loginKey = canonicalHrIdKey(login);
  const actorKey = hrKey ? `${isTest ? "test" : "hr"}:${hrKey}` : loginKey ? `login:${loginKey}` : guestActorKey(row.user_agent);
  return {
    id: row.id,
    createdAt: row.created_at,
    actorKey,
    signatureKey: signature.key,
    routeFamily: signature.parts.routeFamily,
    sinceNavMs: parseClientContext(row.stack).sinceNavMs,
    row,
    parts: signature.parts,
    isTest,
    hrKey,
    personIds: [hrId, login].filter((id): id is string => Boolean(id)),
    thirdPartyHost: thirdPartyScriptHost(row),
  };
}

type PersonColumns = { hrKey: string | null; display: string | null; name: string | null; role: string | null };

function personFor(event: PreparedEvent, people: Map<string, PersonRecord>): PersonColumns {
  const byHr = event.row.hr_id ? people.get(canonicalHrIdKey(event.row.hr_id) ?? "") : undefined;
  if (event.isTest) {
    const login = event.row.login_id?.trim() || event.row.hr_id?.trim() || null;
    const isHealthCheck = (login ?? "").toLowerCase() === HEALTH_CHECK_LOGIN && !event.row.hr_id?.trim();
    const name = isHealthCheck
      ? "Health-check service account"
      : byHr?.name
        ? `Test account — mirrors ${byHr.name}`
        : "Test account";
    return { hrKey: event.hrKey, display: login, name, role: event.row.role ?? null };
  }
  if (!event.hrKey) {
    // A login with no HR id on the row: the directory resolves the login to its person when one is
    // linked; otherwise the row stays unattributed rather than guessed.
    const byLogin = event.row.login_id ? people.get(canonicalHrIdKey(event.row.login_id) ?? "") : undefined;
    if (!byLogin) return { hrKey: null, display: null, name: null, role: event.row.role ?? null };
    return {
      hrKey: canonicalHrIdKey(byLogin.hrIdDisplay),
      display: byLogin.hrIdDisplay,
      name: byLogin.name,
      role: event.row.role ?? byLogin.role ?? null,
    };
  }
  return {
    hrKey: event.hrKey,
    display: byHr?.hrIdDisplay ?? canonicalHrIdForDisplay(event.row.hr_id),
    name: byHr?.name ?? null,
    role: event.row.role ?? byHr?.role ?? null,
  };
}

function compactEvidence(occurrence: FoldedOccurrence<PreparedEvent>, label: { href: string | null; source: string }): Record<string, unknown> {
  const first = occurrence.events[0];
  const context = parseClientContext(first.row.stack);
  const evidence: Record<string, unknown> = {
    actor: occurrence.actorKey,
    routeFamily: occurrence.routeFamily,
    lastPageLoadAt: occurrence.lastPageLoadAt,
    // The truthful page-load delta of this write; see file-sink.ts on the SQL's clamp to 1.
    newPageLoads: occurrence.pageLoads,
    source: first.parts.source,
    signatureWhere: first.parts.where,
    signatureMessage: first.parts.message,
  };
  if (first.row.route_type) evidence.routeType = first.row.route_type;
  if (first.row.digest) evidence.digest = first.row.digest;
  if (context.readyState) evidence.readyState = context.readyState;
  if (context.navType) evidence.navType = context.navType;
  if (context.domRewriter) evidence.domRewriter = context.domRewriter;
  if (first.thirdPartyHost) evidence.thirdPartyHost = first.thirdPartyHost;
  if (label.href) evidence.sidebarHref = label.href;
  return evidence;
}

/** Cairo midnight of a YYYY-MM-DD, as a UTC instant. */
function cairoMidnightIso(date: string): string {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const offset = cairoOffsetMinutes(new Date(utcMidnight - 2 * 60 * 60 * 1000));
  return new Date(utcMidnight - offset * 60_000).toISOString();
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function asCursor(value: Record<string, unknown> | null): AppErrorCursor | null {
  if (!value) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;
  const id = typeof value.id === "string" ? value.id : null;
  return createdAt && id ? { createdAt, id } : null;
}

export type AppErrorFoldDependencies = {
  source: AppErrorSource;
  people: PersonDirectory;
  /** Defaults to the context's clock. */
  now?: () => number;
  noise?: NoiseOptions;
};

export function createAppErrorFoldDetector(deps: AppErrorFoldDependencies): AuditDetector {
  return {
    id: APP_ERROR_FOLD_DETECTOR_ID,
    family: "app_error",
    version: DETECTOR_VERSION,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const result = emptyDetectorResult();
      const clock = deps.now ?? ctx.now;
      const before = new Date(clock() - SETTLE_MS).toISOString();
      const window = ctx.window ? { fromIso: cairoMidnightIso(ctx.window.from), toIso: cairoMidnightIso(nextDay(ctx.window.to)) } : null;

      let cursor: AppErrorCursor | null = null;
      let open: OpenOccurrence[] | null = null;
      let testRows = 0;
      let keptRows = 0;
      let occurrencesWritten = 0;
      const unreadable = new Set<string>();
      // Which step was running, so a failure names the source that could not be read — and a
      // failed WRITE is never reported as an unreadable source.
      let stage: { source: string | null } = { source: "system_audit_cursors" };

      try {
        cursor = asCursor(await ctx.sink.readCursor(APP_ERROR_FOLD_DETECTOR_ID));
        result.watermarkFrom = cursor;
        result.watermarkTo = cursor;
        for (;;) {
          if (clock() >= ctx.deadline) {
            result.status = "budget_exhausted";
            break;
          }
          stage = { source: SOURCE_TABLE };
          const page = await deps.source.readPage({ after: cursor, before, limit: READ_PAGE, window });
          // Only an empty page ends the run: the database source drops the cursor's own tied rows,
          // so a short page does not prove there is nothing after it.
          if (page.length === 0) break;
          result.scanned += page.length;

          if (open === null) {
            stage = { source: "system_audit_occurrences" };
            open = await deps.source.readOpenOccurrences(new Date(Date.parse(page[0].created_at) - OPEN_LOOKBACK_MS).toISOString());
          }

          for (let start = 0; start < page.length; start += WRITE_BATCH) {
            if (clock() >= ctx.deadline) {
              result.status = "budget_exhausted";
              break;
            }
            const batch = page.slice(start, start + WRITE_BATCH);
            const kept: PreparedEvent[] = [];
            for (const row of batch) {
              const noise = classifyAppErrorNoise(row, deps.noise);
              if (noise && EXCLUDED_NOISE_CLASSES.has(noise)) {
                result.excludedCounts[noise] = (result.excludedCounts[noise] ?? 0) + 1;
                continue;
              }
              const isTest = noise === "test_account";
              if (isTest) testRows += 1;
              kept.push(prepare(row, isTest));
            }
            keptRows += kept.length;

            // Annotated: `open` is reassigned from `folded` in this loop, which TypeScript cannot infer.
            const folded: FoldedOccurrence<PreparedEvent>[] = foldOccurrences(kept, open);
            open = stillOpen(open, folded);

            const representatives = folded.map((occurrence) => occurrence.events[0]);
            // A failed person read stops the run: a column of blank names would read as
            // unattributed errors. Nothing of this batch is written, so the next run redoes it.
            stage = { source: "employees / app_auth_users" };
            const people = await deps.people.lookup(Array.from(new Set(representatives.flatMap((event) => event.personIds))));

            // An API error names its module by the page the person last opened, when we can tell.
            let trails = new Map<string, string>();
            const trailRequests = representatives
              .filter((event) => event.hrKey && !event.isTest && isAddress(event.row.route) && (pathOnly(event.row.route) ?? "").startsWith("/api/"))
              .map((event) => ({ eventId: event.id, hrIds: event.personIds, at: event.createdAt }));
            if (trailRequests.length > 0 && deps.source.recentPageViews) {
              try {
                trails = await deps.source.recentPageViews(trailRequests);
              } catch {
                // Named by the API map instead, and the run says the trail could not be read.
                unreadable.add("activity_events");
              }
            }

            const issues = new Map<string, AuditIssueInput>();
            const occurrences: AuditOccurrenceInput[] = [];
            for (const occurrence of folded) {
              const first = occurrence.events[0];
              const person = personFor(first, people);
              const role = first.row.role ?? person.role;
              const label = resolveSidebarLabel({
                route: first.row.route,
                role,
                recentPageRoute: trails.get(first.id) ?? null,
                routeType: first.row.route_type ?? null,
              });
              const errorCode = appErrorCode(occurrence.signatureKey);
              const issue = issues.get(occurrence.signatureKey);
              const lastAt = occurrence.lastEventAt;
              if (!issue) {
                issues.set(occurrence.signatureKey, {
                  signatureKey: occurrence.signatureKey,
                  family: "app_error",
                  errorCode,
                  title: appErrorIssueTitle(first.parts),
                  rootCauseLevel: first.thirdPartyHost ? "probable" : "unknown",
                  rootCause: first.thirdPartyHost ? `third-party script (${first.thirdPartyHost})` : null,
                  rootCauseEvidence: first.thirdPartyHost ? { thirdPartyHost: first.thirdPartyHost, rule: "every located stack frame is off-app" } : {},
                  firstSeenAt: occurrence.firstEventAt,
                  lastSeenAt: lastAt,
                });
              } else {
                if (Date.parse(occurrence.firstEventAt) < Date.parse(issue.firstSeenAt ?? occurrence.firstEventAt)) issue.firstSeenAt = occurrence.firstEventAt;
                if (Date.parse(lastAt) > Date.parse(issue.lastSeenAt ?? lastAt)) issue.lastSeenAt = lastAt;
              }

              occurrences.push({
                dedupeKey: occurrence.dedupeKey,
                signatureKey: occurrence.signatureKey,
                correlationId: null,
                isRootSymptom: true,
                hrKey: person.hrKey,
                hrIdDisplay: person.display,
                employeeName: person.name,
                roleAtEvent: role,
                moduleLabel: label.label,
                moduleLabelSource: label.source,
                shell: label.shell,
                route: redactSecretsFromRoute(first.row.route),
                occurredAt: occurrence.occurredAt,
                occurredAtKind: "failure",
                affectedDate: null,
                // The words on the screen are not captured today; column 6 says so rather than guess.
                userMessage: null,
                isSilent: false,
                technicalMessage: technicalMessageOf(first.row),
                errorCode,
                attemptCount: occurrence.attemptCount,
                pageLoads: occurrence.pageLoads,
                firstEventAt: occurrence.firstEventAt,
                lastEventAt: occurrence.lastEventAt,
                sourceRefs: occurrence.sourceRefs,
                release: first.row.release ?? null,
                evidence: compactEvidence(occurrence, label),
                isTest: first.isTest,
              });
            }

            const last = batch[batch.length - 1];
            const nextCursor: AppErrorCursor = { createdAt: last.created_at, id: last.id };
            stage = { source: null };
            const written = await ctx.sink.write(APP_ERROR_FOLD_DETECTOR_ID, ctx.runId, {
              issues: [...issues.values()],
              occurrences,
              merge: "add",
              cursor: nextCursor,
            });
            result.inserted += written.inserted;
            result.updated += written.updated;
            occurrencesWritten += occurrences.length;
            cursor = nextCursor;
            result.watermarkTo = nextCursor;
          }

          if (result.status === "budget_exhausted") break;
        }
      } catch (error) {
        result.status = "errored";
        result.error = error instanceof Error ? error.message : String(error);
        if (stage.source) unreadable.add(stage.source);
      }

      result.unreadableSources = [...unreadable];
      if (result.status === "ok" && unreadable.size > 0) result.status = "partial";
      result.report = { keptRows, testAccountRows: testRows, occurrencesWritten, settleBefore: before, window };
      return result;
    },
  };
}

/**
 * The production detector. Built lazily so importing this module (the historical runner, the
 * tests) never reaches for the service-role client.
 */
export const appErrorFoldDetector: AuditDetector = {
  id: APP_ERROR_FOLD_DETECTOR_ID,
  family: "app_error",
  version: DETECTOR_VERSION,
  async run(ctx) {
    const [{ getSupabaseAdmin }, { createPersonDirectory }] = await Promise.all([
      import("@/lib/supabase/server"),
      import("@/lib/system-audit/person-directory"),
    ]);
    const supabase = getSupabaseAdmin({ requestTimeoutMs: 20_000 });
    return createAppErrorFoldDetector({
      source: createDatabaseAppErrorSource(supabase),
      people: createPersonDirectory(supabase),
    }).run(ctx);
  },
};
