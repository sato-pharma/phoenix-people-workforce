/**
 * The Needs You board — five bands, in the order `render/sections.ts` decides.
 *
 * 🔴 IT LINKS, IT NEVER ACTS. Every row's only control is a `<Link>` to the screen that already owns
 * the decision. There is no form, no button, no server action and no non-GET fetch anywhere under
 * this route, and `tests/needs-you-page-never-decides.test.ts` pins that by scanning this file and
 * the page. That test is what turns "the module reports, it never decides" from a sentence in a
 * comment into a property of the code — the change it exists to catch is someone adding an Approve
 * button here, which would make this the fourteenth screen that can approve something instead of the
 * one screen that tells you where to go.
 *
 * 🔒 THE TWO GOLDEN RULES THIS FILE CARRIES, both MEASURED in a headless browser rather than
 * reviewed (`scripts/measure-needs-you-fit.mjs`):
 *
 *  - FITS THE SCREEN. Four columns on desktop, never five: the count shares its cell with OVERDUE and
 *    the names share theirs with "oldest <date> · <n> days". That merge is how it fits — the rule is
 *    that you fit by MERGING columns, never by shrinking type, and `overflow-x-auto` over a
 *    `min-width` floor IS the bug rather than the fix. Mobile gets one square card per row carrying
 *    the same four facts stacked, never a subset.
 *  - SQUARE EDGES. No `rounded-*` anywhere, and `@/components/ui/card` is avoided for exactly that
 *    reason — it carries `--phx-radius`. `SectionShell` is already square, so it is reused.
 *
 * And NO ELLIPSIS: no `truncate`, no `line-clamp`, no `text-ellipsis`. `break-words` throughout,
 * because where the no-truncation rule meets the no-horizontal-scroll rule, wrapping wins.
 */
import Link from "next/link";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SectionShell } from "@/components/admin/ceo-command-center";
import {
  buildNeedsYouSections,
  needsYouHeroDescription,
  type NeedsYouRow,
  type NeedsYouSection,
} from "@/lib/needs-you/render/sections";
import type { NeedsYouBoard } from "@/lib/needs-you/types";
import { NEEDS_YOU_VENDORS_NOT_READ_LINE } from "@/lib/needs-you/vendor-accounts-rules";

/** The four column heads, beside the widths they are measured against. Four, never five. */
const COLUMN_HEADS = ["What needs you", "How many", "Who / since", "Where to do it"] as const;

function Destination({ row }: { row: NeedsYouRow }) {
  if (row.href) {
    return (
      <Link className="break-words text-phx-xs font-bold text-sky-700 underline" href={row.href}>
        {row.whereLabel}
      </Link>
    );
  }
  if (row.externalUrl) {
    // A GitHub pull request gets its own affordance, never the app's own link slot — that separation
    // is why `href` is templated `/${string}` and this one is not.
    return (
      <a
        className="break-words text-phx-xs font-bold text-sky-700 underline"
        href={row.externalUrl}
        rel="noreferrer"
        target="_blank"
      >
        {row.whereLabel}
      </a>
    );
  }
  return <span className="break-words text-phx-xs text-slate-500">No screen owns this yet</span>;
}

function OverdueMark({ row }: { row: NeedsYouRow }) {
  if (!row.overdueLabel) return null;
  return (
    <span className="mt-1 block break-words text-phx-3xs font-black uppercase tracking-[0.1em] text-rose-700">
      {row.overdueLabel}
    </span>
  );
}

function RowCards({ rows }: { rows: readonly NeedsYouRow[] }) {
  return (
    <ul className="divide-y divide-slate-200 md:hidden">
      {rows.map((row) => (
        <li className="min-w-0 px-4 py-3" key={row.key}>
          <p className="break-words text-sm font-bold text-slate-900">{row.what}</p>
          {row.note ? <p className="mt-0.5 break-words text-phx-xs text-slate-500">{row.note}</p> : null}
          <p className="mt-1.5 break-words text-sm font-black tabular-nums text-slate-900">{row.howMany}</p>
          <OverdueMark row={row} />
          <p className="mt-1 break-words text-phx-xs text-slate-600">{row.whoSince}</p>
          <p className="mt-1.5">
            <Destination row={row} />
          </p>
        </li>
      ))}
    </ul>
  );
}

