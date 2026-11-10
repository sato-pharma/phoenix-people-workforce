"use client";

// The letter designer — the owner's "design anything, edit anything, colouring, designs, add,
// drop, delete, upload, edit, everything."
//
// HOW IT GIVES THAT WITHOUT A PAGE BUILDER. The letter is an ordered list of BLOCKS, and this
// screen edits that list: add a block, delete it, move it, retype anything inside it, recolour the
// whole document, change the typeface. The inputs are generated from `OFFER_BLOCK_DEFS`, so every
// block type is fully editable by construction — there is no hand-written form per type that
// somebody can forget to write.
//
// WHAT IS DELIBERATELY NOT HERE. A free contenteditable canvas. The same stored design has to
// render twice — once as a print-quality PDF (grid, flex, pt) and once as an email body (nested
// tables, because Outlook renders mail with Word's engine and implements neither grid nor flex).
// Arbitrary dragged-around HTML cannot be re-rendered into an email that survives Outlook; blocks
// can.
//
// TWO SHIPPED DESIGNS, ONE EDITOR. The classic letter and the executive one hold the SAME block
// list — they differ only in the skin the blocks are drawn in, chosen by the Design picker. That is
// why there is one editor and one preview rather than two of each, and why editing either design
// into something else still leaves it recognisably itself.
//
// Both can be edited freely and always restored, because the originals live in code rather than in
// rows — nothing done here can cost a design that cannot be retyped by hand.

