"use client";

// Recruitment / ATS — choosing the manager, or MANAGERS, a CV goes to.
//
// WHY THIS IS NOT A `<select>` ANY MORE. Measured against production on 2026-08-31, the native
// dropdown this replaces rendered 30 people and **16 of them could not be told apart from their own
// label**:
//
//     Mina Farouk    · District Sales Manager · Cairo
//     Momen Shehata  · District Sales Manager · Cairo        <- a different line, same words
//     Mahmoud Eldaly · District Sales Manager · Giza
//     Sameh El Hoseiny · District Sales Manager · Giza
//     Taha Mohamed Taha · District Sales Manager · Giza      <- three Gizas, nothing to choose on
//     Ali Moh Ali    · National Sales Manager · Egypt
//     Amr Naguib     · National Sales Manager · Egypt        <- and the NSM is held once PER LINE
//
// The company runs one District Manager per line per region, so the LINE is the only discriminator
// there is — and the old label did not carry it. Three more read as a bare "District Sales Manager"
// with no territory at all, and because an empty string sorts first they sat at the very TOP of the
// list: the three least identifiable entries in the most prominent place.
//
// THE SHAPE IS THE OWNER'S, given 2026-08-31: "you will group by job title. Then you will group by
// line." So the heading is the title, the sub-heading is the line, and the row itself carries only
// the territory — the two facts above it are not repeated on every row, which is what lets seventeen
// District Managers read as three short lists of five or six.
//
// MULTI-SELECT, same instruction: "make me able to multiple select managers." One CV going to the
// Giza CNS District Manager *and* the National Sales Manager is a normal thing to want and used to
// mean sending twice.
//
// The panel itself is `GroupedComboBox`, shared with the position picker two rows above it on this
// same screen — that generalisation is the owner's rule that a thing said once applies everywhere it
// fits. This file is now only the part that is about MANAGERS: which fact is the heading, which is
// the sub-heading, and which is the line under the name.

import { UserRound } from "lucide-react";

import { GroupedComboBox, type ComboItem } from "@/components/ui/grouped-combobox";
import { managerSeatLabel } from "@/lib/recruitment/manager-grouping";

/**
 * What this picker needs to know about one manager.
 *
 * Structurally typed, exactly as `managerPickerLabel` is and for the same reason:
 * `HiringManagerOption` is declared in a module that reaches the service-role client, so naming the
 * type here would drag that module into this "use client" bundle and fail the build outright.
 */
export type ManagerPickerOption = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  seatTier: string | null;
  /** The folders on his shelf, when he holds any. */
  folders?: string[];
};

/** First of these that actually holds text. */
function firstText(...values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * What a row says under the name: the TERRITORY only.
 *
 * The title is the heading above it and the line is the sub-heading above that, so repeating either
 * on the row is noise printed seventeen times — and noise is exactly what made the old flat list
 * unreadable. On a District Manager the organogram carries no area and the seat is scoped by region,
 * so region is the fallback rather than a blank.
 */
function territoryOf(option: ManagerPickerOption): string | null {
  return firstText(option.areaName, option.regionName);
}

export function ManagerPicker({
  disabled = false,
  inputRef,
  multiple = false,
  onChange,
  options,
  panelId = "manager-picker-panel",
  placeholder = "Send to a manager…",
  value,
}: {
  disabled?: boolean;
  /** Focused by the `M` hotkey in the screening queue — the reason this takes a ref at all. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /**
   * Several managers at once, or one.
   *
   * ON in the screening queue, which is where the owner asked for it. OFF everywhere else, and
   * deliberately: the pool's per-row and bulk sends post ONE `managerHrId` per request, so offering
   * several there would mean looping the send — and on the bulk bar that is a dozen candidates times
   * a dozen managers of real notifications. The owner asked to generalise the GROUPING, not the
   * fan-out, and a picker that quietly multiplies how much mail leaves the building is not a
   * generalisation of anything.
   */
  multiple?: boolean;
  onChange: (hrIds: string[]) => void;
  options: ManagerPickerOption[];
  /** Unique per picker ON SCREEN — the pool can show a row's panel and the bulk bar's at once. */
  panelId?: string;
  placeholder?: string;
  /** The chosen managers' HR_IDs. Controlled — the caller owns this. */
  value: string[];
}) {
  const items: ComboItem[] = options.map((option) => ({
    group: firstText(option.jobTitle) ?? "Manager",
    id: option.hrId,
    name: option.name,
    // The HR_ID is searchable but never shown, per the standing rule that no raw code reaches a
    // person. A recruiter who has one in front of them can still find its owner.
    search: [option.regionName, option.areaName, option.hrId].filter(Boolean).join(" "),
    secondary: territoryOf(option),
    subgroup: option.lineName,
  }));

  return (
    <GroupedComboBox
      ariaLabel="Send this CV to a manager"
      disabled={disabled}
      emptyLabel="Nobody matches"
      hint="title · line · territory"
      inputRef={inputRef}
      items={items}
      leadingIcon={
        <UserRound className={value.length === 1 ? "h-3.5 w-3.5 shrink-0 text-orange-500" : "h-3.5 w-3.5 shrink-0 text-slate-400"} />
      }
      multiple={multiple}
      onChange={onChange}
      panelId={panelId}
      placeholder={placeholder}
      // The full seat beside the closed field, where there are no headings to carry it.
      selectedSuffix={(item) => {
        const option = options.find((candidate) => candidate.hrId === item.id);
        return option
          ? managerSeatLabel({
              areaName: option.areaName,
              jobTitle: option.jobTitle,
              lineName: option.lineName,
              regionName: option.regionName,
            })
          : null;
      }}
      summaryNoun="managers"
      value={value}
    />
  );
}
