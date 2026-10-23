"use client";

/**
 * Enrolling a new rep tablet onto the company's own Headwind server.
 *
 * 🔴 PHOENIX NEVER MINTS THIS CODE, AND THAT IS NOT A LIMITATION TO BE ENGINEERED AROUND. The payload
 * carries a checksum of the agent APK the server itself is serving — `android.app.extra.PROVISIONING_
 * DEVICE_ADMIN_SIGNATURE_CHECKSUM`. A code Phoenix assembled would carry a checksum Phoenix guessed,
 * and a factory-fresh tablet checks it before it installs anything: the tablet would refuse the
 * enrollment with a message about a corrupt package, and the obvious conclusion would be that the
 * server is broken. So the owner pastes Headwind's own code once, and this page redraws it from then
 * on — exactly the pattern the ManageEngine card beside it has already proven.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL. Scanning it puts a tablet into the company's fleet, so it is never
 * part of the page's ordinary load: the page asks for it only when a person presses "Show the code",
 * it lives in component state while it is on screen, and "Hide the code" drops it. It is never stored
 * in the browser, never logged, never in a URL. The audit row records the LOOK and never the payload.
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
  serverHost: string | null;
  configurationName: string | null;
  hasChecksum: boolean;
  joinsWifi: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

type RevealedTemplate = { payload: string; templateName: string | null };

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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border border-slate-200 bg-slate-50 px-3 py-2">
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1 break-words text-sm font-bold text-slate-900">{children}</p>
    </div>
  );
}

export function HeadwindEnrollment() {
  const [summary, setSummary] = useState<EnrollmentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // The repo's fetch-on-mount idiom, as the ManageEngine card beside it does it: a non-async callback
  // returning a promise chain, with EVERY setState inside a callback. Nothing is set synchronously in
  // the effect body — `loading` starts true instead — or the render cascades.
  const readState = useCallback((isCurrent: () => boolean = () => true) => {
    return requestJson<EnrollmentSummary>("/api/devices/headwind/enrollment")
      .then((state) => {
        if (!isCurrent()) return;
        setSummary(state);
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        if (!isCurrent()) return;
        setLoadError(messageOf(caught, "Could not read the saved Headwind enrollment code."));
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

  const save = useCallback(() => {
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    return requestJson<EnrollmentSummary>("/api/devices/headwind/enrollment", {
      raw,
      templateName: templateName.trim() || null,
    })
      .then((state) => {
        setSummary(state);
        setRaw("");
        setPasting(false);
        // A replaced code makes an old one on screen wrong, so it goes.
        setRevealed(null);
        setNotice("Saved. Any factory-fresh tablet that scans this code joins the company's own fleet.");
      })
      .catch((caught: unknown) => setSaveError(messageOf(caught, "Could not save the enrollment code.")))
      .finally(() => setSaving(false));
  }, [raw, templateName]);

  const reveal = useCallback(() => {
    setRevealing(true);
    setRevealError(null);
    return requestJson<RevealedTemplate>("/api/devices/headwind/enrollment", { show: true })
      .then((result) => setRevealed(result))
      .catch((caught: unknown) => setRevealError(messageOf(caught, "Could not show the enrollment code.")))
      .finally(() => setRevealing(false));
  }, []);

  const qr = useMemo<QrSymbol | null>(() => {
    if (!revealed) return null;
    try {
      return encodeQrText(revealed.payload);
    } catch {
      return null;
    }
  }, [revealed]);

  return (
    <section className="space-y-4 border border-slate-200 bg-white p-5">
      <div>
        <p className={MICRO_LABEL}>Enroll a tablet &middot; company server</p>
        <h2 className="mt-1 text-lg font-black text-slate-900">The code a new tablet scans</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Headwind makes this code once, in its own console, and it is the same for every tablet enrolled
          through it. Paste it here once and this page shows it from then on, so no tablet needs a trip to
          that console. Phoenix does not build the code itself: it carries a signature of the agent the
          server is serving, and a tablet checks that signature before it installs anything.
        </p>
      </div>

      {loading && !summary ? (
        <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
          Reading the saved enrollment code&hellip;
        </p>
      ) : null}

      {loadError ? (
        <div className="border border-rose-300 bg-rose-50 p-4">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-800">The code did not load</p>
          <p className="mt-1 break-words text-sm text-rose-900">{loadError}</p>
        </div>
      ) : null}

      {summary?.saved ? (
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
            <span className={CHIP}>{summary.downloadHost ? `Agent from ${summary.downloadHost}` : "No download host"}</span>
            <span className={CHIP}>
              {summary.configurationName ? `Lands on ${summary.configurationName}` : "No rules named"}
            </span>
            {/*
              🔴 A CODE WITH NO CHECKSUM IS REFUSED BY A FACTORY-FRESH TABLET, and the refusal on the
              tablet says nothing about a checksum — so this chip is the only warning there is going to
              be. It earns its place beside the two neutral facts.
            */}
            {summary.hasChecksum ? (
              <span className={CHIP}>Agent signature pinned</span>
            ) : (
              <span className={WARNING_CHIP}>No signature pinned</span>
            )}
            <span className={CHIP}>{summary.joinsWifi ? "Joins Wi-Fi during setup" : "No Wi-Fi in the code"}</span>
          </div>
        </>
      ) : null}

      {summary && !summary.saved && !pasting ? (
        <div className="border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-amber-800">No code saved yet</p>
          <p className="mt-1">
            Open the Headwind console, go to Configurations, open the set of rules the rep tablets use and press
            the QR button on it. Copy the JSON text shown beside the code and paste it below; this page takes
            over from there.
          </p>
        </div>
      ) : null}

      {notice ? (
        <p className="border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">{notice}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {summary?.saved && !revealed ? (
          <button className={PRIMARY_BUTTON} disabled={revealing} onClick={() => void reveal()} type="button">
            {revealing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <QrCode aria-hidden className="size-4" />}
            Show the code
          </button>
        ) : null}
        <button className={SECONDARY_BUTTON} onClick={() => setPasting((open) => !open)} type="button">
          {summary?.saved ? "Replace the code" : "Paste the code"}
        </button>
      </div>

      {revealError ? (
        <div className="border border-rose-300 bg-rose-50 p-4">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-800">The code could not be shown</p>
          <p className="mt-1 break-words text-sm text-rose-900">{revealError}</p>
        </div>
      ) : null}

      {revealed ? (
        <div className="space-y-3 border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-700">
            On a new or factory-reset tablet, tap the welcome screen six times to open its camera, then scan this.
            The tablet downloads the management agent and comes up fully managed by the company&rsquo;s own server.
          </p>
          {qr ? (
            <QrImage code={qr} label="Headwind enrollment QR code" />
          ) : (
            <p className="text-sm text-rose-900">
              The saved code could not be drawn as a QR. Paste it again from the Headwind console.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {qr ? (
              <button
                className={SECONDARY_BUTTON}
                onClick={() => saveQrImage(qr, revealed.templateName ?? "Headwind enrollment", "headwind-enrollment-qr.png")}
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

      {pasting ? (
        <div className="space-y-3 border border-slate-200 p-4">
          <label className="block min-w-0">
            <span className={`block ${MICRO_LABEL}`}>A name for it</span>
            <input
              className={`${phxFieldClassName} mt-1 min-w-0`}
              onChange={(event) => setTemplateName(event.target.value)}
              placeholder="Rep tablets"
              type="text"
              value={templateName}
            />
            <span className="mt-1 block text-[10px] font-semibold text-slate-400">
              Only so this page can name it later. It changes nothing on the Headwind server.
            </span>
          </label>
          <label className="block min-w-0">
            <span className={`block ${MICRO_LABEL}`}>QR payload from the Headwind console</span>
            <textarea
              className={cn(phxTextareaClassName, "mt-1 min-h-40 min-w-0 font-mono")}
              onChange={(event) => setRaw(event.target.value)}
              placeholder='{"android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "com.hmdm.launcher/.AdminReceiver", …}'
              value={raw}
            />
          </label>
          {saveError ? (
            <div className="border border-rose-300 bg-rose-50 p-4">
              <p className="text-[9px] font-black uppercase tracking-[0.14em] text-rose-800">That was not saved</p>
              <p className="mt-1 break-words text-sm text-rose-900">{saveError}</p>
            </div>
          ) : null}
          <button className={PRIMARY_BUTTON} disabled={saving || !raw.trim()} onClick={() => void save()} type="button">
            {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Save the code
          </button>
        </div>
      ) : null}
    </section>
  );
}