function RowTable({ rows }: { rows: readonly NeedsYouRow[] }) {
  return (
    <div className="hidden md:block">
      {/* `table-fixed` + a `<colgroup>` summing to 100%, and NEVER a `min-w-[…]` floor inside an
          `overflow-x-auto` wrapper: the golden rule names that pairing as the bug itself, because a
          scrolling wrapper absorbs the overflow so a page-level `scrollWidth` check reads clean while
          the board hangs off the side. Every cell wraps instead. */}
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[34%]" />
          <col className="w-[14%]" />
          <col className="w-[22%]" />
          <col className="w-[30%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-phx-3xs font-black uppercase tracking-[0.1em] text-slate-500">
            {COLUMN_HEADS.map((head) => (
              <th className="break-words px-4 py-2.5 align-bottom font-black" key={head}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr className="align-top" key={row.key}>
              <td className="px-4 py-3">
                <p className="break-words text-sm font-bold text-slate-900">{row.what}</p>
                {row.note ? <p className="mt-0.5 break-words text-phx-xs text-slate-500">{row.note}</p> : null}
              </td>
              <td className="px-4 py-3">
                <span className="break-words text-sm font-black tabular-nums text-slate-900">{row.howMany}</span>
                <OverdueMark row={row} />
              </td>
              <td className="px-4 py-3">
                <p className="break-words text-phx-xs text-slate-600">{row.whoSince}</p>
              </td>
              <td className="px-4 py-3">
                <Destination row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Band({ section }: { section: NeedsYouSection }) {
  if (section.band === "notices") {
    // Band ONE, above the work. An amber notice under a table the reader has already left is an
    // amber notice nobody sees, so this sits first — and it renders NOTHING when every source
    // answered, rather than a reassuring green row that would become wallpaper.
    if (section.notices.length === 0) return null;
    return (
      <SectionShell description={section.description} title={section.title}>
        <ul className="divide-y divide-amber-200">
          {section.notices.map((notice) => (
            <li className="min-w-0 border-l-4 border-amber-500 bg-amber-50 px-4 py-3" key={notice.key}>
              <p className="break-words text-sm font-bold text-amber-900">{notice.label}</p>
              <p className="mt-0.5 break-words text-phx-xs text-amber-800">{notice.because}</p>
            </li>
          ))}
        </ul>
      </SectionShell>
    );
  }

  if (section.band === "table") {
    return (
      <SectionShell description={section.description} title={section.title}>
        {section.rows.length === 0 ? (
          <p className="break-words px-4 py-4 text-sm text-slate-600">{section.emptyLine}</p>
        ) : (
          <>
            <RowCards rows={section.rows} />
            <RowTable rows={section.rows} />
          </>
        )}
      </SectionShell>
    );
  }

  if (section.band === "prose") {
    return (
      <SectionShell description={section.description} title={section.title}>
        {section.lines.length === 0 ? (
          <p className="break-words px-4 py-4 text-sm text-slate-600">{section.emptyLine}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {section.lines.map((line) => (
              <li className="min-w-0 px-4 py-3" key={line.key}>
                <p className="break-words text-sm text-slate-800">{line.text}</p>
                {line.href ? (
                  <Link className="mt-1 inline-block break-words text-phx-xs font-bold text-sky-700 underline" href={line.href}>
                    {line.whereLabel}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionShell>
    );
  }

  // The every-source band. Deliberately NOT a second table: one table shape in this file means one
  // `<colgroup>` to keep summing to 100%, and this band is what makes a silently dropped source
  // visible ON SCREEN rather than only in a test.
  return (
    <SectionShell description={section.description} title={section.title}>
      <ul className="divide-y divide-slate-100">
        {section.rows.map((row) => (
          <li
            className="flex min-w-0 flex-col gap-1 px-4 py-2.5 md:flex-row md:items-baseline md:justify-between md:gap-4"
            key={row.key}
          >
            <span className="min-w-0 break-words text-phx-xs font-bold text-slate-800">{row.label}</span>
            <span className="min-w-0 break-words text-phx-xs text-slate-600 md:text-right">
              <span
                className={
                  row.verdict === "Could not be read"
                    ? "font-black uppercase tracking-[0.08em] text-amber-800"
                    : "font-bold text-slate-500"
                }
              >
                {row.verdict}
              </span>
              {row.because ? <span className="break-words"> — {row.because}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

export function NeedsYouBoardView({ board }: { board: NeedsYouBoard }) {
  const sections = buildNeedsYouSections(board);
  return (
    <div className="min-w-0 space-y-4">
      <AdminPageHero
        description={needsYouHeroDescription(board)}
        eyebrow="Command Center"
        title="Needs You"
      />
      {sections.map((section) => (
        <Band key={section.id} section={section} />
      ))}
      <p className="break-words text-phx-xs font-bold text-slate-600">{NEEDS_YOU_VENDORS_NOT_READ_LINE}</p>
    </div>
  );
}
