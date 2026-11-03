"use client";

import { Send, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { FormError, FormField } from "@/components/ui/form-kit";
import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxFieldClassName, phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import type { JobPostTitle, JobPostTitleDraft } from "@/lib/recruitment/job-posts/titles";
import { cardDescriptionEn, cardTitle, careersRouteForTitle, publishCardViolations } from "@/lib/recruitment/job-posts/website-cards";

type Props = {
  areaNoun: "area" | "region";
  areas: string[];
  draft: JobPostTitleDraft;
  edits: Record<string, string>;
  line: string | null;
  /** Which recruitment region each area sits under, for the starting location. */
  regionOf: (area: string) => string | null;
  saved: JobPostTitle;
  template: string;
  onArabicSaved: (arabic: { descriptionAr: string; titleAr: string }) => void;
  onClose: () => void;
};

/**
 * The one way a job post reaches the careers page: a person sees the picture, both titles, the location
 * and the apply form it reaches, types the Arabic, and presses. Nothing fills the Arabic by machine.
 */
export function JobPostPublishDialog({ areaNoun, areas, draft, edits, line, regionOf, saved, template, onArabicSaved, onClose }: Props) {
  const router = useRouter();
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose, open: true });
  const [area, setArea] = useState<string>(areas[0] ?? "");
  const [areaAr, setAreaAr] = useState("");
  const [titleAr, setTitleAr] = useState(saved.titleAr ?? "");
  const [descEn, setDescEn] = useState(() => cardDescriptionEn(draft));
  const [descAr, setDescAr] = useState(saved.descriptionAr ?? "");
  const [locationOverride, setLocationOverride] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ applyUrl: string; title: string } | null>(null);

  // Frozen when the dialog opens: the builder rebuilds these on every render, and the picture on show must
  // be the picture the press sends.
  const [frozen] = useState(() => ({ areaNoun, areas, edits, line, template, title: draft }));
  const post = useMemo(() => ({ ...frozen, area: area || null }), [frozen, area]);

  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    fetch("/api/recruitment/job-posts/publish", {
      body: JSON.stringify({ ...post, mode: "preview" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data.message ?? "The picture could not be drawn.");
        }
        url = URL.createObjectURL(await res.blob());
        setPicture(url);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setPictureError(err instanceof Error ? err.message : "The picture could not be drawn.");
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [post]);

  const region = area ? regionOf(area) : null;
  const location = locationOverride ?? (area ? (region ? `${area}, ${region}` : area) : draft.location);
  const titleEn = cardTitle(draft.title, area || null);
  const route = careersRouteForTitle(titleEn);
  const card = { descAr, descEn, location, titleAr: titleAr.trim() ? cardTitle(titleAr, area ? areaAr : null) : "", titleEn };
  const missing = [...(area && !areaAr.trim() ? ["Type the area in Arabic."] : []), ...publishCardViolations(card)];

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recruitment/job-posts/publish", {
        body: JSON.stringify({ ...post, areaAr, descAr, descEn, location, mode: "publish", titleAr, titleId: saved.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as { applyUrl?: string; message?: string; title?: string };
      if (!res.ok || !data.applyUrl) throw new Error(data.message ?? "The job post could not be published.");
      onArabicSaved({ descriptionAr: descAr.trim(), titleAr: titleAr.trim() });
      setDone({ applyUrl: data.applyUrl, title: data.title ?? titleEn });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The job post could not be published.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-4">
      <div aria-labelledby="job-post-publish-title" aria-modal className="mx-auto w-full max-w-4xl bg-white" ref={dialogRef} role="dialog">
        <header className={`${adminPanelHeaderClassName} flex items-center justify-between gap-4 px-4 py-2.5`}>
          <h2 className="text-sm font-bold" id="job-post-publish-title">
            Publish to the careers page
          </h2>
          <button aria-label="Close" onClick={onClose} type="button">
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>
        {done ? (
          <div className="space-y-3 p-4 text-sm">
            <p className="font-semibold text-slate-800">“{done.title}” is on the careers page.</p>
            <p>
              <a className="font-semibold text-orange-700 underline" href={done.applyUrl} rel="noreferrer" target="_blank">
                Open its apply form
              </a>
            </p>
            <button className={phxButtonGhostClassName} onClick={onClose} type="button">
              Done
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="min-w-0 space-y-2">
              {picture ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob of the drawn post, not a site asset
                <img alt={`The job post picture for ${titleEn}`} className="w-full border border-slate-200" src={picture} />
              ) : pictureError ? (
                <FormError>{pictureError}</FormError>
              ) : (
                <div className="aspect-[4/5] w-full animate-pulse bg-slate-100" />
              )}
              <p className="text-xs font-semibold text-slate-700">One press makes one card for one area, with this picture.</p>
            </div>
            <div className="min-w-0 space-y-3">
              {areas.length > 1 ? (
                <FormField label={areaNoun === "region" ? "Which region" : "Which area"}>
                  <select className={phxSelectClassName} onChange={(event) => { setArea(event.target.value); setAreaAr(""); setLocationOverride(null); setPicture(null); setPictureError(null); }} value={area}>
                    {areas.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </FormField>
              ) : null}
              <div className="text-sm">
                <p className="font-bold text-slate-800">{titleEn}</p>
                <p className={route ? "text-xs text-slate-600" : "text-xs font-semibold text-red-700"}>
                  {route ? `Applicants reach the ${route.label} form.` : "This title reaches no apply form, so it cannot be published."}
                </p>
              </div>
              <FormField label="Job title in Arabic">
                <input className={phxFieldClassName} dir="rtl" onChange={(event) => setTitleAr(event.target.value)} value={titleAr} />
              </FormField>
              {area ? (
                <FormField label={areaNoun === "region" ? "This region in Arabic" : "This area in Arabic"}>
                  <input className={phxFieldClassName} dir="rtl" onChange={(event) => setAreaAr(event.target.value)} value={areaAr} />
                </FormField>
              ) : null}
              <FormField label="Location">
                <input className={phxFieldClassName} onChange={(event) => setLocationOverride(event.target.value)} value={location} />
              </FormField>
              <FormField label="Description in English">
                <textarea className={phxTextareaClassName} onChange={(event) => setDescEn(event.target.value)} rows={5} value={descEn} />
              </FormField>
              <FormField label="Description in Arabic">
                <textarea className={phxTextareaClassName} dir="rtl" onChange={(event) => setDescAr(event.target.value)} rows={5} value={descAr} />
              </FormField>
              <FormError>{error}</FormError>
              {missing.length && !error ? <p className="text-xs font-semibold text-amber-700">{missing[0]}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button className={phxButtonGhostClassName} disabled={busy} onClick={onClose} type="button">
                  Cancel
                </button>
                <button className={phxButtonPrimaryClassName} disabled={busy || missing.length > 0 || !picture} onClick={publish} type="button">
                  <Send aria-hidden className="h-4 w-4" /> {busy ? "Publishing…" : "Publish this card"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
