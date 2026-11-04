// A second template of a distributor — the names the screens offer, and the distributor they mean.
//
// Owner, 2026-11-04, on EPDA's October 2026 books: "call this epda pharmacies 2 and epda bulk 2 if i
// used normal templete or this temeplete in either way sales disrb is ebda pharmacies or bulk". So a
// template is a choice on a screen and never a source of sales: its code is not stored anywhere, and
// every screen swaps it for the real distributor before it posts. The sheet's own columns decide which
// layout is read (engine.ts, profileForWorkbook).
//
// Deliberately its own module with no heavy imports, for the same reason as phoenix-template-code.ts:
// the pickers are client components and must not pull the engine or ExcelJS into the browser bundle.

import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

export const SECOND_TEMPLATES: ReadonlyArray<{ code: string; name: string; distributorCode: string }> = [
  { code: "EP-BK-2", name: "EPDA Bulk 2", distributorCode: "EP-BK" },
  { code: "EP-PHS-2", name: "EPDA Pharmacies 2", distributorCode: "EP-PHS" },
];

/** The distributor a picker's choice files under: the real one for a template, else the code itself. */
export function salesDistributorCode(code: string): string {
  const key = normalizeCodeKey(code);
  return SECOND_TEMPLATES.find((t) => t.code === key)?.distributorCode ?? code;
}

/** A picker's list with each second template offered right after its distributor. */
export function withSecondTemplates<T extends { code: string; name: string }>(options: readonly T[]): T[] {
  return options.flatMap((option) => {
    const key = normalizeCodeKey(option.code);
    return [
      option,
      ...SECOND_TEMPLATES.filter((t) => t.distributorCode === key).map((t) => ({ ...option, code: t.code, name: t.name })),
    ];
  });
}
