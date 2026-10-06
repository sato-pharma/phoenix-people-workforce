"use client";

/**
 * The company app repository — what ManageEngine holds, and the one control that adds to it.
 *
 * WHY IT IS HERE. Every tablet's Apps section can only offer what the repository already holds, and
 * until this existed the repository could only be filled in the ManageEngine web console. So the
 * tablet panel read "the company app repository could not be read, so there is nothing to send from
 * here yet" and there was nothing anyone could do about it from Phoenix. This card is the missing
 * half: the APK goes in from here, and every tablet can then be sent it.
 *
 * ADDING IS NOT SENDING, and the card says so in every state. An app in the repository is on nobody's
 * tablet — distribution is the Apps section inside a tablet, one tablet at a time, with its own audit
 * row. That is why this card has no confirm step: an upload changes no tablet in a rep's hands.
 *
 * DESIGN IDENTITY is the Rep Tablets page around it — slate borders, square corners, 9px
 * micro-labels. It fits the screen: a `table-fixed` table with a `colgroup` on desktop, cards on a
 * phone, and nothing truncated.
 */

import { Loader2, PackagePlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { phxFieldClassName } from "@/components/ui/form-tokens";

const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";

type RepositoryApp = {
  appId: string;
  name: string;
  identifier: string | null;
  version: string | null;
  releaseLabelName: string | null;
};

type UploadResult = { message: string; app: RepositoryApp | null; fileId: string };

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

async function failureMessage(response: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const failure = (payload ?? {}) as { message?: unknown };
  return typeof failure.message === "string" && failure.message
    ? failure.message
    : "The server answered with an error and no explanation. Reload the page and try again.";
}

/** Megabytes, to one decimal — an APK is read in megabytes, never in bytes. */
function sizeLabel(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ManageEngineAppRepository() {
  const [apps, setApps] = useState<RepositoryApp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [appName, setAppName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // A promise chain rather than an async effect body, so no setState runs synchronously in an effect.
  const load = useCallback(
    (isCurrent: () => boolean) =>
      fetch("/api/devices/manageengine/apps", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(await failureMessage(response));
          return (await response.json()) as { apps: RepositoryApp[] };
        })
        .then((result) => {
          if (!isCurrent()) return;
          setApps(result.apps ?? []);
          setLoadError(null);
        })
        .catch((caught: unknown) => {
          if (isCurrent()) setLoadError(messageOf(caught, "Could not read the company app repository."));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        }),
    [],
  );

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  const upload = useCallback(() => {
    if (!file) {
      setFailure("Choose the APK file to add.");
      return;
    }
    setBusy(true);
    setNotice(null);
    setFailure(null);

    const body = new FormData();
    body.append("file", file);
    if (appName.trim()) body.append("appName", appName.trim());

    void fetch("/api/devices/manageengine/apps/upload", { body, method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await failureMessage(response));
        return (await response.json()) as UploadResult;
      })
      .then((result) => {
        setNotice(result.message);
        setFile(null);
        setAppName("");
        if (fileInput.current) fileInput.current.value = "";
        return load(() => true);
      })
      .catch((caught: unknown) => {
        setFailure(messageOf(caught, "Could not add that app to the company repository."));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [appName, file, load]);

  const rows = apps ?? [];

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-black text-slate-900">The company app repository</h2>
        <p className="text-[11px] font-semibold text-slate-500">Super Admin only</p>
      </div>
      <p className="mt-1 max-w-3xl text-[12px] font-semibold text-slate-600">
        These are the apps ManageEngine holds for this company — the only apps a tablet can be sent. Adding one here puts
        it on no tablet: open a tablet below and send it from that tablet&rsquo;s Apps section.
      </p>

      <div className="mt-4 border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <p className={MICRO_LABEL}>Add an Android app</p>
          <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-end">
            <label className="flex-1">
              <span className="block text-[11px] font-bold text-slate-700">APK file</span>
              <input
                accept=".apk,application/vnd.android.package-archive"
                className="mt-1 block w-full border border-slate-300 px-2 py-1.5 text-[12px] font-semibold text-slate-700 file:mr-3 file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-[11px] file:font-bold file:text-slate-700"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setFailure(null);
                }}
                ref={fileInput}
                type="file"
              />
            </label>
            <label className="flex-1">
              <span className="block text-[11px] font-bold text-slate-700">Name it (optional)</span>
              <input
                className={`${phxFieldClassName} mt-1 block`}
                disabled={busy}
                onChange={(event) => setAppName(event.target.value)}
                placeholder={file ? file.name.replace(/\.apk$/i, "") : "Taken from the file name"}
                type="text"
                value={appName}
              />
            </label>
            <button
              className="inline-flex items-center justify-center gap-1.5 border border-slate-900 bg-slate-900 px-3 py-2 text-[12px] font-bold text-white transition hover:bg-slate-700 disabled:opacity-50"
              disabled={busy || !file}
              onClick={upload}
              type="button"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <PackagePlus className="h-4 w-4" aria-hidden />
              )}
              Add to the repository
            </button>
          </div>
          {file ? (
            <p className="mt-2 break-words text-[11px] font-semibold text-slate-500">
              {file.name} · {sizeLabel(file.size)}
              {busy ? " · uploading to ManageEngine, which takes as long as the file is big" : ""}
            </p>
          ) : null}
        </div>

        {notice ? (
          <p className="border-b border-emerald-300 bg-emerald-50 px-4 py-3 text-[12px] font-semibold text-emerald-900">
            {notice}
          </p>
        ) : null}
        {failure ? (
          <p className="border-b border-rose-300 bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-800">
            {failure}
          </p>
        ) : null}
        {loadError ? (
          <p className="border-b border-rose-300 bg-rose-50 px-4 py-3 text-[12px] font-semibold text-rose-800">
            {loadError}
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 px-4 py-3 text-[12px] font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading the repository from ManageEngine…
          </p>
        ) : null}

        {!loading && !loadError && rows.length === 0 ? (
          <p className="px-4 py-3 text-[12px] font-semibold text-slate-600">
            ManageEngine holds no apps for this company yet, so no tablet can be sent one. Add an APK above.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <>
            {/* DESKTOP — table-fixed with a colgroup so nothing is shrunk to fit. */}
            <div className="hidden md:block">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[36%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-50">
                    {["App", "Package", "Version", "Channel"].map((heading) => (
                      <th className={`px-4 py-2 text-left ${MICRO_LABEL}`} key={heading} scope="col">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((app) => (
                    <tr className="border-b border-slate-100 align-top" key={app.appId}>
                      <td className="break-words px-4 py-2 text-[12px] font-black text-slate-900">{app.name}</td>
                      <td className="break-words px-4 py-2 text-[12px] font-semibold text-slate-600">
                        {app.identifier ?? "Not reported"}
                      </td>
                      <td className="break-words px-4 py-2 text-[12px] font-semibold text-slate-600">
                        {app.version ?? "Not reported"}
                      </td>
                      <td className="break-words px-4 py-2 text-[12px] font-semibold text-slate-600">
                        {app.releaseLabelName ?? "Stable"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* MOBILE — one card per app. */}
            <div className="space-y-3 px-4 py-3 md:hidden">
              {rows.map((app) => (
                <div className="border border-slate-200 px-3 py-2" key={app.appId}>
                  <p className="break-words text-[12px] font-black text-slate-900">{app.name}</p>
                  <p className="mt-1 break-words text-[12px] font-semibold text-slate-600">
                    {app.identifier ?? "Package not reported"}
                  </p>
                  <p className="mt-1 break-words text-[11px] font-semibold text-slate-500">
                    Version {app.version ?? "not reported"} · {app.releaseLabelName ?? "Stable"} channel
                  </p>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
