import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { loadSlowPagesOverview, type PageFigure, type SlowPage, type SlowPagesOverview } from "@/lib/system-audit/slow-pages";

/**
 * The Slowest pages tab of the System Audit page (1 Nov 2026, owner: "record everything").
 *
 * What the reps' and managers' browsers reported this week, per page shape: how long a hard load took
 * to its first byte, its first content and its largest content, how long a tap inside the app took to
 * reach its page, and the same on low-end devices — from the page_timings table the web process writes
 * every hour (src/lib/observability/page-timing-*.ts). No person is recorded there, so none is shown.
 *
 * An async server component, so the page mounts it inside its own <Suspense>.
 */
export async function SlowPagesSection() {
  let overview: SlowPagesOverview | null = null;
  let loadError: string | null = null;
  try {
    overview = await loadSlowPagesOverview();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "the page timings could not be read";
  }
  if (!overview) {
    return (
      <AdminCallout tone="danger">
        <p className="break-words">Unavailable — {loadError}</p>
      </AdminCallout>
    );
  }
  return <SlowPagesView overview={overview} />;
}

const headCell = "px-3 py-2 text-left align-bottom text-phx-2xs font-bold uppercase tracking-[0.06em] break-words";
const bodyCell = "px-3 py-2 align-top break-words";

function ms(value: number): string {
  return value < 1000 ? `${value.toLocaleString("en-US")} ms` : `${(value / 1000).toFixed(1)} s`;
}

function figure(value: PageFigure | null): string {
  return value ? `${ms(value.p50Ms)} · ${ms(value.p90Ms)}` : "—";
}

function worst(page: SlowPage): string {
  const candidates = [page.largestContent, page.firstContent, page.firstByte].filter((value): value is PageFigure => value !== null);
  return candidates.length ? ms(Math.max(...candidates.map((value) => value.maxMs))) : "—";
}

function HardLoadsTable({ pages }: { pages: SlowPage[] }) {
  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[860px]:table">
        <colgroup>
          <col className="w-[26%]" />
          <col className="w-[8%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[12%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead>
          <tr className="bg-[#0B0B0B] text-white">
            <th className={headCell} scope="col">Page</th>
            <th className={headCell} scope="col">Loads</th>
            <th className={headCell} scope="col">First byte (median)</th>
            <th className={headCell} scope="col">First content (median · p90)</th>
            <th className={headCell} scope="col">Largest content (median · p90)</th>
            <th className={headCell} scope="col">Low-end devices (first content p90)</th>
            <th className={headCell} scope="col">Worst</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => (
            <tr className="border-b border-slate-100" key={page.path}>
              <td className={`${bodyCell} font-bold text-slate-900`}>{page.path}</td>
              <td className={bodyCell}>{((page.firstByte ?? page.firstContent)?.count ?? 0).toLocaleString("en-US")}</td>
              <td className={bodyCell}>{page.firstByte ? ms(page.firstByte.p50Ms) : "—"}</td>
              <td className={bodyCell}>{figure(page.firstContent)}</td>
              <td className={bodyCell}>{figure(page.largestContent)}</td>
              <td className={bodyCell}>{page.lowDeviceFirstContent ? ms(page.lowDeviceFirstContent.p90Ms) : "—"}</td>
              <td className={`${bodyCell} font-bold`}>{worst(page)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-200 @min-[860px]:hidden">
        {pages.map((page) => (
          <li className="space-y-1 px-3 py-3 text-xs" key={page.path}>
            <p className="break-words font-bold text-slate-900">{page.path}</p>
            <p className="text-slate-500">
              {((page.firstByte ?? page.firstContent)?.count ?? 0).toLocaleString("en-US")} loads · worst {worst(page)}
            </p>
            <p>First byte {page.firstByte ? ms(page.firstByte.p50Ms) : "—"} · first content {figure(page.firstContent)}</p>
            <p>Largest content {figure(page.largestContent)} · low-end devices {page.lowDeviceFirstContent ? ms(page.lowDeviceFirstContent.p90Ms) : "—"}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TapsTable({ pages }: { pages: SlowPage[] }) {
  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[860px]:table">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr className="bg-[#0B0B0B] text-white">
            <th className={headCell} scope="col">Page</th>
            <th className={headCell} scope="col">Taps</th>
            <th className={headCell} scope="col">Median</th>
            <th className={headCell} scope="col">p90</th>
            <th className={headCell} scope="col">Worst</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => (
            <tr className="border-b border-slate-100" key={page.path}>
              <td className={`${bodyCell} font-bold text-slate-900`}>{page.path}</td>
              <td className={bodyCell}>{page.taps!.count.toLocaleString("en-US")}</td>
              <td className={bodyCell}>{ms(page.taps!.p50Ms)}</td>
              <td className={bodyCell}>{ms(page.taps!.p90Ms)}</td>
              <td className={`${bodyCell} font-bold`}>{ms(page.taps!.maxMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-200 @min-[860px]:hidden">
        {pages.map((page) => (
          <li className="space-y-1 px-3 py-3 text-xs" key={page.path}>
            <p className="break-words font-bold text-slate-900">{page.path}</p>
            <p className="text-slate-500">{page.taps!.count.toLocaleString("en-US")} taps</p>
            <p>
              Median {ms(page.taps!.p50Ms)} · p90 {ms(page.taps!.p90Ms)} · worst {ms(page.taps!.maxMs)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SlowPagesView({ overview }: { overview: SlowPagesOverview }) {
  const hard = overview.pages.filter((page) => page.firstByte || page.firstContent || page.largestContent);
  const tapped = overview.pages
    .filter((page) => page.taps)
    .sort((a, b) => b.taps!.p90Ms - a.taps!.p90Ms || a.path.localeCompare(b.path));
  if (overview.pages.length === 0) {
    return (
      <AdminCallout tone="neutral">
        <p className="break-words">
          Nothing reported in the last {overview.days} days. The browsers report each page as it is left; the first hour is written once it ends.
        </p>
      </AdminCallout>
    );
  }
  return (
    <div className="min-w-0 space-y-5">
      <AdminCallout tone="neutral">
        <p className="break-words">
          What the browsers reported over the last {overview.days} days: {overview.loads.toLocaleString("en-US")} page loads and {overview.taps.toLocaleString("en-US")} taps inside the app, summed by the hour per page shape (an id in a path reads as :id). Nobody is recorded — no name, login, address or device make, only a low-end or high-end class.
        </p>
      </AdminCallout>
      <AdminTableShell
        description="A sign-in, a bookmark or a reload. The first byte is the server's share; first content is when something showed; largest content is when the page looked ready (Safari reports none). Slowest first, by the 90th percentile."
        title="Hard loads"
      >
        <HardLoadsTable pages={hard} />
      </AdminTableShell>
      <AdminTableShell
        description="From the tap to the page rendering, with no new document. Slowest first, by the 90th percentile."
        title="Taps inside the app"
      >
        {tapped.length ? (
          <TapsTable pages={tapped} />
        ) : (
          <p className="px-5 py-4 text-sm text-slate-500">No taps reported yet.</p>
        )}
      </AdminTableShell>
    </div>
  );
}
