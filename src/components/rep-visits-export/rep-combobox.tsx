"use client";

import * as React from "react";

import { phxSelectClassName } from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";

export type RepComboboxOption = { hrId: string; name: string; territory: string };

/**
 * The rep picker on the Rep visits export page, as a combobox you can type into (owner, 26 Nov 2026:
 * "make the 2 droplists combobox") — type part of a name or a territory and pick the rep.
 *
 * The page's forms are plain GET downloads, so exactly ONE field named `rep` may reach the URL, and it
 * must carry the rep's id. `SearchableSelect` names its typing box as well as its hidden value, and the
 * route reads the first `rep` it is given — the typed label. So the combobox is left unnamed and this
 * owns the one submitted field.
 *
 * That field is a real (not hidden, not read-only) input, laid invisibly along the combobox's bottom
 * edge: a hidden or read-only input is never checked by the browser, and the download must still stop
 * at "Choose a rep" when none is chosen, with the browser's own note under the field.
 */
export function RepCombobox({ name, options }: { name: string; options: RepComboboxOption[] }) {
  const [value, setValue] = React.useState("");
  return (
    <div className="relative">
      <SearchableSelect
        aria-label="Rep"
        className={phxSelectClassName}
        defaultValue=""
        maxResults={Math.max(options.length, 1)}
        noResultsText="No rep matches"
        placeholder="Type a name or a territory"
        onValueChange={setValue}
      >
        {options.map((option) => (
          <option key={option.hrId} value={option.hrId}>
            {option.name} · {option.territory}
          </option>
        ))}
      </SearchableSelect>
      <input
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-4 h-px w-px opacity-0"
        name={name}
        onChange={() => undefined}
        required
        tabIndex={-1}
        value={value}
      />
    </div>
  );
}
