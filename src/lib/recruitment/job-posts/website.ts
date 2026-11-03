// Recruitment — the door to the satopharma.com careers page.
//
// SERVER ONLY. Two calls need the integration token, both behind a person's press and nothing else:
// publishJobCardToWebsite (the Publish route is its ONE caller, pinned by a test: no cron, no autopilot,
// no retry) and closeJobCardOnWebsite. The third call reads the public list and needs no token.
//
// The token goes in `Authorization`, because the website's logger redacts that header and cookies only.

import type { OpenCareersCard, PublishCard } from "@/lib/recruitment/job-posts/website-cards";

const WEBSITE_API = "https://api.satopharma.com/api/v1";
const WEBSITE_PUBLIC = "https://satopharma.com";
// Below the 30 seconds a web request is allowed, with the picture already drawn by then.
const SEND_TIMEOUT_MS = 15_000;
// The list feeds a check beside the page, so it gives up quickly and says it could not check.
const READ_TIMEOUT_MS = 5_000;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 5;

const UNANSWERED =
  "The website did not answer, so the card may or may not exist. Look at the open cards on this page. Pressing again is safe: a second card with this exact title is refused.";

/** The website refused or did not answer. `message` is written for the person who pressed the button. */
export class WebsiteCareersError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WebsiteCareersError";
    this.status = status;
  }
}

function integrationToken(): string | null {
  return process.env.SATO_WEBSITE_INTEGRATION_TOKEN?.trim() || null;
}

/** The address an applicant opens from this card. */
export function careersApplyUrl(slug: string): string {
  return `${WEBSITE_PUBLIC}/en/careers/apply?slug=${encodeURIComponent(slug)}`;
}

async function refusalOf(res: Response): Promise<WebsiteCareersError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const code = body?.error?.code;
  if (res.status === 401) return new WebsiteCareersError("The website refused this system's key. The key on the two systems does not match.", 502);
  if (res.status === 409 && code === "ALREADY_OPEN") {
    return new WebsiteCareersError("An open card already has this exact title. Close that card first, or choose another area.", 409);
  }
  if (res.status === 422 && code === "NO_APPLY_ROUTE") {
    return new WebsiteCareersError("The website says this title reaches no apply form, so applicants would only be offered email.", 422);
  }
  if (res.status === 429) return new WebsiteCareersError("The website is refusing calls for a minute after too many failed attempts. Try again shortly.", 503);
  if (res.status === 404) return new WebsiteCareersError("The website has no such card. It may already be gone.", 404);
  if (res.status >= 400 && res.status < 500) return new WebsiteCareersError(`The website refused this: ${body?.error?.message ?? `answer ${res.status}`}.`, 422);
  return new WebsiteCareersError(UNANSWERED, 502);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const token = integrationToken();
  if (!token) throw new WebsiteCareersError("This system has no key for the website yet, so nothing was sent.", 503);
  try {
    return await fetch(`${WEBSITE_API}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    throw new WebsiteCareersError(UNANSWERED, 504);
  }
}

/** One card from one press. Only the Publish route calls this. */
export async function publishJobCardToWebsite(card: PublishCard, picture: Uint8Array, filename: string): Promise<{ id: string; slug: string }> {
  const form = new FormData();
  form.set("titleEn", card.titleEn);
  form.set("titleAr", card.titleAr);
  form.set("descEn", card.descEn);
  form.set("descAr", card.descAr);
  form.set("location", card.location);
  form.set("image", new Blob([new Uint8Array(picture)], { type: "image/png" }), filename);

  const res = await send("/integrations/jobs", { body: form, method: "POST" });
  if (!res.ok) throw await refusalOf(res);
  const body = (await res.json().catch(() => null)) as { data?: { id?: string; slug?: string } } | null;
  if (!body?.data?.id || !body.data.slug) throw new WebsiteCareersError(UNANSWERED, 502);
  return { id: body.data.id, slug: body.data.slug };
}

/** Closing is the only change the website accepts from this system. */
export async function closeJobCardOnWebsite(cardId: string): Promise<void> {
  const res = await send(`/integrations/jobs/${encodeURIComponent(cardId)}`, {
    body: JSON.stringify({ status: "CLOSED" }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) throw await refusalOf(res);
}

/** Every open card on the live page, from its public list. Throws when it cannot read the whole list. */
export async function readOpenCareersCards(): Promise<OpenCareersCard[]> {
  const cards: OpenCareersCard[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const res = await fetch(`${WEBSITE_API}/jobs?limit=${LIST_PAGE_SIZE}&page=${page}`, { cache: "no-store", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The careers list answered ${res.status}`);
    const body = (await res.json()) as {
      data?: { id: string; location: string | null; slug: string; status: string; titleEn: string }[];
      meta?: { totalPages?: number };
    };
    if (!Array.isArray(body.data)) throw new Error("The careers list had no rows");
    for (const row of body.data) {
      if (row.status === "OPEN") cards.push({ id: row.id, location: row.location, slug: row.slug, title: row.titleEn });
    }
    const totalPages = body.meta?.totalPages ?? 1;
    if (page >= totalPages) return cards;
  }
  throw new Error("The careers list has more pages than this check reads");
}
