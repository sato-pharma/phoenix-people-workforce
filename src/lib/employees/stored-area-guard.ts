// An edit of an employee record must not empty the area of someone who holds a seat.
//
// WHAT HAPPENED, 3 NOVEMBER 2026. A District Sales Manager hired on 1 November had his area emptied
// by an edit of his own record two days later, and nothing recorded it. He carried the gap for ten
// nights: the nightly manager check reported it every night from 4 November and nobody could say
// where it came from. Two things made it possible, and this module is the answer to both.
//
//   1. THE FORM COULD NOT SHOW HIS AREA, AND COULD NOT GIVE IT BACK. Once a position or a title is
//      on the form, the Operating Area list offers OPEN VACANCIES only. His own seat is filled, so
//      the list held "No open vacancy for this position and line" and the box read empty although
//      the record held an area. Touching Job Position or Business Line then cleared the area for
//      real, and there was nothing in the list to pick it back from.
//   2. THE SAVE WROTE THE BLANK. `upsertEmployee` writes every column it is given, a blank as NULL.
//      `employees.area_id` must equal the seat (docs/eu-organogram-is-the-distribution-truth.md),
//      and a blank is not the seat's area.
//
// Both halves are pure so the form and the save can share them and a test can read them without a
// database. The seat read itself lives beside the save, in `employee-directory.ts`.

export type AreaPickerOption = {
  label: string;
  value: string;
};

/** What the record being edited already holds. */
export type StoredAreaOnRecord = {
  areaId: number | string | null | undefined;
  areaName: string | null | undefined;
  lineId: number | string | null | undefined;
};

/** The value the picker uses for a row that says "nothing to choose" and cannot be selected. */
export const AREA_PICKER_EMPTY_VALUE = "empty";

function idText(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** The label of the row that offers the area already on the record. */
export function storedAreaOptionLabel(areaName: string | null | undefined): string {
  const name = String(areaName ?? "").trim();
  return name ? `${name} · the area on this record` : "The area on this record";
}

/**
 * The Operating Area options for an EDIT: the open vacancies, with the area the record already
 * holds offered first.
 *
 * Without it the box shows nothing for a seated person and their area cannot be chosen again once
 * the form has cleared it. It is offered only while the business line is the one on the record: a
 * different line is a move to another seat, which is the transfer flow's job and not this list's.
 * When an open vacancy already names the same area the list is left as it is, so the area is never
 * offered twice. The "nothing to choose" row is dropped once there is something to choose.
 */
export function withStoredAreaOption(
  vacancyOptions: readonly AreaPickerOption[],
  stored: StoredAreaOnRecord | null | undefined,
  chosenLineId: number | string | null | undefined,
): AreaPickerOption[] {
  const options = [...vacancyOptions];
  const storedAreaId = idText(stored?.areaId);
  if (!storedAreaId) return options;

  const storedLineId = idText(stored?.lineId);
  const chosen = idText(chosenLineId);
  if (storedLineId && chosen && storedLineId !== chosen) return options;

  if (options.some((option) => idText(option.value) === storedAreaId)) return options;

  return [
    { label: storedAreaOptionLabel(stored?.areaName), value: storedAreaId },
    ...options.filter((option) => option.value !== AREA_PICKER_EMPTY_VALUE),
  ];
}

/** One save of an existing record, as far as its area is concerned. */
export type StoredAreaSave = {
  /** The area the record holds before this save. */
  storedAreaId: number | null;
  /** The area this save would write. */
  incomingAreaId: number | null;
  /**
   * Whether the person holds a seat in the organogram: `true`, `false`, or `null` when the seat
   * model could not be read. A failed read is never "holds no seat".
   */
  holdsSeat: boolean | null;
  storedAreaName: string | null;
  employeeName: string | null;
};

/**
 * Why this save is refused, or `null` when it may go ahead.
 *
 * Refused only when it would EMPTY an area the record holds, for someone who holds a seat or whose
 * seat could not be read. Changing one area for another is not this rule's business, and neither is
 * a person with no seat at all: head office staff hold none, and HR may clear an area they carry.
 *
 * The message says "required" on purpose: `app/api/employees/route.ts` answers such a message with
 * a 400 the form prints as it is, instead of a 500.
 */
export function blankedStoredAreaRefusal(save: StoredAreaSave): string | null {
  if (save.storedAreaId === null || save.incomingAreaId !== null) return null;
  if (save.holdsSeat === false) return null;

  const area = String(save.storedAreaName ?? "").trim() || "the area on record";
  const person = String(save.employeeName ?? "").trim() || "This employee";

  if (save.holdsSeat === true) {
    return (
      `Operating Area is required: ${person} holds a seat in the organogram and is on record in ${area}. `
      + `Choose ${area} under Operating Area and save again.`
    );
  }
  return (
    `Operating Area is required: this save would empty ${area}, and the organogram could not be read `
    + `to confirm ${person} holds no seat. Choose ${area} under Operating Area, or try again in a minute.`
  );
}
