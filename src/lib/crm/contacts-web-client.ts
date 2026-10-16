/**
 * Server-only client for the CRM's WEB app — the only place a rep's assigned contact list exists.
 *
 * THIS IS NOT THE REPORTING API. The Reporting API (src/lib/crm/client.ts) has no contacts
 * endpoint; verified 2026-08-28 against the vendor's Postman collection, the API documentation
 * PDF's endpoint list and ER diagram, and the live swagger, which serves exactly nine paths. The
 * contact list lives on the CRM's ASP.NET WebForms site, which is a DIFFERENT HOST — the API is on
 * `…-site7`, the web app on `…-site10`. Both accept the same service-account credentials.
 *
 * WHY SCRAPING IS THE RIGHT CALL HERE AND STILL NEEDS WATCHING. The vendor will not deploy a new
 * endpoint, and this list is the only source for a doctor who has never been planned or visited —
 * 448 of them on the first sweep. But an HTML grid is not a contract: if the vendor redesigns that
 * page, this breaks. Every parse failure below is therefore LOUD (throws, named), never a silent
 * empty list, because a silent empty list is indistinguishable from "this rep has no doctors" and
 * would prune a real mirror to nothing. `assertContactGridShape` is the specific guard.
 *
 * THREE TRAPS THIS PAGE CARRIES — the first two cost real time on 2026-08-28, the third on
 * 2026-09-03.
 *
 *  1. The pharmacy list type is spelled `Pharmacy` in the URL, NOT `PH`. Asking for an unknown type
 *     returns HTTP 200 with a well-formed but EMPTY grid rather than an error, so a sweep using
 *     `t=PH` reported "0 pharmacies" for every rep and looked entirely credible — while the agents
 *     grid's own counter said 45 to 59 for the same people. LIST_TYPES below is the only spelling.
 *
 *  2. `Agents.aspx` pages 50 rows at a time and its page-size combo offers only 10/20/50, so there
 *     is no "show everything" option. It must be walked with the Next Page postback, reposting
 *     every hidden field — seven pages, 305 agents. That grid also carries each agent's PM/AM/
 *     Pharmacy COUNTS, which is what makes trap 1 detectable without fetching anything.
 *
 *  3. The agents grid has NO login-name column. Its `Manager` column holds the SUPERVISOR's Real
 *     Name, and was parsed into a field called `username` until 2026-09-03 — see the
 *     `supervisor` field on `CrmAgentRow` and the column map in `parseAgentGrid`. Identify an account by its `label` and
 *     nothing else: matching employees on `label` OR the manager value credits a dormant account
 *     to the live manager above it, and because every such value is a real serving employee the
 *     mismatch is invisible. One ad-hoc audit reported 19 accounts as retirable instead of 48.
 *
 * The agents grid's own Yes/No active column is NOT Phoenix's roster — it marks 121 medical-rep
 * accounts live against 67 active Medical Representatives in `employees`, because the CRM admin
 * never deletes an account, he blanks the name and clones a new one. Callers drive the sweep from
 * Phoenix's employee roster; this module only reports what the CRM says.
 */

import { getIReports360Config, type IReports360Config } from "@/lib/crm/config";
import { recordTiming } from "@/lib/observability/timings";

/** The three lists an agent can hold. The vendor's exact spelling — see trap 1 in the header. */
export const LIST_TYPES = ["PM", "AM", "Pharmacy"] as const;
export type CrmListType = (typeof LIST_TYPES)[number];

export class CrmWebError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "CrmWebError";
    this.status = status;
  }
}

export type CrmWebSession = {
  baseUrl: string;
  cookie: string;
  timeoutMs: number;
};

export type CrmContactRow = {
  address: string | null;
  city: string | null;
  contactCrmId: number;
  grade: string | null;
  name: string | null;
  nameAr: string | null;
  phone: string | null;
  region: string | null;
  speciality: string | null;
  zone: string | null;
};

