"use client";

// Recruitment — the Job Posts builder (app/(admin)/recruitment/job-posts).
//
// Left: the job title and its words — saved with the title. Right: the five designs, the live
// preview and the downloads. The preview is the SAME HTML the server draws (renderJobPostHtml), in a
// sandboxed frame, so what downloads is what was on screen.
//
// 🔴 THE AREAS AND THE LINE BELONG TO THIS POST, NOT TO THE TITLE. One area is one rep (owner,
// 2026-10-15) — so an area is picked, never counted — and "Download all" gives the all-areas picture
// plus one per area. The line prints only when "Show the line" is ticked.
//
// 🔒 One form design (form-kit), square corners, no horizontal scroll at any width.

import { ArrowDown, ArrowUp, Download, FileArchive, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { getJson, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { CheckTile, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import {
  JOB_POST_HEIGHT,
  JOB_POST_MAX_AREAS,
  JOB_POST_TEMPLATES,
  JOB_POST_WIDTH,
  jobPostForArea,
  renderJobPostHtml,
  type JobPostAssets,
  type JobPostLine,
  type JobPostTemplateKey,
} from "@/lib/recruitment/job-posts/templates";
import {
  JOB_POST_MAX_LINES,
  contentFromDraft,
  titleDraftViolations,
  type JobPostTitle,
  type JobPostTitleDraft,
} from "@/lib/recruitment/job-posts/titles";

type Props = {
  initialTitles: JobPostTitle[];
  areaGroups: Array<{ label: string; areas: string[] }>;
  lines: string[];
  apply: { whatsapp: string; careers: string };
};

const NEW = "__new__";

const EMPTY_DRAFT: JobPostTitleDraft = {
  department: "Human Resources",
  duties: [{ lead: "", rest: "" }],
  employment: "Full-time",
  headline: null,
  isActive: true,
  location: "Sheraton, Cairo",
  menuName: null,
  needs: [{ lead: "", rest: "" }],
  reportsTo: null,
  title: "",
};

function draftOf(title: JobPostTitle): JobPostTitleDraft {
  const { id: _id, updatedAt: _updatedAt, ...draft } = title;
  return { ...draft, duties: draft.duties.map((l) => ({ ...l })), needs: draft.needs.map((l) => ({ ...l })) };
}

/** The draft as it would be saved: empty editor rows dropped. */
function cleaned(draft: JobPostTitleDraft): JobPostTitleDraft {
  const keep = (lines: JobPostLine[]) =>
    lines.map((l) => ({ lead: l.lead.trim(), rest: l.rest.trim() })).filter((l) => l.lead || l.rest);
  return { ...draft, duties: keep(draft.duties), needs: keep(draft.needs), title: draft.title.trim() };
}

async function toDataUri(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** A value that settles `delay` ms after it stops changing — the preview redraws on a pause, not per key. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** One post, drawn at its true 1080×1350 and scaled to the width it is given. */
function PostFrame({ html, label }: { html: string; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const scale = width / JOB_POST_WIDTH;
  return (
    <div ref={box} className="relative w-full overflow-hidden bg-slate-100" style={{ aspectRatio: `${JOB_POST_WIDTH} / ${JOB_POST_HEIGHT}` }}>
      {width > 0 ? (
        <iframe
          className="pointer-events-none absolute left-0 top-0 border-0"
          sandbox="allow-scripts"
          srcDoc={html}
          style={{ height: JOB_POST_HEIGHT, transform: `scale(${scale})`, transformOrigin: "0 0", width: JOB_POST_WIDTH }}
          tabIndex={-1}
          title={label}
        />
      ) : null}
    </div>
  );
}

function LinesEditor({
  label,
  lines,
  onChange,
}: {
  label: string;
  lines: JobPostLine[];
  onChange: (next: JobPostLine[]) => void;
}) {
  const set = (index: number, patch: Partial<JobPostLine>) => onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const move = (index: number, by: number) => {
    const next = [...lines];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row!);
    onChange(next);
  };
  return (
    <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-black uppercase tracking-wide text-slate-700">{label}</h3>
        <span className="text-xs font-semibold text-slate-500">
          {lines.length} of {JOB_POST_MAX_LINES}
        </span>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-slate-500">
          Each line has a bold opening and the rest in plain type, the way every approved post reads.
        </p>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-start">
            <input
              aria-label={`${label} line ${index + 1}, bold part`}
              className={phxFieldClassName}
              onChange={(event) => set(index, { lead: event.target.value })}
              placeholder="Bold part"
              value={line.lead}
            />
            <input
              aria-label={`${label} line ${index + 1}, the rest`}
              className={phxFieldClassName}
              onChange={(event) => set(index, { rest: event.target.value })}
              placeholder="The rest of the line"
              value={line.rest}
            />
            <div className="flex gap-1">
              <button aria-label="Move up" className={phxButtonGhostClassName} disabled={index === 0} onClick={() => move(index, -1)} type="button">
                <ArrowUp aria-hidden className="h-4 w-4" />
              </button>
              <button
                aria-label="Move down"
                className={phxButtonGhostClassName}
                disabled={index === lines.length - 1}
                onClick={() => move(index, 1)}
                type="button"
              >
                <ArrowDown aria-hidden className="h-4 w-4" />
              </button>
              <button aria-label="Remove line" className={phxButtonGhostClassName} onClick={() => onChange(lines.filter((_, i) => i !== index))} type="button">
                <Trash2 aria-hidden className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
        <button
          className={phxButtonGhostClassName}
          disabled={lines.length >= JOB_POST_MAX_LINES}
          onClick={() => onChange([...lines, { lead: "", rest: "" }])}
          type="button"
        >
          <Plus aria-hidden className="h-4 w-4" /> Add a line
        </button>
      </div>
    </section>
  );
}

export function JobPostBuilder({ initialTitles, areaGroups, lines, apply }: Props) {
  const [titles, setTitles] = useState(initialTitles);
  const [selectedId, setSelectedId] = useState<string>(initialTitles[0]?.id ?? NEW);
  const [draft, setDraft] = useState<JobPostTitleDraft>(initialTitles[0] ? draftOf(initialTitles[0]) : EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [areas, setAreas] = useState<string[]>([]);
  const [areaFilter, setAreaFilter] = useState("");
  const [showLine, setShowLine] = useState(false);
  const [line, setLine] = useState(lines[0] ?? "");
  const [template, setTemplate] = useState<JobPostTemplateKey>("executive");
  const [variant, setVariant] = useState<string | null>(null);
  const [assets, setAssets] = useState<JobPostAssets | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      toDataUri("/fonts/montserrat-regular.ttf"),
      toDataUri("/fonts/montserrat-bold.ttf"),
      toDataUri("/brand/sato-pharma-logo-on-light.png"),
    ])
      .then(([fontRegular, fontBold, logo]) => live && setAssets({ fontBold, fontRegular, logo }))
      .catch(() => live && setError("The preview could not load its fonts. Downloads still work."));
    return () => {
      live = false;
    };
  }, []);

  // A per-area preview of an area that was since removed falls back to the all-areas picture.
  useEffect(() => {
    if (variant && !areas.includes(variant)) setVariant(null);
  }, [areas, variant]);

  const edit = (patch: Partial<JobPostTitleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setNotice(null);
  };

  const pick = (id: string) => {
    if (dirty && !window.confirm("Your changes to this title are not saved. Leave them?")) return;
    setSelectedId(id);
    const found = titles.find((t) => t.id === id);
    setDraft(found ? draftOf(found) : { ...EMPTY_DRAFT, duties: [{ lead: "", rest: "" }], needs: [{ lead: "", rest: "" }] });
    setDirty(false);
    setError(null);
    setNotice(null);
  };

  const saveDraft = cleaned(draft);
  const problems = titleDraftViolations(saveDraft);
  const postLine = showLine && line ? line : null;

  const content = useMemo(
    () => contentFromDraft(saveDraft, { areas, line: postLine }, apply),
    // saveDraft is rebuilt every render; the draft it comes from is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, areas, postLine, apply],
  );
  const shown = useSettled(variant ? jobPostForArea(content, variant) : content, 250);
  const thumbs = useSettled(content, 900);

  const mainHtml = useMemo(() => (assets ? renderJobPostHtml(shown, template, assets) : ""), [assets, shown, template]);
  const thumbHtml = useMemo(
    () => (assets ? JOB_POST_TEMPLATES.map((t) => renderJobPostHtml(thumbs, t.key, assets)) : []),
    [assets, thumbs],
  );

  async function save() {
    if (problems.length) {
      setError(problems[0]!);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const data =
        selectedId === NEW
          ? await postJson("/api/recruitment/job-posts/titles", saveDraft)
          : await patchJson(`/api/recruitment/job-posts/titles/${selectedId}`, saveDraft);
      const saved = data.title as JobPostTitle;
      const list = (await getJson("/api/recruitment/job-posts/titles")).titles as JobPostTitle[];
      setTitles(list);
      setSelectedId(saved.id);
      setDraft(draftOf(saved));
      setDirty(false);
      setNotice(`Saved "${saved.title}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The title could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function download(format: "png" | "pdf" | "zip") {
    if (problems.length) {
      setError(problems[0]!);
      return;
    }
    setBusy(format);
    setError(null);
    try {
      const res = await fetch("/api/recruitment/job-posts/render", {
        body: JSON.stringify({ area: format === "zip" ? null : variant, areas, format, line: postLine, template, title: saveDraft }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? "The post could not be drawn.");
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `job-post.${format}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The post could not be drawn.");
    } finally {
      setBusy(null);
    }
  }

  const toggleArea = (area: string, on: boolean) => {
    setAreas((current) => (on ? (current.length >= JOB_POST_MAX_AREAS ? current : [...current, area]) : current.filter((a) => a !== area)));
  };
  const filter = areaFilter.trim().toLowerCase();

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      {/* ── The words ── */}
      <div className="min-w-0 space-y-5">
        <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">Job title</h2>
          </div>
          <div className="space-y-4 p-4">
            <FormField htmlFor="job-post-pick" label="Build from">
              <select className={phxSelectClassName} id="job-post-pick" onChange={(event) => pick(event.target.value)} value={selectedId}>
                {titles.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
                <option value={NEW}>+ Add a new job title</option>
              </select>
            </FormField>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField htmlFor="job-post-title" label="Job title" required>
                <input className={phxFieldClassName} id="job-post-title" onChange={(e) => edit({ title: e.target.value })} value={draft.title} />
              </FormField>
              <FormField htmlFor="job-post-department" label="Department">
                <input className={phxFieldClassName} id="job-post-department" onChange={(e) => edit({ department: e.target.value })} value={draft.department} />
              </FormField>
              <FormField htmlFor="job-post-reports" label="Reports to">
                <input
                  className={phxFieldClassName}
                  id="job-post-reports"
                  onChange={(e) => edit({ reportsTo: e.target.value || null })}
                  value={draft.reportsTo ?? ""}
                />
              </FormField>
              <FormField htmlFor="job-post-employment" label="Employment">
                <input className={phxFieldClassName} id="job-post-employment" onChange={(e) => edit({ employment: e.target.value })} value={draft.employment} />
              </FormField>
              <FormField hint="Shown when the post names no area." htmlFor="job-post-location" label="Location">
                <input className={phxFieldClassName} id="job-post-location" onChange={(e) => edit({ location: e.target.value })} value={draft.location} />
              </FormField>
              <FormField hint="The word after “choose” on the WhatsApp line. Empty uses the job title." htmlFor="job-post-menu" label="WhatsApp choice">
                <input
                  className={phxFieldClassName}
                  id="job-post-menu"
                  onChange={(e) => edit({ menuName: e.target.value || null })}
                  value={draft.menuName ?? ""}
                />
              </FormField>
            </div>
            <FormField hint="Optional, up to two lines. Empty prints the job title large instead." htmlFor="job-post-headline" label="Headline">
              <textarea
                className={phxTextareaClassName}
                id="job-post-headline"
                onChange={(e) => edit({ headline: e.target.value || null })}
                rows={2}
                value={draft.headline ?? ""}
              />
            </FormField>
          </div>
        </section>

        <LinesEditor label="What you will do" lines={draft.duties} onChange={(duties) => edit({ duties })} />
        <LinesEditor label="What you need" lines={draft.needs} onChange={(needs) => edit({ needs })} />

        <div className="flex flex-wrap items-center gap-3">
          <button className={phxButtonPrimaryClassName} disabled={busy !== null || !dirty} onClick={save} type="button">
            <Save aria-hidden className="h-4 w-4" /> {selectedId === NEW ? "Add job title" : "Save to title"}
          </button>
          {dirty ? <span className="text-xs font-semibold text-amber-700">Unsaved changes — the preview already shows them.</span> : null}
          {notice ? <span className="text-xs font-semibold text-emerald-700">{notice}</span> : null}
        </div>

        <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">Areas and line</h2>
            <span className="text-xs font-semibold text-slate-500">For this post only</span>
          </div>
          <div className="space-y-4 p-4">
            <p className="text-xs leading-relaxed text-slate-500">
              Optional. One area is one rep. With two or more areas, Download all gives the all-areas post and one post for each area.
            </p>
            {areas.length ? (
              <div className="flex flex-wrap gap-2">
                {areas.map((area) => (
                  <button
                    aria-label={`Remove ${area}`}
                    className={phxButtonGhostClassName}
                    key={area}
                    onClick={() => toggleArea(area, false)}
                    type="button"
                  >
                    {area} <Trash2 aria-hidden className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            ) : null}
            <FormField htmlFor="job-post-area-filter" label="Find an area">
              <input
                className={phxFieldClassName}
                id="job-post-area-filter"
                onChange={(e) => setAreaFilter(e.target.value)}
                placeholder="Type to narrow the list"
                value={areaFilter}
              />
            </FormField>
            <div className={`max-h-72 space-y-4 overflow-y-auto border border-slate-200 bg-slate-50 p-3 ${adminSoftDepthClassName}`}>
              {areaGroups.map((group) => {
                const shownAreas = group.areas.filter((area) => !filter || area.toLowerCase().includes(filter));
                if (!shownAreas.length) return null;
                return (
                  <div key={group.label}>
                    <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{group.label}</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {shownAreas.map((area) => (
                        <CheckTile checked={areas.includes(area)} key={area} onChange={(on) => toggleArea(area, on)}>
                          <span className="text-sm font-semibold text-slate-800">{area}</span>
                        </CheckTile>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {lines.length ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
                <CheckTile checked={showLine} onChange={setShowLine}>
                  <span className="text-sm font-semibold text-slate-800">Show the line on the post</span>
                </CheckTile>
                <FormField htmlFor="job-post-line" label="Line">
                  <select className={phxSelectClassName} disabled={!showLine} id="job-post-line" onChange={(e) => setLine(e.target.value)} value={line}>
                    {lines.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {/* ── The picture ── */}
      <div className="min-w-0 space-y-5 xl:sticky xl:top-4 xl:self-start">
        <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">Design</h2>
          </div>
          <div className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-5">
            {JOB_POST_TEMPLATES.map((t, index) => (
              <CheckTile checked={template === t.key} key={t.key} name="job-post-template" onChange={() => setTemplate(t.key)} type="radio">
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {thumbHtml[index] ? <PostFrame html={thumbHtml[index]!} label={`${t.name} design`} /> : <span className="block aspect-[4/5] bg-slate-100" />}
                  <span className="text-xs font-bold text-slate-800">{t.name}</span>
                </span>
              </CheckTile>
            ))}
          </div>
        </section>

        <section className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-700">Preview</h2>
            <span className="text-xs font-semibold text-slate-500">{JOB_POST_TEMPLATES.find((t) => t.key === template)?.description}</span>
          </div>
          <div className="space-y-3 p-4">
            {areas.length > 1 ? (
              <div className="flex flex-wrap gap-2" role="tablist">
                {[null, ...areas].map((area) => (
                  <button
                    aria-selected={variant === area}
                    className={variant === area ? phxButtonPrimaryClassName : phxButtonGhostClassName}
                    key={area ?? "all"}
                    onClick={() => setVariant(area)}
                    role="tab"
                    type="button"
                  >
                    {area ?? "All areas"}
                  </button>
                ))}
              </div>
            ) : null}
            {mainHtml ? <PostFrame html={mainHtml} label="Job post preview" /> : <div className="aspect-[4/5] w-full bg-slate-100" />}
            <FormError>{error}</FormError>
            <div className="flex flex-wrap gap-2">
              <button className={phxButtonPrimaryClassName} disabled={busy !== null} onClick={() => download("png")} type="button">
                <Download aria-hidden className="h-4 w-4" /> {busy === "png" ? "Drawing…" : "Download picture"}
              </button>
              <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => download("pdf")} type="button">
                <Download aria-hidden className="h-4 w-4" /> {busy === "pdf" ? "Drawing…" : "Download PDF"}
              </button>
              {areas.length > 1 ? (
                <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => download("zip")} type="button">
                  <FileArchive aria-hidden className="h-4 w-4" /> {busy === "zip" ? `Drawing ${areas.length + 1} posts…` : "Download all (ZIP)"}
                </button>
              ) : null}
            </div>
            {areas.length > 1 ? (
              <p className="text-xs leading-relaxed text-slate-500">
                Download all gives {areas.length + 1} pictures — all areas, then one for each area — and one PDF with every page.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
