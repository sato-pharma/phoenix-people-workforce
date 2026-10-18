"use client";

// Recruitment / ATS — the select that chooses which of a manager's folders a CV is filed in.
// What it offers, and when, is decided by the pure `foldersToOffer` in lib/recruitment/folder-choice.ts.
// It is an OVERRIDE: left on its first option, nothing about a send changes.
//
// It wears the one form design: the micro-caps label and the house select, both from form-tokens,
// with a folder mark beside the label so it reads as "where this lands" at a glance.

import { FolderOpen } from "lucide-react";

import { phxLabelTextClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { AUTOMATIC_FOLDER } from "@/lib/recruitment/folder-choice";
import { cn } from "@/lib/utils";

export function FolderChoice({
  disabled = false,
  folders,
  onChange,
  value,
}: {
  disabled?: boolean;
  folders: readonly string[];
  onChange: (folder: string) => void;
  /** The chosen folder, or "" to let the system file it. A value no longer on the shelf reads as "". */
  value: string;
}) {
  if (folders.length === 0) return null;
  const chosen = folders.includes(value) ? value : AUTOMATIC_FOLDER;
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className={`inline-flex items-center gap-1.5 ${phxLabelTextClassName}`}>
        <FolderOpen aria-hidden className="h-3.5 w-3.5 text-orange-600" />
        Folder
      </span>
      <select
        aria-label="Folder on the manager's shelf"
        className={cn(phxSelectClassName, "w-full")}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={chosen}
      >
        <option value={AUTOMATIC_FOLDER}>Choose the folder for me</option>
        {folders.map((folder) => (
          <option key={folder} value={folder}>
            {folder}
          </option>
        ))}
      </select>
    </label>
  );
}
