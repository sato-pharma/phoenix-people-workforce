"use client";

/**
 * Enrolling a new rep tablet onto the company's own Headwind server — one code per set of tablet rules.
 *
 * 🔴 PHOENIX NEVER MINTS THESE CODES, AND THAT IS NOT A LIMITATION TO BE ENGINEERED AROUND. The payload
 * carries a checksum of the agent APK the server itself is serving — `android.app.extra.PROVISIONING_
 * DEVICE_ADMIN_SIGNATURE_CHECKSUM`. A code Phoenix assembled would carry a checksum Phoenix guessed,
 * and a factory-fresh tablet checks it before it installs anything: the tablet would refuse the
 * enrollment with a message about a corrupt package, and the obvious conclusion would be that the
 * server is broken. So the owner pastes Headwind's own code once per set of rules, and this page
 * redraws it from then on.
 *
 * 🔴 ONE CARD PER SET OF RULES. Each line has its own copy of "Rep tablets", and each copy has its own
 * QR key: a tablet enrolled with another line's code lands on that line's rules and never gets its own
 * line app. So each card names its rules, holds its own code, and is shown and audited on its own.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL. Scanning it puts a tablet into the company's fleet, so it is never
 * part of the page's ordinary load: a card asks for its code only when a person presses "Show the
 * code", it lives in that card's state while it is on screen, and "Hide the code" drops it. It is never
 * stored in the browser, never logged, never in a URL. The audit row records the LOOK, never the code.
 *
 * DESIGN IDENTITY is the rest of the Rep Tablets page — slate borders, square corners, 9px uppercase
 * micro-labels. IT FITS THE SCREEN: one column on a phone, facts in a wrapping grid, every value
 * wrapping rather than truncating.
 */

import { Download, EyeOff, Loader2, QrCode } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { QrImage, saveQrImage } from "@/components/devices/qr-image";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { encodeQrText, type QrCode as QrSymbol } from "@/lib/qr/qr-code";
import {
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/devices/headwind/enrollment";
const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";
const PRIMARY_BUTTON =
  "inline-flex items-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60";
const SECONDARY_BUTTON =
  "inline-flex items-center gap-2 border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60";
/**
 * The agent's package, as a person calls it. Copied from `HEADWIND_AGENT_PACKAGE` rather than imported:
 * that module reaches the audit writer, which must not ride into a browser bundle. Any other package a
 * code names is printed as it is — it is not ours to rename.
 */
const AGENT_NAMES: Readonly<Record<string, string>> = { "com.hmdm.launcher": "Headwind MDM agent" };

/** The one warning chip — amber, in words. A checksum-less code is refused by a factory-fresh tablet. */
const WARNING_CHIP =
  "inline-block border border-amber-400 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-amber-900";

const CHIP =
  "inline-block border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-700";

type EnrollmentSummary = {
  saved: boolean;
  templateName: string | null;
  agentPackage: string | null;
  downloadHost: string | null;
  downloadPath: string | null;
  serverHost: string | null;
  configurationName: string | null;
  hasChecksum: boolean;
  joinsWifi: boolean;
  problem: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

type EnrollmentCard = {
  configurationId: number;
  configurationName: string;
  onServer: boolean;
  legacy: boolean;
  summary: EnrollmentSummary;
};

type EnrollmentState = { cards: EnrollmentCard[]; unassigned: EnrollmentSummary | null };

type RevealedTemplate = { payload: string; templateName: string | null; configurationName: string };

async function requestJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }),
  });
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
        : "The server answered with an error and no explanation. Reload the page and try again.",
    );
  }
  return payload as T;
}

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/** A file name a person can read: "Rep tablets — Pedia" → "rep-tablets-pedia". */
function fileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "rep-tablets";
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border border-slate-200 bg-slate-50 px-3 py-2">
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1 break-words text-sm font-bold text-slate-900">{children}</p>
    </div>
  );
}

function Failure({ title, message }: { title: string; message: string }) {
  return (
    <div className="border border-rose-300 bg-rose-50 p-4">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-800">{title}</p>
      <p className="mt-1 break-words text-sm text-rose-900">{message}</p>
    </div>
  );
}

function Caution({ title, message }: { title: string; message: string }) {
  return (
    <div className="border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-amber-800">{title}</p>
      <p className="mt-1 break-words">{message}</p>
    </div>
  );
}

