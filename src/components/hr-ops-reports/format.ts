// HR Daily & Weekly Reports — the screens' one door to the API, and the few formatters they share.
// A refusal arrives as the sentence the server wrote for a person, so it is thrown as the error's
// message and shown as is.

export async function hrOpsApi<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    method,
  });
  const json = (await response.json().catch(() => ({}))) as { message?: unknown };
  if (!response.ok) {
    throw new Error(typeof json.message === "string" && json.message ? json.message : "Something went wrong. Try again.");
  }
  return json as T;
}

/** "1 day", "0.5 day", "2 days". */
export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return "—";
  const rounded = Math.round(days * 10_000) / 10_000;
  return `${rounded} ${rounded === 1 || (rounded > 0 && rounded < 1) ? "day" : "days"}`;
}

const MONEY = new Intl.NumberFormat("en-GB", { currency: "EGP", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });

/** The decider's screen only — never imported by anything the reviewer is sent. */
export function formatEgp(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  return MONEY.format(amount);
}

const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

/** A timestamp as Cairo wall-clock: "20 Oct, 09:14". */
export function formatStamp(instant: string | null | undefined): string {
  if (!instant) return "—";
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? "—" : STAMP.format(at);
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", weekday: "short" });

/** A calendar day: "Mon 19 Oct". */
export function formatWorkDay(dateIso: string | null | undefined): string {
  if (!dateIso) return "—";
  const at = new Date(`${dateIso}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? dateIso : DAY.format(at);
}
