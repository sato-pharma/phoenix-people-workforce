// What every screen and export must CALL a distributor profile's `bonusColumns` field.
//
// The engine reads that field as a FREE-GOODS FLAG, never as a quantity: a row whose cell holds
// anything other than 0 or false is skipped WHOLE (engine.ts, the bonus/free-goods check). That suits
// EPDA's `is_bonus`, which marks a line whose only quantity IS the free goods. A bonus COUNT printed
// beside the paid units, like El Qema's, must never be mapped there: a bonus of 1 reads exactly like
// the flag, and the line's paid units are dropped with it (#4028). Owner, 2026-09-07, restated
// 2026-09-18: no distributor's bonus is ever counted, and paid units always import.
//
// Every surface used to label this field "Bonus Qty" or "B. Qty", which invites exactly that mapping.
// A saved in-app mapping WHOLLY replaces the built-in one for that distributor, so one wrong entry in
// the editor brings the row-drop back with no warning. The labels now say what the field does, and the
// editor shows the warning under the input.
//
// These strings are for display only. The field key (`bonusColumns`), the DB column (`bonus_columns`)
// and the grid key (`bonus`) are unchanged, and nothing reads a label back as a key. This file must stay
// safe for the client bundle because the editor imports it.

export const FREE_GOODS_FLAG_LABEL = "Free-goods flag (whole row skipped)";

// For the Database Validation grid, whose headers stay one line. Its description gives the rest.
export const FREE_GOODS_FLAG_SHORT_LABEL = "Free-goods flag";

export const FREE_GOODS_FLAG_HINT =
  "Only a column that marks a whole line as free goods, such as “is_bonus”. Any value other than 0 or false skips the entire row, paid units included. Never map a bonus count here: bonus is never counted, and paid units must always import.";

// The master workbook's Distributor_Template_Rules notes cell.
export function freeGoodsFlagNote(column: string): string {
  return `Free-goods flag col = "${column}" (a flagged row is skipped whole; never a bonus count)`;
}