/** What a saved code carries, without the code. */
function CodeFacts({ summary }: { summary: EnrollmentSummary }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Code">{summary.templateName ?? "No name given"}</Fact>
        <Fact label="Agent it installs">
          {summary.agentPackage
            ? // Own keys only: a pasted package such as "__proto__" must not read through to Object.prototype.
              (Object.hasOwn(AGENT_NAMES, summary.agentPackage)
                ? AGENT_NAMES[summary.agentPackage]
                : summary.agentPackage)
            : "Not readable"}
        </Fact>
        <Fact label="Reports to">{summary.serverHost ?? "Not readable"}</Fact>
        <Fact label="Saved">
          {summary.updatedAt ? cairoDateTime(summary.updatedAt) : "Unknown"}
          {summary.updatedBy ? ` by ${summary.updatedBy}` : ""}
        </Fact>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={MICRO_LABEL}>What the code carries</span>
        <span className={cn(CHIP, "break-all")}>
          {summary.downloadHost
            ? `Agent from ${summary.downloadHost}${summary.downloadPath ?? ""}`
            : "No download link"}
        </span>
        <span className={CHIP}>
          {summary.configurationName ? `Lands on ${summary.configurationName}` : "No rules named"}
        </span>
        {/*
          A CODE WITH NO CHECKSUM IS REFUSED BY A FACTORY-FRESH TABLET, and the refusal on the tablet
          says nothing about a checksum — so this chip is the only warning there is going to be.
        */}
        {summary.hasChecksum ? (
          <span className={CHIP}>Agent signature pinned</span>
        ) : (
          <span className={WARNING_CHIP}>No signature pinned</span>
        )}
        <span className={CHIP}>{summary.joinsWifi ? "Joins Wi-Fi during setup" : "No Wi-Fi in the code"}</span>
      </div>
    </>
  );
}