export type CrmAgentRow = {
  agentCrmId: number;
  amCount: number;
  hiringDate: string | null;
  /** The CRM's own active flag. NOT Phoenix's roster — see the module header. */
  isActive: boolean;
  /** The `[Name ]( Area / Line )` account label. Nameless means the holder resigned. */
  label: string | null;
  line: string | null;
  pharmacyCount: number;
  pmCount: number;
  /**
   * The account this one reports to, as the grid's `Manager` column renders it: the SUPERVISOR's
   * own `Real Name` value, verbatim — usually a bare `Firstname.Lastname`, occasionally the full
   * `[Name ]( Area / Line )` label (13 of 305 on 2026-09-03), blank for the few accounts at the top.
   *
   * THIS IS NOT THE ACCOUNT'S LOGIN NAME, and it was called `username` until 2026-09-03. The grid
   * has no login column at all. Reading it as one is silently wrong in the worst possible way:
   * every value is a real, currently-employed person, so an audit that matched CRM accounts to
   * employees on `label` OR this field credited 22 dormant accounts to the live managers above
   * them and called them still in service — 19 deactivation candidates reported instead of 48.
   * Match an account to a person on `label` ALONE.
   */
  supervisor: string | null;
  /** The grid's `Privilege` column — the CRM's own role name, e.g. `Medical Rep`. */
  title: string | null;
};

/**
 * The web app's host. Derived from the API base URL by default because the two differ only in the
 * site number, which keeps this to one env var in every environment that already works — but
 * overridable, because "differ only in the site number" is an observation about today's hosting and
 * not a promise the vendor made.
 */
export function resolveCrmWebBaseUrl(config: IReports360Config): string {
  const override = process.env.IREPORTS360_WEB_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return config.baseUrl.replace(/-site\d+\./, "-site10.");
}

function hiddenField(html: string, name: string): string {
  const match = html.match(
    new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "i"),
  );
  return match ? match[1] : "";
}

function decodeCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => decodeCell(cell[1]));
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

