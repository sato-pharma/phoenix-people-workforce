"use client";

// Recruitment — the Job Posts builder (app/(admin)/recruitment/job-posts).
//
// Six numbered steps down the left — the job title, what you will do, what you need, the areas and
// line, then the design and the preview with its downloads on the right. The preview is the SAME HTML
// the server draws (renderJobPostHtml), in a sandboxed frame, so what downloads is what was on screen.
//
// 🔴 CHOOSING A JOB TITLE FILLS BOTH LISTS AT ONCE. The picker loads that title's saved duties and
// requirements the moment it changes; typing the name of a saved title into a NEW one loads it too
// (only while the new draft is still empty, so nothing typed is ever thrown away). The words belong to
// the title, never to a design.
//
// 🔴 THE AREAS AND THE LINE BELONG TO THIS POST, NOT TO THE TITLE. One area is one rep (owner,
// 2026-10-15) — so an area is picked, never counted — and "Download all" gives the all-areas picture
// plus one per area. The line prints only when "Show the line" is ticked.
//
// 🔒 One form design (form-kit), square corners, the shared admin depth tokens, and no horizontal
// scroll at any width. Every panel wears the dark header band (adminPanelHeaderClassName).

import { ArrowDown, ArrowUp, Check, Download, FileArchive, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  adminChipDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { CheckTile, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxFieldInvalidClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
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

/** Suggestions for the Department field; the saved titles' own departments are added to these. */
const DEPARTMENT_SUGGESTIONS = ["Sales", "Marketing", "Human Resources"];

const panelClassName = `border border-slate-200 bg-white ${adminPanelDepthClassName}`;
const chipClassName = `inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-700 ${adminChipDepthClassName}`;
const noticeClassName = `flex items-start gap-2 border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-semibold text-slate-800 ${adminChipDepthClassName}`;

/** A fresh, empty title. Department is left blank on purpose: a post must name it, never inherit one. */
function emptyDraft(): JobPostTitleDraft {
  return {
    department: "",
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
}

function draftOf(title: JobPostTitle): JobPostTitleDraft {
  const { id: _id, updatedAt: _updatedAt, ...draft } = title;
  return { ...draft, duties: draft.duties.map((l) => ({ ...l })), needs: draft.needs.map((l) => ({ ...l })) };
}

/** The draft as it would be saved: empty editor rows dropped. */
function cleaned(draft: JobPostTitleDraft): JobPostTitleDraft {
  const keep = (lines: JobPostLine[]) =>
    lines.map((l) => ({ lead: l.lead.trim(), rest: l.rest.trim() })).filter((l) => l.lead || l.rest);
  return { ...draft, department: draft.department.trim(), duties: keep(draft.duties), needs: keep(draft.needs), title: draft.title.trim() };
}

function isBlank(lines: JobPostLine[]): boolean {
  return lines.every((l) => !l.lead.trim() && !l.rest.trim());
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

/** The dark band every panel opens with: its step number, its name, and a short status on the right. */
function PanelHeader({ step, title, aside }: { step?: number; title: string; aside?: ReactNode }) {
  return (
    <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5`}>
      <div className="flex min-w-0 items-center gap-3">
        {step ? (
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center bg-orange-500 text-phx-xs font-black text-white">
            {step}
          </span>
        ) : null}
        <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
      </div>
      {aside ? <div className="text-phx-xs font-semibold text-slate-300">{aside}</div> : null}
    </header>
  );
}

/** What the page's layout pass reports: the text size as a share of normal, and whether it ran out of room. */
type PostFit = { k: number; limited: boolean };

const TOO_LONG_MESSAGE = "This post is too long to print at a readable size. Shorten a line, remove a line, or remove an area.";

/** The verdict of the layout pass, in words: "Fits at full size", "Text 85%", or "Too long". */
function FitBadge({ fit }: { fit: PostFit | undefined }) {
  if (!fit) return null;
  const tone = fit.limited ? "bg-red-50 text-red-800 ring-red-300" : fit.k < 1 ? "bg-amber-50 text-amber-800 ring-amber-300" : "bg-emerald-50 text-emerald-800 ring-emerald-300";
  return (
    <span className={cn("inline-block px-1.5 py-0.5 text-[11px] font-bold ring-1 ring-inset", tone)}>
      {fit.limited ? "Too long" : fit.k < 1 ? `Text ${Math.round(fit.k * 100)}%` : "Fits at full size"}
    </span>
  );
}

/**
 * One post, drawn at its true 1080×1350 and scaled to the box it is given.
 *
 * `boxClassName` is how the preview opts out of being sized by WIDTH. The picture is 4:5, so a
 * 630px column makes it 790px tall — and with the design strip and the buttons the whole right-hand
 * column came to about 1,560px against a ~900px screen (owner, 2026-10-16: "scrolling in job post
 * page is frustrating"). A sticky block taller than the viewport pins once and then scrolls away, so
 * the post could never be on screen at the same time as the words being edited. Sized from HEIGHT
 * instead, the column fits one screen and the sticky finally holds.
 */
function PostFrame({ html, label, onFit, boxClassName = "w-full" }: { html: string; label: string; onFit?: (fit: PostFit) => void; boxClassName?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const report = useRef(onFit);
  const [width, setWidth] = useState(0);
  // The frame is sandboxed without same-origin, so its layout pass cannot be read — it posts its
  // report to the parent instead. Only a message from THIS frame, with the two expected fields, counts.
  useEffect(() => {
    report.current = onFit;
  }, [onFit]);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const fit = (event.data as { jobPostFit?: { k?: unknown; limited?: unknown } } | null)?.jobPostFit;
      if (fit && typeof fit.k === "number" && typeof fit.limited === "boolean") report.current?.({ k: fit.k, limited: fit.limited });
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const scale = width / JOB_POST_WIDTH;
  return (
    <div ref={box} className={`relative overflow-hidden bg-slate-100 ${boxClassName}`} style={{ aspectRatio: `${JOB_POST_WIDTH} / ${JOB_POST_HEIGHT}` }}>
      {width > 0 ? (
        // maxWidth/maxHeight none: the admin shell clamps every iframe to max-width 100%, which would
        // squeeze this 1080px page into the box BEFORE the scale shrinks it — cutting the right half off.
        <iframe
          className="pointer-events-none absolute left-0 top-0 border-0"
          ref={frame}
          sandbox="allow-scripts"
          srcDoc={html}
          style={{ height: JOB_POST_HEIGHT, maxHeight: "none", maxWidth: "none", transform: `scale(${scale})`, transformOrigin: "0 0", width: JOB_POST_WIDTH }}
          tabIndex={-1}
          title={label}
        />
      ) : null}
    </div>
  );
}

function LinesEditor({
  step,
  label,
  lines,
  onChange,
}: {
  step: number;
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
  const filled = lines.filter((l) => l.lead.trim() || l.rest.trim()).length;
  return (
    <section className={panelClassName}>
      <PanelHeader aside={`${filled} of ${JOB_POST_MAX_LINES} lines`} step={step} title={label} />
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-slate-500">
          Each line has a bold opening and the rest in plain type, the way every approved post reads. The words are saved with the job title.
        </p>
        {lines.map((line, index) => {
          const missingLead = !line.lead.trim() && Boolean(line.rest.trim());
          return (
            <div key={index} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-start">
              <span aria-hidden className="flex h-10 w-7 items-center justify-center bg-slate-100 text-xs font-black text-slate-500">
                {String(index + 1).padStart(2, "0")}
              </span>
              <input
                aria-invalid={missingLead}
                aria-label={`${label} line ${index + 1}, bold part`}
                className={cn(phxFieldClassName, missingLead && phxFieldInvalidClassName)}
                onChange={(event) => set(index, { lead: event.target.value })}
                placeholder="Bold part"
                value={line.lead}
              />
              <input
                aria-label={`${label} line ${index + 1}, the rest`}
                className={cn(phxFieldClassName, "col-start-2 sm:col-start-auto")}
                onChange={(event) => set(index, { rest: event.target.value })}
                placeholder="The rest of the line"
                value={line.rest}
              />
              <div className="col-start-2 flex gap-1 sm:col-start-auto">
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
          );
        })}
        <button
          className={phxButtonGhostClassName}
          disabled={lines.length >= JOB_POST_MAX_LINES}
          onClick={() => onChange([...lines, { lead: "", rest: "" }])}
          type="button"
        >
          <Plus aria-hidden className="h-4 w-4" /> Add a line
        </button>
        {lines.length >= JOB_POST_MAX_LINES ? (
          <p className="text-xs font-semibold text-amber-700">
            {JOB_POST_MAX_LINES} lines is what one picture holds at a readable size. Remove one to add another.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function JobPostBuilder({ initialTitles, areaGroups, lines, apply }: Props) {
  const [titles, setTitles] = useState(initialTitles);
  const [selectedId, setSelectedId] = useState<string>(initialTitles[0]?.id ?? NEW);
  const [draft, setDraft] = useState<JobPostTitleDraft>(initialTitles[0] ? draftOf(initialTitles[0]) : emptyDraft());
  const [dirty, setDirty] = useState(false);
  const [areas, setAreas] = useState<string[]>([]);
  // A post names AREAS or whole REGIONS (owner, 2026-10-16: "also add regions for district
  // managers") — a district manager runs a district, so listing every area under it is wrong.
  // Switching clears the picks, because the two are different vocabularies and a mixed list would
  // print "3 areas" over a region name.
  const [areaScope, setAreaScope] = useState<"area" | "region">("area");
  const [areaFilter, setAreaFilter] = useState("");
  const [showLine, setShowLine] = useState(false);
  const [line, setLine] = useState(lines[0] ?? "");
  const [template, setTemplate] = useState<JobPostTemplateKey>("executive");
  const [pickedArea, setPickedArea] = useState<string | null>(null);
  const [assets, setAssets] = useState<JobPostAssets | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fits, setFits] = useState<Partial<Record<JobPostTemplateKey, PostFit>>>({});
  const [mainFit, setMainFit] = useState<PostFit | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialTitles[0] ? `Ready: the saved wording for “${initialTitles[0].title}” is loaded.` : null);

  useEffect(() => {
    let live = true;
    Promise.all([
      toDataUri("/fonts/montserrat-regular.ttf"),
      toDataUri("/fonts/montserrat-bold.ttf"),
      toDataUri("/brand/sato-pharma-logo-on-light.png"),
      toDataUri("/brand/sato-pharma-logo-on-navy-reverse.svg"),
      toDataUri("/brand/sato-pharma-logo-on-blue.svg"),
      toDataUri("/brand/sato-pharma-arabic-on-light.png"),
    ])
      .then(([fontRegular, fontBold, logo, logoOnDark, logoOnBlue, arabic]) => live && setAssets({ fontBold, fontRegular, logo, logoOnDark, logoOnBlue, arabic }))
      .catch(() => live && setError("The preview could not load its fonts. Downloads still work."));
    return () => {
      live = false;
    };
  }, []);

  // Leaving the page with unsaved wording asks first.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  // A per-area preview of an area that was since removed falls back to the all-areas picture —
  // derived, never synced through an effect.
  const variant = pickedArea && areas.includes(pickedArea) ? pickedArea : null;

  const edit = (patch: Partial<JobPostTitleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setNotice(null);
  };

  /** Load a saved title — both lists, the facts and the headline arrive together. */
  const load = (found: JobPostTitle) => {
    setSelectedId(found.id);
    setDraft(draftOf(found));
    setDirty(false);
    setError(null);
    setNotice(`Ready: the saved wording for “${found.title}” is loaded.`);
  };

  const pick = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm("Your changes to this title are not saved. Leave them?")) return;
    const found = titles.find((t) => t.id === id);
    if (found) {
      load(found);
      return;
    }
    setSelectedId(NEW);
    setDraft(emptyDraft());
    setDirty(false);
    setError(null);
    setNotice("A new job title: name it, then write what the job does and what it needs.");
  };

  // Typing the name of a SAVED title into a new one loads that title — but only while the new draft
  // has no words yet, so nothing the person wrote is ever replaced.
  const typeTitleName = (value: string) => {
    if (selectedId === NEW && isBlank(draft.duties) && isBlank(draft.needs)) {
      const match = titles.find((t) => t.title.trim().toLowerCase() === value.trim().toLowerCase());
      if (match) {
        load(match);
        return;
      }
    }
    edit({ title: value });
  };

  const saveDraft = cleaned(draft);
  const problems = [...titleDraftViolations(saveDraft), ...(saveDraft.department ? [] : ["Choose the department."])];
  const postLine = showLine && line ? line : null;
  const duplicateOfSaved =
    selectedId === NEW && saveDraft.title ? titles.find((t) => t.title.trim().toLowerCase() === saveDraft.title.toLowerCase()) : undefined;

  const departments = useMemo(
    () => [...new Set([...DEPARTMENT_SUGGESTIONS, ...titles.map((t) => t.department)])].filter(Boolean),
    [titles],
  );

  const content = useMemo(
    () => contentFromDraft(saveDraft, { areaNoun: areaScope, areas, line: postLine }, apply),
    // saveDraft is rebuilt every render; the draft it comes from is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, areas, areaScope, postLine, apply],
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
      // The saved row is put into the list directly: a failed refresh after a successful save must
      // never read as "could not be saved" and invite a second save.
      setTitles((current) =>
        [...current.filter((t) => t.id !== saved.id), saved].sort(
          (a, b) => Number(b.isActive) - Number(a.isActive) || a.title.localeCompare(b.title),
        ),
      );
      setSelectedId(saved.id);
      setDraft(draftOf(saved));
      setDirty(false);
      setNotice(`Saved “${saved.title}”. Its wording is ready next time you choose it.`);
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
        body: JSON.stringify({ area: format === "zip" ? null : variant, areaNoun: areaScope, areas, format, line: postLine, template, title: saveDraft }),
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

  const atAreaLimit = areas.length >= JOB_POST_MAX_AREAS;
  const toggleArea = (area: string, on: boolean) => {
    setAreas((current) => (on ? (current.length >= JOB_POST_MAX_AREAS ? current : [...current, area]) : current.filter((a) => a !== area)));
  };
  const regionOptions = areaGroups.map((group) => group.label);
  const pickScope = (next: "area" | "region") => {
    if (next === areaScope) return;
    setAreaScope(next);
    setAreas([]);
    setPickedArea(null);
  };
  const filter = areaFilter.trim().toLowerCase();
  const dutiesReady = saveDraft.duties.length;
  const needsReady = saveDraft.needs.length;
  const templateName = JOB_POST_TEMPLATES.find((t) => t.key === template);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      {/* ── The words ── */}
      <div className="min-w-0 space-y-5">
        <section className={panelClassName}>
          <PanelHeader
            aside={dirty ? <span className="text-amber-300">Unsaved changes</span> : selectedId === NEW ? "New title" : "Saved"}
            step={1}
            title="Job title"
          />
          <div className="space-y-4 p-4">
            <FormField
              hint="Choosing a title loads its saved “What you will do” and “What you need” straight away."
              htmlFor="job-post-pick"
              label="Job title"
            >
              <select className={phxSelectClassName} id="job-post-pick" onChange={(event) => pick(event.target.value)} value={selectedId}>
                {titles.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.isActive ? t.title : `${t.title} (switched off)`}
                  </option>
                ))}
                <option value={NEW}>+ Add a new job title</option>
              </select>
            </FormField>

            <div aria-live="polite" className="space-y-2" role="status">
              {notice ? (
                <p className={noticeClassName}>
                  <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
                  <span className="min-w-0">{notice}</span>
                </p>
              ) : null}
              {duplicateOfSaved ? (
                <p className="text-xs font-semibold text-amber-700">
                  A job title called “{duplicateOfSaved.title}” already exists. Choose it from the list above instead of adding it again.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <span className={chipClassName}>{dutiesReady} {dutiesReady === 1 ? "duty" : "duties"}</span>
                <span className={chipClassName}>{needsReady} {needsReady === 1 ? "requirement" : "requirements"}</span>
                {saveDraft.reportsTo ? <span className={chipClassName}>Reports to {saveDraft.reportsTo}</span> : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                hint={selectedId === NEW ? undefined : "Renaming changes it for every future post."}
                htmlFor="job-post-title"
                label={selectedId === NEW ? "New job title" : "Title printed on the post"}
                required
              >
                <input
                  className={phxFieldClassName}
                  id="job-post-title"
                  onChange={(e) => typeTitleName(e.target.value)}
                  value={draft.title}
                />
              </FormField>
              <FormField htmlFor="job-post-department" label="Department" required>
                <input
                  className={phxFieldClassName}
                  id="job-post-department"
                  list="job-post-departments"
                  onChange={(e) => edit({ department: e.target.value })}
                  value={draft.department}
                />
                <datalist id="job-post-departments">
                  {departments.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
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

        <LinesEditor label="What you will do" lines={draft.duties} onChange={(duties) => edit({ duties })} step={2} />
        <LinesEditor label="What you need" lines={draft.needs} onChange={(needs) => edit({ needs })} step={3} />

        <div className="flex flex-wrap items-center gap-3">
          <button className={phxButtonPrimaryClassName} disabled={busy !== null || !dirty} onClick={save} type="button">
            <Save aria-hidden className="h-4 w-4" /> {busy === "save" ? "Saving…" : selectedId === NEW ? "Add job title" : "Save to title"}
          </button>
          {dirty ? <span className="text-xs font-semibold text-amber-700">Unsaved changes — the preview already shows them.</span> : null}
        </div>

        <section className={panelClassName}>
          <PanelHeader
            aside={areas.length ? `${areas.length} of ${JOB_POST_MAX_AREAS} ${areaScope}s · for this post only` : "For this post only"}
            step={4}
            title="Where you are hiring"
          />
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <CheckTile checked={areaScope === "area"} onChange={() => pickScope("area")}>
                <span className="text-sm font-semibold text-slate-800">Areas — one area is one rep</span>
              </CheckTile>
              <CheckTile checked={areaScope === "region"} onChange={() => pickScope("region")}>
                <span className="text-sm font-semibold text-slate-800">Regions — for a district manager</span>
              </CheckTile>
            </div>
            <p className="text-xs leading-relaxed text-slate-500">
              {areaScope === "area"
                ? "Optional. One area is one rep. With two or more areas, Download all gives the all-areas post and one post for each area."
                : "Optional. A district manager runs a whole region, so the post names the region rather than listing every area under it. With two or more regions, Download all gives the all-regions post and one post for each region."}
            </p>
            {areas.length ? (
              <div className="flex flex-wrap items-center gap-2">
                {areas.map((area) => (
                  <button
                    aria-label={`Remove ${area}`}
                    className={phxButtonGhostClassName}
                    key={area}
                    onClick={() => toggleArea(area, false)}
                    type="button"
                  >
                    {area} <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                ))}
                <button className="px-2 py-2 text-xs font-bold text-slate-500 hover:text-slate-800" onClick={() => setAreas([])} type="button">
                  Clear all
                </button>
              </div>
            ) : null}
            {atAreaLimit ? (
              <p className="text-xs font-semibold text-amber-700">
                A post lists at most {JOB_POST_MAX_AREAS} {areaScope}s. Remove one to add another.
              </p>
            ) : null}
            <FormField htmlFor="job-post-area-filter" label={areaScope === "area" ? "Find an area" : "Find a region"}>
              <input
                className={phxFieldClassName}
                id="job-post-area-filter"
                onChange={(e) => setAreaFilter(e.target.value)}
                placeholder="Type to narrow the list"
                value={areaFilter}
              />
            </FormField>
            <div className={`max-h-72 space-y-4 overflow-y-auto border border-slate-200 bg-slate-50 p-3 ${adminRecessedDepthClassName}`}>
              {areaScope === "region" ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {regionOptions
                    .filter((region) => !filter || region.toLowerCase().includes(filter))
                    .map((region) => (
                      <CheckTile checked={areas.includes(region)} key={region} onChange={(on) => toggleArea(region, on)}>
                        <span className="min-w-0 text-sm font-semibold text-slate-800">{region}</span>
                      </CheckTile>
                    ))}
                </div>
              ) : (
                areaGroups.map((group) => {
                const shownAreas = group.areas.filter((area) => !filter || area.toLowerCase().includes(filter));
                if (!shownAreas.length) return null;
                return (
                  <div key={group.label}>
                    <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{group.label}</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {shownAreas.map((area) => (
                        <CheckTile checked={areas.includes(area)} key={area} onChange={(on) => toggleArea(area, on)}>
                          <span className="min-w-0 text-sm font-semibold text-slate-800">{area}</span>
                        </CheckTile>
                      ))}
                    </div>
                  </div>
                );
                })
              )}
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
        <section className={panelClassName}>
          <PanelHeader aside={templateName?.name} step={5} title="Design" />
          {/* Six across only where the column is sticky: the strip is what the post's height is taken
              from. Stacked below xl the page simply scrolls, so the thumbs stay readable there. */}
          <div className="grid grid-cols-3 gap-2 p-3 xl:grid-cols-6">
            {JOB_POST_TEMPLATES.map((t, index) => (
              <CheckTile checked={template === t.key} key={t.key} name="job-post-template" onChange={() => setTemplate(t.key)} type="radio">
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {thumbHtml[index] ? (
                    <PostFrame html={thumbHtml[index]!} label={`${t.name} design`} onFit={(fit) => setFits((current) => ({ ...current, [t.key]: fit }))} />
                  ) : (
                    <span className="block aspect-[4/5] animate-pulse bg-slate-100" />
                  )}
                  <span className="text-xs font-bold leading-tight text-slate-800 xl:text-[10px]">{t.name}</span>
                  <FitBadge fit={fits[t.key]} />
                </span>
              </CheckTile>
            ))}
          </div>
        </section>

        <section className={panelClassName}>
          <PanelHeader aside={`${JOB_POST_WIDTH} × ${JOB_POST_HEIGHT} px · 4:5`} step={6} title="Preview and download" />
          <div className="space-y-3 p-4">
            <p className="text-xs font-semibold text-slate-500">{templateName?.description}</p>
            {areas.length > 1 ? (
              <div className="flex flex-wrap gap-2" role="tablist">
                {[null, ...areas].map((area) => (
                  <button
                    aria-selected={variant === area}
                    className={variant === area ? phxButtonPrimaryClassName : phxButtonGhostClassName}
                    key={area ?? "all"}
                    onClick={() => setPickedArea(area)}
                    role="tab"
                    type="button"
                  >
                    {area ?? (areaScope === "area" ? "All areas" : "All regions")}
                  </button>
                ))}
              </div>
            ) : null}
            {mainHtml ? (
              <div className={`border border-slate-200 bg-white p-2 ${adminSoftDepthClassName}`}>
                <PostFrame boxClassName="mx-auto w-full xl:h-[clamp(300px,calc(100vh-30rem),1350px)] xl:w-auto xl:max-w-full" html={mainHtml} label="Job post preview" onFit={setMainFit} />
              </div>
            ) : (
              <div className="mx-auto aspect-[4/5] w-full animate-pulse bg-slate-100 xl:h-[clamp(300px,calc(100vh-30rem),1350px)] xl:w-auto xl:max-w-full" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <FitBadge fit={mainFit} />
              {mainFit?.limited ? <span className="text-xs font-semibold text-red-700">{TOO_LONG_MESSAGE}</span> : null}
            </div>
            <FormError>{error}</FormError>
            {problems.length && !error ? <p className="text-xs font-semibold text-amber-700">{problems[0]}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button className={phxButtonAccentClassName} disabled={busy !== null || mainFit?.limited === true} onClick={() => download("png")} type="button">
                <Download aria-hidden className="h-4 w-4" /> {busy === "png" ? "Drawing…" : "Download picture"}
              </button>
              <button className={phxButtonGhostClassName} disabled={busy !== null || mainFit?.limited === true} onClick={() => download("pdf")} type="button">
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
                Download all gives {areas.length + 1} pictures — all {areaScope}s, then one for each {areaScope} — and one PDF with every page.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
