import { getSupabaseAdmin } from "@/lib/supabase/server";

// Unified email engagement (who OPENED / who CLICKED), read from email_delivery_events — the
// table fed by BOTH the Resend and Brevo webhooks. This is admin-only; the calling page enforces
// the `communication:read` gate (mirrors the Email Delivery page), so no per-row scoping here.

export type EmailEngagementEvent = {
  id: string;
  link: string | null;
  occurredAt: string;
  provider: string;
  recipientEmail: string;
  recipientName: string | null;
  status: "opened" | "clicked";
  subject: string | null;
};

export type EmailEngagementData = {
  events: EmailEngagementEvent[];
  generatedAt: string;
  summary: { clicked: number; opened: number; providers: string[]; recipients: number };
};

export type EmailEngagementOptions = {
  days?: number;
  limit?: number;
  search?: string;
  status?: "all" | "clicked" | "opened";
};

type EventRow = {
  id: string;
  occurred_at: string;
  provider: string | null;
  raw_event: Record<string, unknown> | null;
  recipients: string[] | null;
  status: string | null;
  subject: string | null;
};

function clickedLink(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const candidate = raw.link ?? raw.URL ?? raw.url ?? (raw.data as { link?: unknown } | undefined)?.link;
  const value = typeof candidate === "string" ? candidate.trim() : "";
  return value || null;
}

export async function getEmailEngagement(options: EmailEngagementOptions = {}): Promise<EmailEngagementData> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const days = options.days && options.days > 0 ? options.days : 30;
  const search = (options.search ?? "").trim().toLowerCase();

  // Fetch a generous recent window of engagement events; filter/slice in memory so a name/email
  // search can match either field without a bespoke SQL text index.
  let query = supabase
    .from("email_delivery_events")
    .select("id,provider,status,subject,recipients,occurred_at,raw_event")
    .gte("occurred_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
    .order("occurred_at", { ascending: false })
    .limit(500);

  if (options.status === "opened" || options.status === "clicked") {
    query = query.eq("status", options.status);
  } else {
    query = query.in("status", ["opened", "clicked"]);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as EventRow[];

  // Resolve recipient emails → employee names (case-insensitive).
  const emails = Array.from(new Set(rows.flatMap((row) => row.recipients ?? []).map((email) => email.trim()).filter(Boolean)));
  const nameByEmail = new Map<string, string>();
  if (emails.length > 0) {
    const { data: employees } = await supabase.from("employees").select("full_name,work_email").in("work_email", emails);
    for (const employee of (employees ?? []) as Array<{ full_name: string | null; work_email: string | null }>) {
      const key = employee.work_email?.trim().toLowerCase();
      if (key && employee.full_name) nameByEmail.set(key, employee.full_name);
    }
  }

  const events: EmailEngagementEvent[] = [];
  for (const row of rows) {
    const status = row.status === "clicked" ? "clicked" : "opened";
    for (const rawEmail of row.recipients ?? []) {
      const recipientEmail = rawEmail.trim();
      if (!recipientEmail) continue;
      const recipientName = nameByEmail.get(recipientEmail.toLowerCase()) ?? null;
      if (search && !recipientEmail.toLowerCase().includes(search) && !(recipientName ?? "").toLowerCase().includes(search)) {
        continue;
      }
      events.push({
        id: `${row.id}:${recipientEmail}`,
        link: status === "clicked" ? clickedLink(row.raw_event) : null,
        occurredAt: row.occurred_at,
        provider: row.provider ?? "unknown",
        recipientEmail,
        recipientName,
        status,
        subject: row.subject,
      });
      if (events.length >= limit) break;
    }
    if (events.length >= limit) break;
  }

  return {
    events,
    generatedAt: new Date().toISOString(),
    summary: {
      clicked: events.filter((event) => event.status === "clicked").length,
      opened: events.filter((event) => event.status === "opened").length,
      providers: Array.from(new Set(events.map((event) => event.provider))).sort(),
      recipients: new Set(events.map((event) => event.recipientEmail.toLowerCase())).size,
    },
  };
}