async function request(
  session: CrmWebSession,
  path: string,
  init: RequestInit = {},
): Promise<{ body: string; response: Response }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), session.timeoutMs);
  // The body read is INSIDE this try on purpose. It used to sit after the `finally`, which meant
  // the deadline expired the moment response HEADERS arrived and the HTML grid could then stream
  // (or not stream) forever. Same defect, same vendor, as the /visits stall of 2026-09-02 — see
  // fetchJson in ./client.ts. `aborted` is read off the signal because a mid-body abort arrives
  // as `TypeError: terminated`, not as an AbortError.
  const asCrmWebError = (error: unknown): CrmWebError =>
    controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
      ? new CrmWebError("The CRM web app timed out.", 504)
      : new CrmWebError(
          `The CRM web app could not be reached: ${error instanceof Error ? error.message : "network error"}.`,
          502,
        );
  try {
    let response: Response;
    try {
      response = await fetch(`${session.baseUrl}${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          // The grid is rendered server-side for a browser; a bare fetch is served the same HTML, but
          // the UA is sent so the vendor's logs show a recognisable, attributable caller.
          "User-Agent": "PhoenixWorkforce/1.0 (+contact-list-sync)",
          ...(session.cookie ? { Cookie: session.cookie } : {}),
          ...(init.headers ?? {}),
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw asCrmWebError(error);
    }

    try {
      return { body: await response.text(), response };
    } catch (error) {
      throw asCrmWebError(error);
    }
  } finally {
    clearTimeout(timer);
  }
}

function collectCookies(response: Response, existing: string): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  // Node 18+ / undici. Falls back to the single-header form so this cannot throw on a runtime
  // without getSetCookie — an empty jar surfaces as a login failure, not a crash.
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : ([response.headers.get("set-cookie")].filter(Boolean) as string[]);
  for (const cookie of raw) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

/**
 * Logs the service account into the CRM web app and returns a cookie-bearing session.
 *
 * The handshake is ordinary WebForms: GET the login page for its `ASP.NET_SessionId` and the three
 * hidden state fields, then POST those back with the credentials. Success is a 302 to `/Main.aspx`
 * — a 200 means the page re-rendered with an error on it, which is what a wrong password looks
 * like, so anything other than a redirect is treated as a failed login rather than retried.
 */
export async function crmWebLogin(config = getIReports360Config()): Promise<CrmWebSession> {
  const session: CrmWebSession = {
    baseUrl: resolveCrmWebBaseUrl(config),
    cookie: "",
    timeoutMs: config.timeoutMs,
  };

  const page = await request(session, "/Login.aspx");
  session.cookie = collectCookies(page.response, session.cookie);
  if (!/name="__VIEWSTATE"/i.test(page.body)) {
    throw new CrmWebError("The CRM login page did not render a form — the web app may have changed.", 502);
  }

  const form = new URLSearchParams({
    __EVENTARGUMENT: "",
    __EVENTTARGET: "",
    __EVENTVALIDATION: hiddenField(page.body, "__EVENTVALIDATION"),
    __VIEWSTATE: hiddenField(page.body, "__VIEWSTATE"),
    __VIEWSTATEGENERATOR: hiddenField(page.body, "__VIEWSTATEGENERATOR"),
    // The login form captures the browser's geolocation. Empty is accepted, and Phoenix has no
    // location to offer — sending a fabricated one would put fiction in the vendor's audit trail.
    "ctl00$ContentPlaceHolder1$txtAddress": "",
    "ctl00$ContentPlaceHolder1$txtLatitude": "",
    "ctl00$ContentPlaceHolder1$txtLongitude": "",
    "ctl00$ContentPlaceHolder1$username": config.username,
    "ctl00$ContentPlaceHolder1$password": config.password,
    "ctl00$ContentPlaceHolder1$Button1": "Login",
  });

  const posted = await request(session, "/Login.aspx", {
    body: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  session.cookie = collectCookies(posted.response, session.cookie);

  if (posted.response.status !== 302) {
    throw new CrmWebError(
      `The CRM web app rejected the sign-in (HTTP ${posted.response.status}).`,
      401,
    );
  }
  return session;
}

/**
 * Finds the grid table on a rendered page and returns its header plus data rows.
 *
 * Both grids are Telerik RadGrids wrapped in several layout tables, so the table is located by the
 * header text it must contain rather than by position.
 */
function extractGrid(html: string, headerNeedle: RegExp): { head: string[]; rows: string[][] } | null {
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[0]);
  const grid = tables.find((table) => headerNeedle.test(table) && /<tr/i.test(table));
  if (!grid) return null;
  const all = [...grid.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => rowCells(match[1]))
    .filter((cells) => cells.length > 3);
  const head = all.find((cells) => cells.some((cell) => headerNeedle.test(cell)));
  if (!head) return null;
  return {
    head,
    rows: all.filter((cells) => cells !== head && cells.length === head.length),
  };
}

/** The columns a contact grid must have for the parse below to mean anything. */
const REQUIRED_CONTACT_COLUMNS = ["ID", "Contact Name", "Grade", "Spec.", "Address"] as const;

/**
 * Refuses a contact grid whose shape has drifted.
 *
 * This is the guard that keeps a vendor redesign from reading as "every rep lost their doctors".
 * A missing column throws; an empty grid does NOT, because an agent genuinely holding no contacts
 * is a real and common answer (13 of 15 district managers, and one medical rep).
 */
export function assertContactGridShape(head: string[]): void {
  const missing = REQUIRED_CONTACT_COLUMNS.filter(
    (column) => !head.some((cell) => cell.toLowerCase() === column.toLowerCase()),
  );
  if (missing.length) {
    throw new CrmWebError(
      `The CRM contact list no longer has the columns Phoenix reads (missing: ${missing.join(", ")}).`,
      502,
    );
  }
}

/** Parses one rendered ContactsList.aspx page. Exported so a test can feed it fixture HTML. */
export function parseContactGrid(html: string): CrmContactRow[] {
  const grid = extractGrid(html, /Contact\s*Name/i);
  if (!grid) {
    throw new CrmWebError("The CRM contact list did not render a grid — the web app may have changed.", 502);
  }
  assertContactGridShape(grid.head);

  const at = (pattern: RegExp) => grid.head.findIndex((cell) => pattern.test(cell));
  const index = {
    address: at(/^Address$/i),
    city: at(/^City$/i),
    grade: at(/^Grade$/i),
    id: at(/^ID$/i),
    name: at(/^Contact Name$/i),
    nameAr: at(/Contact Name Ar/i),
    phone: at(/phone/i),
    region: at(/^Region$/i),
    speciality: at(/^Spec/i),
    zone: at(/^Zone$/i),
  };

  const out: CrmContactRow[] = [];
  for (const cells of grid.rows) {
    const id = (cells[index.id] ?? "").trim();
    // Filter rows, group rows and the pager all share the grid's markup but carry no numeric id.
    if (!/^\d+$/.test(id)) continue;
    out.push({
      address: blankToNull(cells[index.address]),
      city: blankToNull(cells[index.city]),
      contactCrmId: Number(id),
      grade: blankToNull(cells[index.grade]),
      name: blankToNull(cells[index.name]),
      nameAr: index.nameAr >= 0 ? blankToNull(cells[index.nameAr]) : null,
      phone: index.phone >= 0 ? blankToNull(cells[index.phone]) : null,
      region: blankToNull(cells[index.region]),
      speciality: blankToNull(cells[index.speciality]),
      zone: blankToNull(cells[index.zone]),
    });
  }
  return out;
}

/** Fetches one agent's list of one type. Returns [] when the agent genuinely holds none. */
export async function crmWebFetchContacts(
  session: CrmWebSession,
  agentCrmId: number,
  listType: CrmListType,
): Promise<CrmContactRow[]> {
  const { body, response } = await request(
    session,
    `/ContactsList.aspx?t=${encodeURIComponent(listType)}&q=${encodeURIComponent(String(agentCrmId))}`,
  );
  if (response.status === 302) {
    throw new CrmWebError("The CRM web session expired mid-sync.", 401);
  }
  if (response.status !== 200) {
    throw new CrmWebError(`The CRM contact list returned HTTP ${response.status}.`, response.status);
  }
  // Timed into the per-minute process-health line. The parse is synchronous work on a WebForms page of
  // several hundred kilobytes, and the biggest slice of this scrape was followed by a 4.3-second server
  // freeze three times on 2026-10-16 — this is the number that confirms or clears it.
  const startedAt = performance.now();
  try {
    return parseContactGrid(body);
  } finally {
    recordTiming("crm.contact_grid_parse", performance.now() - startedAt);
    recordTiming("crm.contact_grid_kb", body.length / 1024);
  }
}

/** Every `<input>`/`<select>` on the page, as the postback body a WebForms grid demands back. */
function serializeForm(html: string): URLSearchParams {
  const form = new URLSearchParams();
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = attrs.match(/\bname="([^"]*)"/i)?.[1];
    if (!name) continue;
    const type = (attrs.match(/\btype="([^"]*)"/i)?.[1] ?? "text").toLowerCase();
    // Submit buttons are what SELECTS the postback; including them all would fire several at once.
    if (type === "submit" || type === "button" || type === "image") continue;
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(attrs)) continue;
    form.set(name, attrs.match(/\bvalue="([^"]*)"/i)?.[1] ?? "");
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = match[1].match(/\bname="([^"]*)"/i)?.[1];
    if (!name) continue;
    const selected =
      match[2].match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/i) ??
      match[2].match(/<option[^>]*value="([^"]*)"/i);
    form.set(name, selected?.[1] ?? "");
  }
  return form;
}

/** The Next Page button on the agents grid. See trap 2 in the module header. */
const AGENTS_NEXT_PAGE = "ctl00$ContentPlaceHolder1$RadGrid1$ctl00$ctl03$ctl01$ctl20";
/** Seven pages of 50 covered all 305 agents on 2026-08-28; the cap is a runaway guard, not a limit. */
const AGENTS_MAX_PAGES = 40;

/** Parses one rendered Agents.aspx page. Exported so a test can feed it fixture HTML. */
export function parseAgentGrid(html: string): CrmAgentRow[] {
  const out: CrmAgentRow[] = [];
  for (const match of html.matchAll(
    /<tr[^>]*id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__\d+"[^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const link = match[1].match(/ContactsList\.aspx\?t=[A-Za-z]+&(?:amp;)?q=(\d+)/i);
    if (!link) continue;
    const cells = rowCells(match[1]);
    // Column order re-verified live 2026-09-03, this time against the grid's OWN header captions
    // rather than by eye — every `<td>` index below is the caption one place to its right in the
    // header row, which carries a leading command-item cell the data rows do not repeat:
    //
    //   0 Area (the ContactsList link) · 1 PM · 2 AM · 3 PH · 4 All · 5 ID · 6 Real Name ·
    //   7 Email · 8 Privilege · 9 Manager · 10 Line · 11 Active · 12 Hiring Date ·
    //   13 Edit · 14 Target · 15 Delete
    //
    // The three counters at 1/2/3 are the cheapest cross-check there is that a fetched list is not
    // silently empty.
    //
    // 8/9/10 are the trio that reads wrong at a glance, and 9 was in fact read wrong until
    // 2026-09-03 (it was mapped to a field named `username`). What they actually hold:
    //
    //   8  Privilege — the CRM's role name: `Medical Rep`, `District Manager`, `Product Manager`…
    //   9  Manager   — the SUPERVISOR's own Real Name, verbatim. Not a login; the grid has no
    //                  login column. Measured over all 305 accounts: 296 of the values are another
    //                  account's Real Name character-for-character, exactly 1 equals the row's own
    //                  name, and the accounts pointed at are 212 District Managers, 38 National
    //                  Sales Managers, 18 Administrators and 13 Regional Sales Managers. Slot 1485
    //                  `Manar.Sadek ( Behira 2 / C )` carries `Saad.Mohamed`, her district manager.
    //   10 Line      — `CNS Line`, `Anti-Infective Line`, `Ped Line`.
    //
    // Email at 7 is populated for 250 of 305 accounts and is deliberately not parsed: nothing needs
    // it, and a company address is the one field here that would make this row personal data.
    out.push({
      agentCrmId: Number(link[1]),
      amCount: Number(cells[2] ?? 0) || 0,
      hiringDate: blankToNull(cells[12]),
      isActive: (cells[11] ?? "").trim().toLowerCase() === "yes",
      label: blankToNull(cells[6]),
      line: blankToNull(cells[10]),
      pharmacyCount: Number(cells[3] ?? 0) || 0,
      pmCount: Number(cells[1] ?? 0) || 0,
      supervisor: blankToNull(cells[9]),
      title: blankToNull(cells[8]),
    });
  }
  return out;
}

/**
 * Walks every page of the agents grid and returns all agent accounts the CRM holds.
 *
 * Used for the counter cross-check and for reporting accounts Phoenix has no employee for. It is
 * NOT what drives the sweep — see the module header on why the CRM's active flag cannot be trusted
 * as a roster.
 */
export async function crmWebFetchAgents(session: CrmWebSession): Promise<CrmAgentRow[]> {
  const first = await request(session, "/Agents.aspx");
  if (first.response.status !== 200) {
    throw new CrmWebError(`The CRM agents page returned HTTP ${first.response.status}.`, first.response.status);
  }
  const byId = new Map<number, CrmAgentRow>();
  for (const row of parseAgentGrid(first.body)) byId.set(row.agentCrmId, row);
  if (!byId.size) {
    throw new CrmWebError("The CRM agents page listed nobody — the web app may have changed.", 502);
  }

  let html = first.body;
  for (let page = 2; page <= AGENTS_MAX_PAGES; page += 1) {
    const form = serializeForm(html);
    form.set("__EVENTTARGET", "");
    form.set("__EVENTARGUMENT", "");
    form.set(AGENTS_NEXT_PAGE, " ");
    const next = await request(session, "/Agents.aspx", {
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (next.response.status !== 200) break;
    const rows = parseAgentGrid(next.body);
    // The last page repeats itself when Next is pressed again, so "nothing new" is the terminator.
    const fresh = rows.filter((row) => !byId.has(row.agentCrmId));
    html = next.body;
    for (const row of rows) byId.set(row.agentCrmId, row);
    if (!fresh.length) break;
  }
  return [...byId.values()];
}
