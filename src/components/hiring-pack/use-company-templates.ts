// The uploaded company templates, read once and shared by everything on the HR Forms screen.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS MOVED OUT OF THE STUDIO. It used to be state inside `TemplateStudio`, loaded the first
// time somebody opened that panel. That was right while the Studio was the only place a company
// template appeared. It stopped being right the moment an uploaded paper had to sit in the package
// tab beside the built-in documents it belongs with — a template filed under "New hires package"
// has to be listed there whether or not anybody has opened the Studio today.
//
// The alternatives were both worse. Two components fetching the same endpoint means two lists that
// can disagree after an upload, and the disagreement is invisible: one screen shows the new paper
// and the other does not. Passing the whole thing down from the page above means the page owns a
// list it does not itself use. A hook is the honest shape — one fetch, one refresh, and whoever
// needs the answer asks for it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHO MAY ADD ONE IS ANSWERED BY THE SERVER, not by a prop. The list request already resolves the
// access context to read the templates, so it says so in the same reply. That keeps the one
// authority on "can this person change what the company prints" on the server, where the POST
// enforces it anyway.

"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  CustomTemplateGroup,
  CustomTemplatePrintSides,
} from "@/lib/hiring-pack/custom-templates";

export type StoredTemplatePage = {
  id: string;
  pageIndex: number;
  contentType: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
};

export type StoredTemplate = {
  id: string;
  key: string;
  document: string;
  name: string;
  nameAr: string | null;
  pageWidthPt: number;
  pageHeightPt: number;
  group: CustomTemplateGroup;
  status: "current" | "archived";
  version: number;
  effectiveFrom: string;
  note: string | null;
  printableByRoles: string[] | null;
  /** How many copies this prints when nobody types a different number. The print route acts on it. */
  defaultCopies: number;
  /** Whether it prints back-to-back. Shown to the operator; no browser can set a printer duplex. */
  printSides: CustomTemplatePrintSides;
  createdAt: string;
  pages: StoredTemplatePage[];
};

export type CompanyTemplates = {
  templates: StoredTemplate[];
  /** Whether this viewer may upload or replace one. The server's answer, not a guess from the role. */
  canManage: boolean;
  /** False until the first reply has landed — which is not the same as "there are none". */
  loaded: boolean;
  error: string | null;
  /** Read the list again. Called after an upload, so every screen showing it updates together. */
  reload: () => Promise<void>;
};

/**
 * Each template's name under BOTH spellings of its identity.
 *
 * `documentLabel` accepts either, and the call sites split on which one they happen to hold: a row
 * carries the bare key, while a document is `custom:<uuid>`. Writing both costs one line and
 * removes the question from every reader.
 */
export function templateNamesOf(templates: readonly StoredTemplate[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const template of templates) {
    names[template.key] = template.name;
    names[template.document] = template.name;
  }
  return names;
}

export function useCompanyTemplates(): CompanyTemplates {
  const [templates, setTemplates] = useState<StoredTemplate[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/hiring-pack/custom-templates", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | { canManage?: boolean; message?: string; templates?: StoredTemplate[] }
        | null;
      if (!response.ok) {
        throw new Error(body?.message ?? `Could not read the templates (${response.status}).`);
      }
      setTemplates(body?.templates ?? []);
      setCanManage(body?.canManage === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the templates.");
    } finally {
      setLoaded(true);
    }
  }, []);

  /**
   * EVERY setState IS INSIDE THE PROMISE, never in the effect body.
   *
   * `react-hooks/set-state-in-effect` is a lint ERROR in this repository rather than a warning, and
   * the rule is right: state written during an effect is a second render nobody asked for. `reload`
   * is a `useCallback` with no dependencies, so this runs once per mount and not once per render.
   */
  useEffect(() => {
    void reload();
  }, [reload]);

  return { canManage, error, loaded, reload, templates };
}
