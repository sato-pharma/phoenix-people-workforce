"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { phxLabelClassName } from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";

type Option = { readonly key: string; readonly name: string };

/**
 * The one control on the page: type a name from the sheets, pick it, and the page re-renders on the
 * server with that person's sheet. The choice lives in the address (?person=), so a refresh or the
 * back button keeps it, and the scan itself never travels until a name is chosen.
 */
export function TrainingEvidenceSearch({ options, selectedKey }: { options: readonly Option[]; selectedKey: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="block">
      <span className={phxLabelClassName}>Attendee name</span>
      <SearchableSelect
        value={selectedKey}
        placeholder="Type a name from the training sheets"
        noResultsText="No one by that name on the sheets"
        maxResults={options.length + 1}
        onValueChange={(key) => {
          startTransition(() => {
            router.push(key ? `/employee-portals/pv-training-evidence?person=${encodeURIComponent(key)}` : "/employee-portals/pv-training-evidence");
          });
        }}
        aria-busy={pending}
      >
        <option value="">Type a name from the training sheets</option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.name}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}
