"use client";

/**
 * The company's own tablet server, set from Phoenix — the sets of rules the tablets follow, what goes
 * onto them, and who can sign in to the server itself.
 *
 * WHY THIS IS NOT ON THE FLEET TABLE. Everything here is fleet-wide: a change to a set of rules
 * reaches every tablet carrying them at its next check-in, and a new console login can reach the whole
 * fleet. Putting it beneath a single tablet's row would make a company-wide change look like a
 * per-tablet one.
 *
 * 🔴 THE WHOLE CONFIGURATION OBJECT NEVER REACHES THIS COMPONENT. Headwind's configuration carries
 * the tablet's admin password in clear text — the Swagger says MD5 and the source disagrees — so the
 * route hands back facts and the home-screen look only. Nothing here can print it, log it or put it in
 * a URL, because it never has it.
 *
 * 🔴 AND A PASSWORD TYPED HERE GOES ONE WAY. The new-login form sends it and drops it: it is not read
 * back, not returned by any route, and not written into the audit row. There is no "show the password"
 * anywhere on this page, by design — Headwind cannot give one back either.
 *
 * DESIGN IDENTITY is the rest of the Rep Tablets page — slate borders, SQUARE corners, 9px uppercase
 * micro-labels, wrapped text with nothing truncated, and Cairo times.
 */

import { Loader2, Upload } from "lucide-react";
import { useState } from "react";

import {
  Busy,
  Done,
  Failed,
  MICRO_LABEL,
  PANEL_ACTION,
  PANEL_ARMED,
  Panel,
  postJson,
  useDisarmAfterWindow,
  useRead,
} from "@/components/devices/headwind-panel-kit";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

const PRIMARY_BUTTON =
  "inline-flex items-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60";

/** The three the tablet's launcher understands — the same list as `HEADWIND_ICON_SIZES`. */
const ICON_SIZES = ["SMALL", "MEDIUM", "LARGE"] as const;

/**
 * What the title across the top shows — the same list as `HEADWIND_DESKTOP_HEADERS`, copied for the
 * browser bundle. It is a choice of WHAT, not where: Headwind has no title position at all.
 */
const TITLE_KINDS = [
  { label: "No title", value: "NO_HEADER" },
  { label: "The tablet's number", value: "DEVICE_ID" },
  { label: "The tablet's description", value: "DESCRIPTION" },
  { label: "The title typed beside this", value: "TEMPLATE" },
] as const;

/**
 * 🔴 A VALUE PHOENIX DOES NOT OFFER IS STILL SHOWN, AND SAVED BACK AS IT IS. A set of rules whose title
 * was set to one of Headwind's custom-field kinds in its own console holds a value outside
 * `TITLE_KINDS`. Without its own option the dropdown showed a blank, and since the form sends its whole
 * shape, every save of those rules — a colour, an icon size — was refused over a title nobody touched.
 */
function titleKindLabel(value: string): string {
  const custom = /^CUSTOM([1-3])$/.exec(value);
  return custom ? `Custom field ${custom[1]} (set in the Headwind console)` : "Set in the Headwind console";
}

type ConfigurationSummary = {
  id: number;
  name: string;
  description: string | null;
  kioskMode: boolean;
  deviceCount: number | null;
};

type Branding = {
  desktopHeader: string | null;
  desktopHeaderTemplate: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  backgroundImageUrl: string | null;
  iconSize: string | null;
  mainAppId: number | null;
  kioskMode: boolean;
};

/**
 * The name every rep set of rules starts with — the same as `REP_RULES_PREFIX`, copied for the browser
 * bundle. "Rep tablets" and each line's copy of it; found by name, never by id.
 */
const REP_RULES_PREFIX = "Rep tablets";

type InstallLink = {
  applicationId: number | null;
  name: string;
  version: string | null;
  url: string | null;
  status: number | null;
  verdict: string;
  label: string;
  redirectsTo: string | null;
};

type InstallLinkReport = { configurationId: number; name: string; links: InstallLink[]; broken: number };

type ConsoleUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  roleId: number | null;
  roleName: string | null;
  /**
   * False for the login Phoenix itself signs in with (the server's `editable: false`, or the login in
   * `HEADWIND_MDM_LOGIN`). The server refuses removing it; the page offers no Remove beside it.
   */
  removable?: boolean;
};
type ConsoleRole = { id: number; name: string };

function failureText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The home screen of one set of rules.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type BrandingForm = {
  desktopHeader: string;
  desktopHeaderTemplate: string;
  backgroundColor: string;
  textColor: string;
  backgroundImageUrl: string;
  iconSize: string;
};

type BrandingState = {
  /** Which set of rules these edits belong to — derived, like every other keyed state here. */
  configurationId: number;
  form: BrandingForm | null;
  busy: boolean;
  notice: string | null;
  failure: string | null;
};

function formOf(branding: Branding): BrandingForm {
  return {
    backgroundColor: branding.backgroundColor ?? "",
    backgroundImageUrl: branding.backgroundImageUrl ?? "",
    desktopHeader: branding.desktopHeader ?? "",
    desktopHeaderTemplate: branding.desktopHeaderTemplate ?? "",
    iconSize: branding.iconSize ?? "",
    textColor: branding.textColor ?? "",
  };
}

function BrandingPanel({ configurationId }: { configurationId: number }) {
  const read = useRead<{ configuration: ConfigurationSummary; branding: Branding }>(
    `/api/devices/headwind/configurations?configurationId=${configurationId}`,
  );
  const [state, setState] = useState<BrandingState>({
    busy: false,
    configurationId,
    failure: null,
    form: null,
    notice: null,
  });

  const own =
    state.configurationId === configurationId
      ? state
      : { busy: false, configurationId, failure: null, form: null, notice: null };
  // The server's own values until the first keystroke, then whatever is being typed. Derived during
  // the render, so switching to another set of rules cannot leave one set's edits in another's boxes.
  const form = own.form ?? (read.data ? formOf(read.data.branding) : null);

  function set(field: keyof BrandingForm, value: string) {
    if (!form) return;
    setState({ ...own, failure: null, form: { ...form, [field]: value }, notice: null });
  }

  async function save() {
    if (!form) return;
    setState({ ...own, busy: true, failure: null, form, notice: null });
    try {
      const result = await postJson<{ branding: Branding; message: string }>(
        "/api/devices/headwind/configurations",
        { change: "branding", configurationId, ...form },
      );
      setState({ ...own, busy: false, failure: null, form: formOf(result.branding), notice: result.message });
    } catch (caught: unknown) {
      setState({
        ...own,
        busy: false,
        failure: failureText(caught, "Could not change the look of these tablet rules."),
        form,
        notice: null,
      });
    }
  }

  return (
    <div className="border-t border-slate-100 pt-3">
      <p className={MICRO_LABEL}>The tablet&rsquo;s home screen</p>
      {read.loading ? <Busy what="the home-screen settings" /> : null}
      {read.error ? <Failed message={read.error} /> : null}
      {own.notice ? <Done message={own.notice} /> : null}
      {own.failure ? <Failed message={own.failure} /> : null}
      {form ? (
        <div className="mt-2 space-y-2">
          {/*
            🔴 SAID ON THE PAGE, NOT ONLY IN THE CODE. `kioskMode` puts the agent's own launcher in
            front and shows only the apps these rules allow — but TRUE pinning is a stub in the free
            agent, so a determined person can still reach Android's own settings. A tablet handed out
            in the belief it is sealed, when it is not, is how a "kiosk" costs somebody money.
          */}
          <p className="break-words text-[11px] font-semibold text-slate-500">
            {read.data?.branding.kioskMode
              ? "These rules put the company's own home screen in front, showing only the apps they allow. It is a managed home screen, not a sealed cage — the free agent does not do true pinning, so someone determined can still reach Android's own settings."
              : "These rules leave the tablet's ordinary home screen in place. Turning the company home screen on is done in the Headwind console."}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className={`block ${MICRO_LABEL}`}>Title across the top</span>
              <input
                className={cn(phxFieldClassName, "mt-1")}
                onChange={(event) => set("desktopHeaderTemplate", event.target.value)}
                placeholder="Sato Pharma · rep tablet"
                type="text"
                value={form.desktopHeaderTemplate}
              />
            </label>
            <label className="block min-w-0">
              <span className={`block ${MICRO_LABEL}`}>What the title shows</span>
              <select
                className={cn(phxSelectClassName, "mt-1")}
                onChange={(event) => set("desktopHeader", event.target.value)}
                value={form.desktopHeader}
              >
                <option value="">Not set — the launcher&rsquo;s own default</option>
                {form.desktopHeader && !TITLE_KINDS.some((kind) => kind.value === form.desktopHeader) ? (
                  <option value={form.desktopHeader}>{titleKindLabel(form.desktopHeader)}</option>
                ) : null}
                {TITLE_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={`block ${MICRO_LABEL}`}>Background colour</span>
              <input
                className={cn(phxFieldClassName, "mt-1")}
                onChange={(event) => set("backgroundColor", event.target.value)}
                placeholder="#0A527D"
                type="text"
                value={form.backgroundColor}
              />
            </label>
            <label className="block min-w-0">
              <span className={`block ${MICRO_LABEL}`}>Text colour</span>
              <input
                className={cn(phxFieldClassName, "mt-1")}
                onChange={(event) => set("textColor", event.target.value)}
                placeholder="#FFFFFF"
                type="text"
                value={form.textColor}
              />
            </label>
            <label className="block min-w-0">
              <span className={`block ${MICRO_LABEL}`}>Background picture</span>
              <input
                className={cn(phxFieldClassName, "mt-1")}
                onChange={(event) => set("backgroundImageUrl", event.target.value)}
                placeholder="https://…/wallpaper.png"
                type="text"
                value={form.backgroundImageUrl}
              />
            </label>
            <label className="block min-w-0">
              <span className={`block ${MICRO_LABEL}`}>Icon size</span>
              <select
                className={cn(phxSelectClassName, "mt-1")}
                onChange={(event) => set("iconSize", event.target.value)}
                value={form.iconSize}
              >
                <option value="">Not set — the launcher&rsquo;s own default</option>
                {ICON_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size === "SMALL" ? "Small" : size === "MEDIUM" ? "Medium" : "Large"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="break-words text-[11px] font-semibold text-slate-500">
            A box left empty clears that setting on the tablets. Colours are six-digit hex, like
            <span className="font-mono"> #0A527D</span>.
          </p>
          <button className={PANEL_ACTION} disabled={own.busy} onClick={() => void save()} type="button">
            {own.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            Save the home screen
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Sending an app or a file onto the tablets.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type UploadState = { busy: boolean; notice: string | null; failure: string | null };

/**
 * 🔴 THERE IS NO "INSTALL" INSTRUCTION IN HEADWIND, AND THIS IS WHY THE FORM ASKS FOR A SET OF RULES.
 * An app arrives on a tablet because it is in the rules that tablet follows, not because a button was
 * pressed at it. So the upload puts the file on the server AND into these rules in one go; every
 * tablet carrying them installs it at its next check-in. Leaving the rules out would upload something
 * that reaches no tablet at all — which looks exactly like success.
 */
function UploadPanel({ configurationId, repRules }: { configurationId: number; repRules: boolean }) {
  const [state, setState] = useState<UploadState>({ busy: false, failure: null, notice: null });

  async function send(form: HTMLFormElement) {
    const body = new FormData(form);
    // 🔴 EVERY REP SET, OR THESE RULES ALONE. Each line's tablets follow their own copy of "Rep
    // tablets", so an app meant for every rep tablet has to go on each copy — `rep` does that on the
    // server, one audit row per set; sending only this id left the other lines without it.
    body.set("configurationId", body.get("reach") === "rep" ? "rep" : String(configurationId));
    body.delete("reach");
    setState({ busy: true, failure: null, notice: null });
    try {
      const response = await fetch("/api/devices/headwind/upload", { body, cache: "no-store", method: "POST" });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const failure = (payload ?? {}) as { message?: unknown };
        throw new Error(
          typeof failure.message === "string" && failure.message
            ? failure.message
            : "The server answered with an error and no explanation.",
        );
      }
      form.reset();
      setState({ busy: false, failure: null, notice: (payload as { message: string }).message });
    } catch (caught: unknown) {
      setState({
        busy: false,
        failure: failureText(caught, "Could not send that to the tablet server."),
        notice: null,
      });
    }
  }

  return (
    <div className="border-t border-slate-100 pt-3">
      <p className={MICRO_LABEL}>Put an app or a file on these tablets</p>
      {state.notice ? <Done message={state.notice} /> : null}
      {state.failure ? <Failed message={state.failure} /> : null}
      <form
        className="mt-2 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(event.currentTarget);
        }}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={`block ${MICRO_LABEL}`}>What it is</span>
            <select className={cn(phxSelectClassName, "mt-1")} defaultValue="app" name="kind">
              <option value="app">An Android app (.apk)</option>
              <option value="file">A file for the tablets to hold</option>
            </select>
          </label>
          <label className="block min-w-0">
            <span className={`block ${MICRO_LABEL}`}>The file</span>
            <input className={cn(phxFieldClassName, "mt-1")} name="file" required type="file" />
          </label>
          {repRules ? (
            <label className="block min-w-0 sm:col-span-2">
              <span className={`block ${MICRO_LABEL}`}>Which tablets</span>
              <select className={cn(phxSelectClassName, "mt-1")} defaultValue="rep" name="reach">
                <option value="rep">Every rep tablet — these rules and each line&rsquo;s copy of them</option>
                <option value="only">Only the tablets on these rules</option>
              </select>
            </label>
          ) : null}
        </div>
        <p className="break-words text-[11px] font-semibold text-slate-500">
          An app has to be a <span className="font-mono">.apk</span> — the <span className="font-mono">.aab</span>{" "}
          bundle Google Play builds from cannot be installed on a tablet. It goes onto every tablet following
          the rules chosen at its next check-in, and only once its download link answers on https by itself.
        </p>
        <button className={PRIMARY_BUTTON} disabled={state.busy} type="submit">
          {state.busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Upload aria-hidden className="size-4" />}
          Send it to the tablets
        </button>
      </form>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Install links — what a tablet on these rules actually downloads.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

function linkAnswer(link: InstallLink): string {
  const status = link.status ? ` · HTTP ${link.status}` : "";
  const target = link.redirectsTo ? ` · to ${link.redirectsTo}` : "";
  return `${link.label}${status}${target}`;
}

/**
 * 🔴 A TABLET WILL NOT FOLLOW A REDIRECT, AND ONE DEAD LINK STOPS ITS WHOLE UPDATE RUN (runbook §8.16,
 * §8.18). Twice in 2026 a single dead link held a rep tablet on an old launcher for weeks — no location,
 * no remote-screen ID — while every screen here looked healthy. So every install link on a rep set of
 * rules is checked the way the tablet meets it, on this page, with the time of the check.
 */
function InstallLinksBlock({ configurationId }: { configurationId: number }) {
  const [round, setRound] = useState(0);
  const read = useRead<{ checkedAt: string; configurations: InstallLinkReport[] }>(
    `/api/devices/headwind/configurations?view=install-links&configurationId=${configurationId}&round=${round}`,
  );
  const report = read.data?.configurations.find((entry) => entry.configurationId === configurationId) ?? null;
  const total = report?.links.length ?? 0;

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className={MICRO_LABEL}>Install links</p>
        {read.data ? (
          <span className="text-[10px] font-semibold text-slate-500">
            Checked {cairoDateTime(read.data.checkedAt)}, Cairo time
          </span>
        ) : null}
        <button className={PANEL_ACTION} disabled={read.loading} onClick={() => setRound((value) => value + 1)} type="button">
          {read.loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          Check again
        </button>
      </div>
      {read.loading ? <Busy what="every install link on these rules" /> : null}
      {read.error ? <Failed message={read.error} /> : null}
      {report ? (
        <div className="mt-1 space-y-2">
          {total === 0 ? (
            <p className="break-words text-[11px] font-semibold text-slate-500">These rules install no app from a download.</p>
          ) : report.broken === 0 ? (
            <Done
              message={`All ${total} install link${total === 1 ? "" : "s"} answer on https by themselves — a tablet can download every one.`}
            />
          ) : (
            <Failed
              message={`${report.broken} of ${total} install link${total === 1 ? "" : "s"} would stop a tablet's update run. The tablet stops at the first dead link, so nothing after it — the launcher included — arrives.`}
            />
          )}
          {total > 0 ? (
            <>
              {/* DESKTOP — three columns, the broken links first. */}
              <table className="hidden w-full table-fixed border-collapse md:table">
                <colgroup>
                  <col className="w-[26%]" />
                  <col className="w-[46%]" />
                  <col className="w-[28%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-50">
                    {["App", "Download link", "What a tablet gets"].map((heading) => (
                      <th className={`px-2 py-1.5 text-left ${MICRO_LABEL}`} key={heading} scope="col">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.links.map((link, index) => (
                    <tr className="border-b border-slate-100 align-top" key={`${link.url ?? "none"}-${index}`}>
                      <td className="px-2 py-1.5">
                        <span className="block break-words text-[11px] font-bold text-slate-900">{link.name}</span>
                        <span className="block text-[10px] font-semibold text-slate-500">{link.version ?? "Version not reported"}</span>
                      </td>
                      <td className="break-all px-2 py-1.5 font-mono text-[10px] text-slate-700">{link.url ?? "None"}</td>
                      <td
                        className={`break-words px-2 py-1.5 text-[11px] font-bold ${link.verdict === "ok" ? "text-emerald-800" : "text-rose-700"}`}
                      >
                        {linkAnswer(link)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* MOBILE — one card per link. */}
              <ul className="space-y-1 md:hidden">
                {report.links.map((link, index) => (
                  <li className="border border-slate-200 px-2 py-1.5" key={`${link.url ?? "none"}-${index}`}>
                    <p className="break-words text-[11px] font-bold text-slate-900">
                      {link.name}
                      <span className="font-semibold text-slate-500"> · {link.version ?? "Version not reported"}</span>
                    </p>
                    <p className="mt-0.5 break-all font-mono text-[10px] text-slate-700">{link.url ?? "No download link"}</p>
                    <p className={`mt-0.5 break-words text-[11px] font-bold ${link.verdict === "ok" ? "text-emerald-800" : "text-rose-700"}`}>
                      {linkAnswer(link)}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The sets of rules.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

function ConfigurationsPanel() {
  const read = useRead<{ configurations: ConfigurationSummary[] }>("/api/devices/headwind/configurations");
  const [openId, setOpenId] = useState<number | null>(null);

  const configurations = read.data?.configurations ?? [];

  return (
    <Panel title="The sets of rules the tablets follow">
      {read.loading ? <Busy what="the tablet rules" /> : null}
      {read.error ? <Failed message={read.error} /> : null}
      {read.data && configurations.length === 0 ? (
        <p className="text-[11px] font-semibold text-slate-500">
          The server holds no sets of rules yet. One is made in the Headwind console; every tablet enrolled
          lands on the one its enrollment code names.
        </p>
      ) : null}
      {configurations.length > 0 ? (
        <ul className="space-y-2">
          {configurations.map((configuration) => (
            <li className="border border-slate-200 px-3 py-2" key={configuration.id}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="break-words text-[11px] font-bold text-slate-900">{configuration.name}</span>
                <span className="text-[11px] font-semibold text-slate-500">
                  {configuration.deviceCount === null
                    ? "Tablet count not reported"
                    : `${configuration.deviceCount} tablet${configuration.deviceCount === 1 ? "" : "s"}`}
                </span>
                <span className="border border-slate-300 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-slate-500">
                  {configuration.kioskMode ? "Company home screen" : "Ordinary home screen"}
                </span>
                <button
                  className={PANEL_ACTION}
                  onClick={() => setOpenId((current) => (current === configuration.id ? null : configuration.id))}
                  type="button"
                >
                  {openId === configuration.id ? "Close" : "Open"}
                </button>
              </div>
              {configuration.description ? (
                <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">
                  {configuration.description}
                </p>
              ) : null}
              {configuration.name.startsWith(REP_RULES_PREFIX) ? (
                <InstallLinksBlock configurationId={configuration.id} />
              ) : null}
              {openId === configuration.id ? (
                <div className="mt-2 space-y-3">
                  <BrandingPanel configurationId={configuration.id} />
                  <UploadPanel
                    configurationId={configuration.id}
                    repRules={configuration.name.startsWith(REP_RULES_PREFIX)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Who can sign in to the tablet server.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

type UsersState = {
  round: number;
  armed: number | null;
  busy: boolean;
  notice: string | null;
  failure: string | null;
  login: string;
  name: string;
  email: string;
  password: string;
  roleId: string;
};

const NO_USER_PENDING: UsersState = {
  armed: null,
  busy: false,
  email: "",
  failure: null,
  login: "",
  name: "",
  notice: null,
  password: "",
  roleId: "",
  round: 0,
};

function UsersPanel() {
  const [state, setState] = useState<UsersState>(NO_USER_PENDING);
  // Removing a console sign-in is a press-again control like the tablet panel's — it disarms the same way.
  useDisarmAfterWindow(state.armed, () => setState((current) => ({ ...current, armed: null })));
  const read = useRead<{ users: ConsoleUser[]; roles: ConsoleRole[]; note: string }>(
    `/api/devices/headwind/users?round=${state.round}`,
  );

  async function add() {
    setState({ ...state, busy: true, failure: null, notice: null });
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind/users", {
        email: state.email || null,
        login: state.login,
        name: state.name || null,
        password: state.password,
        roleId: Number(state.roleId),
      });
      setState({
        ...NO_USER_PENDING,
        // 🔴 THE PASSWORD IS DROPPED HERE AND NOWHERE IS IT KEPT. Resetting the whole form is what
        // takes it out of component state; nothing reads it back, because nothing can.
        notice: result.message,
        round: state.round + 1,
      });
    } catch (caught: unknown) {
      setState({
        ...state,
        busy: false,
        failure: failureText(caught, "Could not add that login."),
        notice: null,
      });
    }
  }

  async function remove(user: ConsoleUser) {
    if (state.armed !== user.id) {
      setState({ ...state, armed: user.id, failure: null, notice: null });
      return;
    }
    setState({ ...state, armed: null, busy: true, failure: null, notice: null });
    try {
      const result = await postJson<{ message: string }>("/api/devices/headwind/users", {
        login: user.login,
        remove: true,
        userId: user.id,
      });
      setState({ ...state, armed: null, busy: false, failure: null, notice: result.message, round: state.round + 1 });
    } catch (caught: unknown) {
      setState({
        ...state,
        armed: null,
        busy: false,
        failure: failureText(caught, "Could not remove that login."),
        notice: null,
      });
    }
  }

  const users = read.data?.users ?? [];
  const roles = read.data?.roles ?? [];

  return (
    <Panel title="Who can sign in to the tablet server">
      {read.loading ? <Busy what="the logins" /> : null}
      {read.error ? <Failed message={read.error} /> : null}
      {state.notice ? <Done message={state.notice} /> : null}
      {state.failure ? <Failed message={state.failure} /> : null}
      {read.data ? (
        <div className="space-y-3">
          <p className="break-words text-[11px] font-semibold text-slate-500">{read.data.note}</p>
          {users.length > 0 ? (
            <ul className="space-y-1">
              {users.map((user) => (
                <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1" key={user.id}>
                  <span className="break-words text-[11px] font-bold text-slate-900">{user.name ?? user.login}</span>
                  <span className="break-all text-[11px] font-semibold text-slate-500">{user.login}</span>
                  {user.roleName ? (
                    <span className="border border-slate-300 px-1 text-[8px] font-black uppercase tracking-[0.12em] text-slate-500">
                      {user.roleName}
                    </span>
                  ) : null}
                  {/* 🔴 NO REMOVE BESIDE THE LOGIN PHOENIX SIGNS IN WITH. Removing it cuts Phoenix off from
                      every tablet with no way back from this screen; the server refuses it too. (There is
                      no "switched off" here: the server's users carry no such field.) */}
                  {user.removable === false ? (
                    <span className="break-words text-[10px] font-semibold text-slate-500">
                      Phoenix signs in with this login, so it cannot be removed here.
                    </span>
                  ) : (
                    <button
                      className={state.armed === user.id ? PANEL_ARMED : PANEL_ACTION}
                      disabled={state.busy}
                      onClick={() => void remove(user)}
                      type="button"
                    >
                      {state.armed === user.id ? `Press again to remove ${user.login}` : "Remove"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="border-t border-slate-100 pt-3">
            <p className={MICRO_LABEL}>Add a login</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block min-w-0">
                <span className={`block ${MICRO_LABEL}`}>Sign-in name</span>
                <input
                  className={cn(phxFieldClassName, "mt-1")}
                  onChange={(event) => setState({ ...state, login: event.target.value })}
                  placeholder="omar.gawish"
                  type="text"
                  value={state.login}
                />
              </label>
              <label className="block min-w-0">
                <span className={`block ${MICRO_LABEL}`}>Full name</span>
                <input
                  className={cn(phxFieldClassName, "mt-1")}
                  onChange={(event) => setState({ ...state, name: event.target.value })}
                  placeholder="Omar Gawish"
                  type="text"
                  value={state.name}
                />
              </label>
              <label className="block min-w-0">
                <span className={`block ${MICRO_LABEL}`}>Email</span>
                <input
                  className={cn(phxFieldClassName, "mt-1")}
                  onChange={(event) => setState({ ...state, email: event.target.value })}
                  type="email"
                  value={state.email}
                />
              </label>
              <label className="block min-w-0">
                <span className={`block ${MICRO_LABEL}`}>What they can do</span>
                <select
                  className={cn(phxSelectClassName, "mt-1")}
                  onChange={(event) => setState({ ...state, roleId: event.target.value })}
                  value={state.roleId}
                >
                  <option value="">Choose one</option>
                  {roles.map((role) => (
                    <option key={role.id} value={String(role.id)}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0 sm:col-span-2">
                <span className={`block ${MICRO_LABEL}`}>Password</span>
                <input
                  autoComplete="new-password"
                  className={cn(phxFieldClassName, "mt-1")}
                  onChange={(event) => setState({ ...state, password: event.target.value })}
                  type="password"
                  value={state.password}
                />
                <span className="mt-0.5 block text-[10px] font-semibold text-slate-400">
                  Give it to them yourself. It is sent to the tablet server and dropped — this page cannot show
                  it again, and neither can the server.
                </span>
              </label>
            </div>
            <button
              className={`mt-2 ${PANEL_ACTION}`}
              disabled={state.busy || !state.login.trim() || !state.password || !state.roleId}
              onClick={() => void add()}
              type="button"
            >
              {state.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
              Add this login
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

export function HeadwindServerSettings() {
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-black text-slate-900">The company tablet server itself</h2>
        <p className="text-[11px] font-semibold text-slate-500">Fleet-wide &middot; Super Admin only</p>
      </div>
      <p className="mt-1 max-w-3xl text-[12px] font-semibold text-slate-600">
        What every tablet follows, rather than one tablet at a time. A change to a set of rules reaches every
        tablet carrying them at its next check-in. Extra sign-ins to the server are free and uncapped, and nothing
        in it is licensed per tablet &mdash; what it can hold is set by the server&rsquo;s own disk and memory.
      </p>
      <div className="mt-3 space-y-3">
        <ConfigurationsPanel />
        <UsersPanel />
      </div>
    </section>
  );
}