/** One set of rules and its code: shown, saved and replaced on its own. */
function EnrollmentCodeCard({
  card,
  onSaved,
}: {
  card: EnrollmentCard;
  onSaved: (card: EnrollmentCard) => void;
}) {
  const { configurationId, configurationName, summary } = card;
  const [raw, setRaw] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [pasting, setPasting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The credential, held only while it is on screen. */
  const [revealed, setRevealed] = useState<RevealedTemplate | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const save = useCallback(() => {
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    return requestJson<EnrollmentCard>(ENDPOINT, {
      configurationId,
      raw,
      templateName: templateName.trim() || null,
    })
      .then((saved) => {
        onSaved(saved);
        setRaw("");
        setPasting(false);
        // A replaced code makes an old one on screen wrong, so it goes.
        setRevealed(null);
        setNotice(`Saved. A factory-fresh tablet that scans this code joins the fleet on ${saved.configurationName}.`);
      })
      .catch((caught: unknown) => setSaveError(messageOf(caught, "Could not save the enrollment code.")))
      .finally(() => setSaving(false));
  }, [configurationId, onSaved, raw, templateName]);

  const reveal = useCallback(() => {
    setRevealing(true);
    setRevealError(null);
    return requestJson<RevealedTemplate>(ENDPOINT, { configurationId, show: true })
      .then((result) => setRevealed(result))
      .catch((caught: unknown) => setRevealError(messageOf(caught, "Could not show the enrollment code.")))
      .finally(() => setRevealing(false));
  }, [configurationId]);

  const qr = useMemo<QrSymbol | null>(() => {
    if (!revealed) return null;
    try {
      return encodeQrText(revealed.payload);
    } catch {
      return null;
    }
  }, [revealed]);

  const canShow = card.onServer && summary.saved && !summary.problem;

  return (
    <article className="space-y-3 border border-slate-200 p-4">
      <div>
        <p className={MICRO_LABEL}>Set of rules</p>
        <h3 className="mt-1 break-words text-base font-black text-slate-900">{configurationName}</h3>
      </div>

      {summary.saved ? <CodeFacts summary={summary} /> : null}

      {card.legacy ? (
        <p className="text-[11px] font-semibold text-slate-500">
          Saved before each line had its own rules. The code itself names these rules, so it is shown here.
        </p>
      ) : null}

      {summary.problem ? <Caution message={summary.problem} title="This code cannot be shown" /> : null}

      {card.onServer && !summary.saved && !pasting ? (
        <Caution
          message={`Open the Headwind console, go to Configurations, open ${configurationName} and press the QR button on it. Copy the JSON text shown beside the code and paste it here.`}
          title="No code saved yet"
        />
      ) : null}

      {notice ? (
        <p className="border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">{notice}</p>
      ) : null}

      {card.onServer ? (
        <div className="flex flex-wrap gap-2">
          {canShow && !revealed ? (
            <button className={PRIMARY_BUTTON} disabled={revealing} onClick={() => void reveal()} type="button">
              {revealing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <QrCode aria-hidden className="size-4" />}
              Show the code
            </button>
          ) : null}
          <button className={SECONDARY_BUTTON} onClick={() => setPasting((open) => !open)} type="button">
            {summary.saved ? "Replace the code" : "Paste the code"}
          </button>
        </div>
      ) : null}

      {revealError ? <Failure message={revealError} title="The code could not be shown" /> : null}

      {revealed ? (
        <div className="space-y-3 border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-700">
            On a new or factory-reset tablet for {revealed.configurationName}, tap the welcome screen six times to
            open its camera, then scan this. The tablet downloads the management agent and comes up fully managed by
            the company&rsquo;s own server, on these rules.
          </p>
          {qr ? (
            <QrImage code={qr} label={`Headwind enrollment QR code for ${revealed.configurationName}`} />
          ) : (
            <p className="text-sm text-rose-900">
              The saved code could not be drawn as a QR. Paste it again from the Headwind console.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {qr ? (
              <button
                className={SECONDARY_BUTTON}
                onClick={() =>
                  saveQrImage(
                    qr,
                    revealed.templateName ?? revealed.configurationName,
                    `headwind-enrollment-qr-${fileSlug(revealed.configurationName)}.png`,
                  )
                }
                type="button"
              >
                <Download aria-hidden className="size-4" />
                Save as an image
              </button>
            ) : null}
            <button className={SECONDARY_BUTTON} onClick={() => setRevealed(null)} type="button">
              <EyeOff aria-hidden className="size-4" />
              Hide the code
            </button>
          </div>
          <p className="text-[11px] font-semibold text-slate-500">
            Anyone who scans this enrolls a tablet into the company fleet. It is shown only while this panel is open.
          </p>
        </div>
      ) : null}

      {pasting && card.onServer ? (
        <div className="space-y-3 border border-slate-200 p-4">
          <label className="block min-w-0">
            <span className={`block ${MICRO_LABEL}`}>A name for it</span>
            <input
              className={`${phxFieldClassName} mt-1 min-w-0`}
              onChange={(event) => setTemplateName(event.target.value)}
              placeholder={configurationName}
              type="text"
              value={templateName}
            />
            <span className="mt-1 block text-[10px] font-semibold text-slate-400">
              Only so this page can name it later. It changes nothing on the Headwind server.
            </span>
          </label>
          <label className="block min-w-0">
            <span className={`block ${MICRO_LABEL}`}>QR payload for {configurationName}, from the Headwind console</span>
            <textarea
              className={cn(phxTextareaClassName, "mt-1 min-h-40 min-w-0 font-mono")}
              onChange={(event) => setRaw(event.target.value)}
              placeholder='{"android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.hmdm.launcher/.AdminReceiver", and the rest of the text}'
              value={raw}
            />
          </label>
          {saveError ? <Failure message={saveError} title="That was not saved" /> : null}
          <button className={PRIMARY_BUTTON} disabled={saving || !raw.trim()} onClick={() => void save()} type="button">
            {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Save the code
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function HeadwindEnrollment() {
  const [state, setState] = useState<EnrollmentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The repo's fetch-on-mount idiom: a non-async callback returning a promise chain, with EVERY
  // setState inside a callback. Nothing is set synchronously in the effect body — `loading` starts
  // true instead — or the render cascades.
  const readState = useCallback((isCurrent: () => boolean = () => true) => {
    return requestJson<EnrollmentState>(ENDPOINT)
      .then((next) => {
        if (!isCurrent()) return;
        setState(next);
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!isCurrent()) return;
        setLoadError(messageOf(caught, "Could not read the saved Headwind enrollment codes."));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, []);

  useEffect(() => {
    let current = true;
    void readState(() => current);
    return () => {
      current = false;
    };
  }, [readState]);

  const replaceCard = useCallback((saved: EnrollmentCard) => {
    setState((previous) =>
      previous
        ? {
            ...previous,
            cards: previous.cards.map((card) => (card.configurationId === saved.configurationId ? saved : card)),
          }
        : previous,
    );
  }, []);

  return (
    <section className="space-y-4 border border-slate-200 bg-white p-5">
      <div>
        <p className={MICRO_LABEL}>Enroll a tablet &middot; company server</p>
        <h2 className="mt-1 text-lg font-black text-slate-900">The code a new tablet scans</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Each line&rsquo;s tablets follow their own set of rules, and Headwind makes a separate code for each set.
          A tablet must be enrolled with its own line&rsquo;s code, or it lands on the wrong rules and never gets its
          line&rsquo;s app. Paste each code here once and this page shows it from then on. Phoenix does not build the
          codes itself: each carries a signature of the agent the server is serving, and a tablet checks that
          signature before it installs anything.
        </p>
      </div>

      {loading && !state ? (
        <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
          Reading the saved enrollment codes&hellip;
        </p>
      ) : null}

      {loadError ? <Failure message={loadError} title="The codes did not load" /> : null}

      {state && state.cards.length === 0 ? (
        <Caution
          message='The tablet server has no set of rules named "Rep tablets" yet, so there is nothing to enrol a rep tablet onto.'
          title="No sets of rules"
        />
      ) : null}

      {state?.cards.map((card) => (
        <EnrollmentCodeCard card={card} key={card.configurationId} onSaved={replaceCard} />
      ))}

      {state?.unassigned ? (
        <article className="space-y-3 border border-slate-200 p-4">
          <div>
            <p className={MICRO_LABEL}>Older code</p>
            <h3 className="mt-1 text-base font-black text-slate-900">Saved before each line had its own rules</h3>
          </div>
          <CodeFacts summary={state.unassigned} />
          {state.unassigned.problem ? <Caution message={state.unassigned.problem} title="Not offered for scanning" /> : null}
        </article>
      ) : null}
    </section>
  );
}