import {
  ArrowDown,
  ArrowUp,
  Braces,
  Copy,
  Eye,
  FilePlus2,
  Layers,
  Loader2,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Star,
  Trash2,
  TriangleAlert,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import {
  OFFER_BLOCK_DEFS,
  OFFER_FONT_CHOICES,
  OFFER_THEME_FIELDS,
  offerBlockDef,
  type OfferFieldDef,
} from "@/lib/offers/block-schema";
import {
  OFFER_DEFAULT_FONT,
  OFFER_DEFAULT_FONT_SIZE_PT,
  OFFER_DEFAULT_THEME,
} from "@/lib/offers/default-template";
import { OfferRichText, type OfferTokenTarget } from "@/components/offers/offer-rich-text";
import {
  offerHintClassName,
  offerInputClassName,
  offerLabelClassName,
  offerTextareaClassName,
} from "@/components/offers/offer-ui";
import { OFFER_BUILTIN_TEMPLATES, offerBuiltinTemplate } from "@/lib/offers/builtin-templates";
import {
  OFFER_PLACEHOLDERS,
  OFFER_PLACEHOLDER_GROUPS,
  unknownOfferPlaceholders,
} from "@/lib/offers/placeholders";
import { buildOfferTokens } from "@/lib/offers/render";
import { cn } from "@/lib/utils";
import type {
  OfferBlock,
  OfferBlockType,
  OfferFields,
  OfferTemplate,
  OfferTemplateVariant,
  OfferTheme,
} from "@/lib/offers/types";

/**
 * The two skins, named for what they LOOK like rather than for their key.
 *
 * Read off `OFFER_BUILTIN_TEMPLATES` so a third shipped design appears here automatically — the
 * variant list and the built-in list are the same list, and keeping them in one place is what stops
 * a new design shipping with no way to select its skin.
 */
const OFFER_VARIANT_CHOICES: { label: string; value: OfferTemplateVariant }[] = OFFER_BUILTIN_TEMPLATES.map(
  (entry) => ({ label: entry.name, value: entry.variant }),
);

/** A believable letter, so the preview shows a real document rather than a grid of {{tokens}}. */
const SAMPLE: OfferFields = {
  candidateEmail: "candidate@example.com",
  candidateName: "SAMAA SHALABY",
  contractTerm: "One year, renewable",
  costOfLiving: 3500,
  dateOfIssue: "26 August 2026",
  reference: "SP-HR-DSM-2026-019",
  reportsTo: "National Sales Manager",
  // Blank on purpose, so the preview shows what a position with no wording of its own prints — the
  // role-neutral standard sentence. A sample paragraph typed here would hide the one case somebody
  // designing a letter most needs to see, because it is the case every brand-new job title is in.
  roleSummary: "",
  salutationName: "Dr SAMAA SHALABY",
  startDate: "1 September 2026",
  territory: "Delta 3",
  title: "District Sales Manager",
  totalMonthly: 30000,
  validUntil: "2 September 2026",
};

/**
 * What each placeholder will actually print, produced by the SAME function that fills a real letter.
 *
 * Deliberately not a hand-typed illustration beside each catalogue entry. A picker that promised
 * "30,000" while the letter printed "30000" would be teaching the wrong thing about a document
 * somebody signs, and nothing would ever catch the divergence. Running the real builder means the
 * example beside `{{basicMonthly}}` is the value, not a description of it.
 */
const SAMPLE_TOKENS = buildOfferTokens(SAMPLE);

let localSeq = 0;
function newBlockId(type: string) {
  localSeq += 1;
  return `${type}-new-${localSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

export function OfferTemplateDesigner({
  canDelete,
  canManage,
  onReport,
  onTemplates,
  templates,
}: {
  /**
   * Separate from `canManage` because the two are genuinely different grants: HR Advisory
   * holds `offers:read/create/update/export` but NOT `offers:delete`, so she can build and edit a
   * template and cannot remove one. Showing an enabled Delete that answers 403 is worse than
   * showing a disabled one — the route is the gate either way, this only stops the dead click.
   */
  canDelete: boolean;
  canManage: boolean;
  onReport: (message: string | null, kind: "error" | "success") => void;
  onTemplates: (templates: OfferTemplate[]) => void;
  templates: OfferTemplate[];
}) {
  const [activeId, setActiveId] = useState<string>(
    templates.find((t) => t.isDefault)?.id ?? templates[0]?.id ?? "",
  );
  const active = templates.find((t) => t.id === activeId) ?? templates[0] ?? null;
  const activeBuiltin = active?.builtinKey ? offerBuiltinTemplate(active.builtinKey) : null;

  const [name, setName] = useState(active?.name ?? "");
  const [blocks, setBlocks] = useState<OfferBlock[]>(active?.blocks ?? []);
  const [theme, setTheme] = useState<OfferTheme>(active?.theme ?? {});
  const [font, setFont] = useState(active?.fontFamily ?? OFFER_DEFAULT_FONT);
  const [fontSize, setFontSize] = useState(active?.fontSizePt ?? OFFER_DEFAULT_FONT_SIZE_PT);
  const [variant, setVariant] = useState<OfferTemplateVariant>(active?.variant ?? "classic");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [showPlaceholders, setShowPlaceholders] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The box a clicked placeholder gets dropped into.
   *
   * A ref rather than state, because clicking a placeholder BLURS the box first — by the time the
   * click handler runs, `document.activeElement` is the placeholder button itself. The ref still
   * holds the box that had the caret a moment earlier, which is the one the person means. It also
   * must not trigger a re-render: re-rendering on every focus would rebuild the field being typed
   * into.
   *
   * It carries an `insert` closure rather than the element and a setter, because a plain box and
   * the prose canvas write a placeholder in genuinely different ways — one splices a string at
   * `selectionStart`, the other inserts a chip at a DOM range. Both are still one click.
   */
  const lastField = useRef<OfferTokenTarget | null>(null);

  // Switching template loads its design. Everything unsaved on the previous one is discarded, and
  // the Save button says so — an autosave here would write half-finished edits to a letter that
  // might be sent five minutes later.
  const loadTemplate = useCallback((template: OfferTemplate) => {
    setActiveId(template.id);
    setName(template.name);
    setBlocks(template.blocks);
    setTheme(template.theme);
    setFont(template.fontFamily);
    setFontSize(template.fontSizePt);
    setVariant(template.variant);
    setSelected(null);
  }, []);

  const refreshPreview = useCallback(async () => {
    try {
      const response = await fetch("/api/offers/preview", {
        body: JSON.stringify({ blocks, fields: SAMPLE, fontFamily: font, fontSizePt: fontSize, theme, variant }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { html?: string; message?: string };
      if (!response.ok) throw new Error(payload.message || "The preview could not be rendered.");
      setPreviewHtml(payload.html ?? "");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "The preview could not be rendered.", "error");
    }
  }, [blocks, font, fontSize, onReport, theme, variant]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refreshPreview(), 450);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refreshPreview]);

  async function call(url: string, method: string, body?: unknown) {
    const response = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      message?: string;
      success?: boolean;
    };
    if (!response.ok || payload.success === false) throw new Error(payload.message || "That did not work.");
    return payload;
  }

  async function save() {
    if (!active) return;
    setBusy("save");
    try {
      const payload = await call(`/api/offers/templates/${active.id}`, "PATCH", {
        blocks,
        fontFamily: font,
        fontSizePt: fontSize,
        name,
        theme,
        variant,
      });
      const saved = payload.template as OfferTemplate;
      onTemplates(templates.map((t) => (t.id === saved.id ? saved : t)));
      onReport(`"${saved.name}" saved.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not save this template.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function createTemplate(mode: "blank" | "copy") {
    setBusy("create");
    try {
      const payload = await call("/api/offers/templates", "POST", {
        blocks: mode === "copy" ? blocks : [],
        fontFamily: mode === "copy" ? font : OFFER_DEFAULT_FONT,
        fontSizePt: mode === "copy" ? fontSize : OFFER_DEFAULT_FONT_SIZE_PT,
        name: mode === "copy" ? `${name} (copy)` : "Untitled template",
        theme: mode === "copy" ? theme : {},
        variant: mode === "copy" ? variant : "classic",
      });
      const created = payload.template as OfferTemplate;
      onTemplates([...templates, created]);
      loadTemplate(created);
      onReport(
        mode === "copy"
          ? `Copied to "${created.name}". Editing it will not touch the original.`
          : "Blank template created. Add blocks to build the letter.",
        "success",
      );
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not create a template.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function removeTemplate() {
    if (!active) return;
    setBusy("delete");
    try {
      await call(`/api/offers/templates/${active.id}`, "DELETE");
      const remaining = templates.filter((t) => t.id !== active.id);
      onTemplates(remaining);
      if (remaining[0]) loadTemplate(remaining[0]);
      onReport(`"${active.name}" deleted.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not delete this template.", "error");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Put the built-in currently being edited back as it shipped.
   *
   * Scoped to the ACTIVE template, not to "the default" — with two shipped designs, one Restore
   * button that always rebuilt the classic letter would be a trap: you would edit the executive
   * design into a mess, press Restore, and watch a different template change instead.
   */
  async function restoreBuiltin() {
    if (!active?.builtinKey) return;
    setBusy("restore");
    try {
      const payload = await call("/api/offers/templates/restore-default", "POST", { key: active.builtinKey });
      const restored = payload.template as OfferTemplate;
      onTemplates(templates.map((t) => (t.id === restored.id ? restored : t)));
      loadTemplate(restored);
      onReport(`"${restored.name}" has been restored to the design as it shipped.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not restore this design.", "error");
    } finally {
      setBusy(null);
    }
  }

  /** Point every NEW offer at this template. Exactly one row carries it, so this moves the flag. */
  async function makeDefault() {
    if (!active || active.isDefault) return;
    setBusy("default");
    try {
      const payload = await call(`/api/offers/templates/${active.id}`, "PATCH", { isDefault: true });
      const updated = payload.template as OfferTemplate;
      onTemplates(
        templates.map((t) => (t.id === updated.id ? updated : t.isDefault ? { ...t, isDefault: false } : t)),
      );
      onReport(`New offers will now open on "${updated.name}".`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not change the default.", "error");
    } finally {
      setBusy(null);
    }
  }

  // ── block editing ──────────────────────────────────────────────────────────────────────────
  function patchBlock(id: string, props: Record<string, unknown>) {
    setBlocks((current) => current.map((b) => (b.id === id ? { ...b, props: { ...b.props, ...props } } : b)));
  }

  function addBlock(type: OfferBlockType) {
    const def = offerBlockDef(type);
    const props: Record<string, unknown> = {};
    for (const field of def.fields) props[field.key] = "";
    for (const list of def.lists) props[list.key] = [{ ...list.blank }];
    setBlocks((current) => [...current, { id: newBlockId(type), props, type }]);
  }

  function move(id: string, delta: number) {
    setBlocks((current) => {
      const index = current.findIndex((b) => b.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  const selectedBlock = useMemo(() => blocks.find((b) => b.id === selected) ?? null, [blocks, selected]);

  /**
   * Tokens written into this letter that no offer will ever fill in.
   *
   * `fillOfferTokens` leaves an unknown token STANDING rather than blanking it, so a mistyped
   * `{{reprotsTo}}` prints as those literal characters on a legally binding letter. That is the
   * right call — a visible hole beats a silent one — but it only helps if somebody looks before the
   * letter is sent. This is what makes somebody look, at editing time.
   */
  const unknownTokens = useMemo(() => unknownOfferPlaceholders(blocks), [blocks]);

  /**
   * Drop `{{key}}` into the box that last had the caret, at the caret.
   *
   * Falls back to the clipboard when there is no live box to write into — nothing focused yet, or
   * the block holding it has since been deselected or deleted. Silently doing nothing would read as
   * a broken button.
   */
  const insertPlaceholder = useCallback(
    async (key: string) => {
      const token = `{{${key}}}`;
      const target = lastField.current;
      // `isConnected` is the check that matters: selecting a different block or deleting a list row
      // unmounts the element while the ref still points at it. Writing into a detached node updates
      // nothing and looks exactly like a dead click.
      if (!canManage || !target || !target.element.isConnected) {
        try {
          await navigator.clipboard.writeText(token);
          onReport(`${token} copied. Click into a box in the letter and paste it.`, "success");
        } catch {
          onReport(`Click into a box in the letter first, then click ${token}.`, "error");
        }
        return;
      }
      target.insert(token);
    },
    [canManage, onReport],
  );

  function renderField(block: OfferBlock, field: OfferFieldDef, value: unknown, onChange: (v: unknown) => void) {
    const id = `${block.id}-${field.key}`;
    if (field.kind === "toggle") {
      return (
        <label className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-slate-700" htmlFor={id}>
          <input
            checked={Boolean(value)}
            className="h-4 w-4 rounded border-phx-line"
            disabled={!canManage}
            id={id}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          {field.label}
        </label>
      );
    }
    /**
     * Splice `{{token}}` into a plain box at the caret, then put the caret back.
     *
     * React rewrites the value on the next render and the caret jumps to the end with it, so
     * without the restore a second placeholder lands at the end of the box rather than beside the
     * first — and typing carries on from the wrong place.
     */
    const spliceToken = (element: HTMLInputElement | HTMLTextAreaElement) => (token: string) => {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      onChange(`${element.value.slice(0, start)}${token}${element.value.slice(end)}`);
      const caret = start + token.length;
      requestAnimationFrame(() => {
        if (!element.isConnected) return;
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    };

    const label = (
      <label className={offerLabelClassName} htmlFor={field.kind === "prose" ? undefined : id}>
        {field.label}
      </label>
    );

    // The letter's own writing, on a canvas that looks like the page. Everything else on this
    // screen is a label or a value; this is the only field that is a document.
    if (field.kind === "prose") {
      return (
        <div className="md:col-span-2" key={field.key}>
          {label}
          <OfferRichText
            canManage={canManage}
            onChange={(html) => onChange(html)}
            onFocusProse={(target) => {
              lastField.current = target;
            }}
            value={String(value ?? "")}
          />
          {field.hint ? <p className={offerHintClassName}>{field.hint}</p> : null}
        </div>
      );
    }

    const multiline = field.kind === "textarea" || field.kind === "html";
    return (
      <div key={field.key}>
        {label}
        {multiline ? (
          <textarea
            className={offerTextareaClassName}
            disabled={!canManage}
            id={id}
            onChange={(event) => onChange(event.target.value)}
            onFocus={(event) => {
              const element = event.currentTarget;
              lastField.current = { element, insert: spliceToken(element) };
            }}
            rows={field.kind === "html" ? 8 : 3}
            value={String(value ?? "")}
          />
        ) : (
          <input
            className={offerInputClassName}
            disabled={!canManage}
            id={id}
            onChange={(event) => onChange(event.target.value)}
            onFocus={(event) => {
              const element = event.currentTarget;
              lastField.current = { element, insert: spliceToken(element) };
            }}
            value={String(value ?? "")}
          />
        )}
        {field.hint ? <p className={offerHintClassName}>{field.hint}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminTableShell
        action={
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canManage || busy !== null} onClick={() => void createTemplate("blank")} size="sm" type="button" variant="secondary">
              <FilePlus2 className="h-3.5 w-3.5" /> Build from scratch
            </Button>
            <Button disabled={!canManage || busy !== null} onClick={() => void createTemplate("copy")} size="sm" type="button" variant="secondary">
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </Button>
            <Button
              disabled={!canManage || busy !== null || active?.isDefault !== false}
              onClick={() => void makeDefault()}
              size="sm"
              type="button"
              variant="secondary"
            >
              <Star className="h-3.5 w-3.5" /> Use for new offers
            </Button>
            <Button
              disabled={!canManage || busy !== null || !active?.builtinKey}
              onClick={() => void restoreBuiltin()}
              size="sm"
              type="button"
              variant="secondary"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {active?.builtinKey ? `Restore ${active.name}` : "Restore built-in"}
            </Button>
            <Button
              // A built-in is never deletable — Restore is the button for "I have made a mess of
              // this one" — and neither is whichever template new offers currently open on.
              disabled={!canDelete || busy !== null || !active || active.builtinKey !== null || active.isDefault}
              onClick={() => void removeTemplate()}
              size="sm"
              type="button"
              variant="destructive"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
            <Button disabled={!canManage || busy !== null || !active} onClick={() => void save()} size="sm" type="button">
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save template
            </Button>
          </div>
        }
        description="Four SATO designs ship with Phoenix. All are fully editable and each can always be restored to how it shipped. Build a new one from scratch, or duplicate one and edit the copy. There is no filter by position here, and there does not need to be one: a design is a LOOK, and what the letter SAYS about a particular job — the paragraph after the greeting — is written per job title on the Job titles tab and reaches every design as {{roleSummary}}. So one design serves every position, and a position's own words never travel into anybody else's letter."
        title="Templates"
      >
        <div className="grid gap-4 px-5 py-5 sm:px-6 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className={offerLabelClassName} htmlFor="template-picker">Editing</label>
            <select
              className={offerInputClassName}
              id="template-picker"
              onChange={(event) => {
                const found = templates.find((t) => t.id === event.target.value);
                if (found) loadTemplate(found);
              }}
              value={active?.id ?? ""}
            >
              {templates.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.isDefault ? " (new offers)" : ""}
                  {entry.builtinKey ? " · built-in" : ""}
                </option>
              ))}
            </select>
            <p className={offerHintClassName}>
              {activeBuiltin ? activeBuiltin.description : "Unsaved changes are lost when you switch."}
            </p>
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="template-variant">
              <Layers className="mr-1 inline h-3 w-3" /> Design
            </label>
            <select
              className={offerInputClassName}
              disabled={!canManage}
              id="template-variant"
              onChange={(event) => setVariant(event.target.value as OfferTemplateVariant)}
              value={variant}
            >
              {OFFER_VARIANT_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
            <p className={offerHintClassName}>The skin. The same blocks, drawn two different ways.</p>
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="template-name">Template name</label>
            <input
              className={offerInputClassName}
              disabled={!canManage}
              id="template-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="template-font">
              <Type className="mr-1 inline h-3 w-3" /> Typeface
            </label>
            <select
              className={offerInputClassName}
              disabled={!canManage}
              id="template-font"
              onChange={(event) => setFont(event.target.value)}
              value={font}
            >
              {OFFER_FONT_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="template-size">Base size (pt)</label>
            <input
              className={cn(offerInputClassName, "tabular-nums")}
              disabled={!canManage}
              id="template-size"
              max={24}
              min={5}
              onChange={(event) => setFontSize(Number(event.target.value))}
              step={0.1}
              type="number"
              value={fontSize}
            />
            <p className={offerHintClassName}>Everything else scales from this.</p>
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Twelve tokens drive every colour in the letter. Clear one to fall back to the SATO default."
        title="Colours"
      >
        <div className="grid gap-3 px-5 py-5 sm:px-6 sm:grid-cols-3 xl:grid-cols-6">
          {OFFER_THEME_FIELDS.map((token) => {
            const value = (theme as Record<string, string>)[token.key] ?? (OFFER_DEFAULT_THEME as Record<string, string>)[token.key] ?? "#000000";
            return (
              <div key={token.key}>
                <label className={offerLabelClassName} htmlFor={`theme-${token.key}`}>
                  <Palette className="mr-1 inline h-3 w-3" />
                  {token.label}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-phx-line bg-white p-1"
                    disabled={!canManage}
                    id={`theme-${token.key}`}
                    onChange={(event) => setTheme((current) => ({ ...current, [token.key]: event.target.value }))}
                    type="color"
                    value={value}
                  />
                  <input
                    aria-label={`${token.label} hex`}
                    className={cn(offerInputClassName, "font-mono text-xs")}
                    disabled={!canManage}
                    onChange={(event) => setTheme((current) => ({ ...current, [token.key]: event.target.value }))}
                    value={value}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={
          <Button onClick={() => setShowPlaceholders((open) => !open)} size="sm" type="button" variant="secondary">
            <Braces className="h-3.5 w-3.5" /> {showPlaceholders ? "Hide the list" : "Show the list"}
          </Button>
        }
        description="A placeholder is a blank the offer fills in when it is sent. Click into any box in the letter below, then click a placeholder here to drop it in at the cursor. The grey figure beside each one is what it prints for a sample offer."
        title="Placeholders"
      >
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
          {unknownTokens.length > 0 ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-amber-900">
                  {unknownTokens.length === 1
                    ? "This letter uses a placeholder that no offer can fill in."
                    : `This letter uses ${unknownTokens.length} placeholders that no offer can fill in.`}
                </p>
                <p className="mt-1 font-mono text-phx-sm font-bold text-amber-900">
                  {unknownTokens.map((key) => `{{${key}}}`).join("   ")}
                </p>
                <p className="mt-1 text-phx-sm text-amber-800">
                  They print on the letter exactly as written, braces and all. Usually a misspelling
                  — check each one against the list below.
                </p>
              </div>
            </div>
          ) : null}

          {showPlaceholders ? (
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {OFFER_PLACEHOLDER_GROUPS.map((group) => (
                <div key={group}>
                  <p className={offerLabelClassName}>{group}</p>
                  <div className="flex flex-col gap-0.5">
                    {OFFER_PLACEHOLDERS.filter((placeholder) => placeholder.group === group).map(
                      (placeholder) => (
                        <button
                          className="rounded-lg border border-transparent px-2 py-1 text-left transition hover:border-phx-line hover:bg-slate-50"
                          key={placeholder.key}
                          onClick={() => void insertPlaceholder(placeholder.key)}
                          title={placeholder.note}
                          type="button"
                        >
                          <span className="block whitespace-nowrap font-mono text-phx-sm font-bold text-[#B45309]">
                            {`{{${placeholder.key}}}`}
                          </span>
                          <span className="block break-words text-phx-xs text-phx-ink-faint">
                            {placeholder.label}
                            {SAMPLE_TOKENS[placeholder.key] ? ` · ${SAMPLE_TOKENS[placeholder.key]}` : ""}
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </AdminTableShell>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <AdminTableShell description="Click a block to edit it. Move it, delete it, or add another below." title="Blocks">
          <div className="flex flex-col gap-2 px-5 py-5 sm:px-6">
            {blocks.map((block, index) => {
              const def = offerBlockDef(block.type);
              const isSelected = block.id === selected;
              return (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-xl border px-3 py-2 transition",
                    isSelected ? "border-phx-accent-line bg-orange-50/60 shadow-sm" : "border-phx-line bg-white hover:bg-slate-50",
                  )}
                  key={block.id}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setSelected(isSelected ? null : block.id)}
                    type="button"
                  >
                    <span className="block whitespace-nowrap text-sm font-bold text-slate-900">{def.label}</span>
                    <span className="block break-words text-phx-xs text-phx-ink-faint">
                      {index + 1} of {blocks.length}
                    </span>
                  </button>
                  <Button disabled={!canManage || index === 0} onClick={() => move(block.id, -1)} size="icon-sm" type="button" variant="ghost">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    disabled={!canManage || index === blocks.length - 1}
                    onClick={() => move(block.id, 1)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    disabled={!canManage}
                    onClick={() => {
                      setBlocks((current) => current.filter((b) => b.id !== block.id));
                      if (selected === block.id) setSelected(null);
                    }}
                    size="icon-sm"
                    type="button"
                    variant="destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
            {blocks.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">Empty template. Add the first block below.</p>
            ) : null}

            <div className="mt-3 border-t border-slate-200/80 pt-4">
              <p className={offerLabelClassName}>Add a block</p>
              <div className="flex flex-wrap gap-2">
                {OFFER_BLOCK_DEFS.map((def) => (
                  <Button
                    disabled={!canManage}
                    key={def.type}
                    onClick={() => addBlock(def.type)}
                    size="sm"
                    title={def.description}
                    type="button"
                    variant="secondary"
                  >
                    <Plus className="h-3 w-3" /> {def.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </AdminTableShell>

        <AdminTableShell
          action={
            <Button onClick={() => void refreshPreview()} size="sm" type="button" variant="secondary">
              <Eye className="h-3.5 w-3.5" /> Refresh
            </Button>
          }
          description={
            selectedBlock
              ? offerBlockDef(selectedBlock.type).description
              : "Rendered by the same code that produces the PDF, with a sample offer filled in."
          }
          title={selectedBlock ? offerBlockDef(selectedBlock.type).label : "Preview"}
        >
          {selectedBlock ? (
            <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
              {offerBlockDef(selectedBlock.type).fields.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {offerBlockDef(selectedBlock.type).fields.map((field) =>
                    renderField(selectedBlock, field, selectedBlock.props[field.key], (value) =>
                      patchBlock(selectedBlock.id, { [field.key]: value }),
                    ),
                  )}
                </div>
              ) : null}

              {offerBlockDef(selectedBlock.type).lists.map((list) => {
                const rows = Array.isArray(selectedBlock.props[list.key])
                  ? (selectedBlock.props[list.key] as Record<string, unknown>[])
                  : [];
                const write = (next: Record<string, unknown>[]) => patchBlock(selectedBlock.id, { [list.key]: next });

                return (
                  <div key={list.key}>
                    <p className={offerLabelClassName}>{list.label}</p>
                    <div className="flex flex-col gap-3">
                      {rows.map((row, rowIndex) => (
                        <div className="rounded-xl border border-phx-line bg-slate-50/60 p-3" key={`${list.key}-${rowIndex}`}>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
                              {list.itemLabel} {rowIndex + 1}
                            </span>
                            <div className="flex gap-1">
                              <Button
                                disabled={!canManage || rowIndex === 0}
                                onClick={() => {
                                  const next = [...rows];
                                  [next[rowIndex - 1], next[rowIndex]] = [next[rowIndex], next[rowIndex - 1]];
                                  write(next);
                                }}
                                size="icon-xs"
                                type="button"
                                variant="ghost"
                              >
                                <ArrowUp className="h-3 w-3" />
                              </Button>
                              <Button
                                disabled={!canManage || rowIndex === rows.length - 1}
                                onClick={() => {
                                  const next = [...rows];
                                  [next[rowIndex + 1], next[rowIndex]] = [next[rowIndex], next[rowIndex + 1]];
                                  write(next);
                                }}
                                size="icon-xs"
                                type="button"
                                variant="ghost"
                              >
                                <ArrowDown className="h-3 w-3" />
                              </Button>
                              <Button
                                disabled={!canManage}
                                onClick={() => write(rows.filter((_, i) => i !== rowIndex))}
                                size="icon-xs"
                                type="button"
                                variant="destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            {list.fields.map((field) =>
                              renderField(selectedBlock, field, row[field.key], (value) => {
                                const next = [...rows];
                                next[rowIndex] = { ...next[rowIndex], [field.key]: value };
                                write(next);
                              }),
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <Button
                      className="mt-3"
                      disabled={!canManage}
                      onClick={() => write([...rows, { ...list.blank }])}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      <Plus className="h-3 w-3" /> Add {list.itemLabel.toLowerCase()}
                    </Button>
                  </div>
                );
              })}

              <Button onClick={() => setSelected(null)} size="sm" type="button" variant="ghost">
                Done — back to the preview
              </Button>
            </div>
          ) : (
            <div className="max-h-[760px] overflow-auto bg-slate-100 p-4">
              {previewHtml ? (
                <iframe
                  className="mx-auto block w-full max-w-[860px] rounded-xl border border-phx-line bg-white shadow-lg"
                  height={940}
                  sandbox=""
                  srcDoc={previewHtml}
                  title="Template preview"
                />
              ) : (
                <p className="py-10 text-center text-sm text-slate-500">Add a block to see the letter.</p>
              )}
            </div>
          )}
        </AdminTableShell>
      </div>
    </div>
  );
}
