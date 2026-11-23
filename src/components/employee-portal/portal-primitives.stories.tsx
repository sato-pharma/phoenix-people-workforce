import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CalendarDays, Clock3, MapPin, Wallet } from "lucide-react";

import { landingActionClassName } from "./landing-kit";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalFilterBar,
  PortalMetricCard,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
  PortalSegmentedTabs,
} from "./portal-primitives";

/**
 * The portal's shared page parts — the ones forty-seven portal pages are built from — on the landing
 * kit's language. Sample rows only; no story names a real employee or shows a real figure.
 */
const meta: Meta = {
  title: "Portal/Page parts",
};

export default meta;

type Story = StoryObj;

type SampleRow = { area: string; name: string; state: "Approved" | "Waiting" | "Returned"; days: number };

const SAMPLE_ROWS: SampleRow[] = [
  { area: "Sample Area One", days: 3, name: "Sample Person A", state: "Approved" },
  { area: "Sample Area Two", days: 1, name: "Sample Person B with a much longer name that has to wrap", state: "Waiting" },
  { area: "Sample Area Three", days: 5, name: "Sample Person C", state: "Returned" },
];

const STATE_TEXT: Record<SampleRow["state"], string> = {
  Approved: "text-emerald-700",
  Returned: "text-rose-700",
  Waiting: "text-amber-700",
};

const STATE_ACCENT: Record<SampleRow["state"], "emerald" | "amber" | "rose"> = {
  Approved: "emerald",
  Returned: "rose",
  Waiting: "amber",
};

export const MetricTiles: Story = {
  render: () => (
    <div className="@container">
      <div className="grid grid-cols-1 gap-2 @[28rem]:grid-cols-2 @3xl:grid-cols-4">
        <PortalMetricCard icon={CalendarDays} label="Annual leave left" note="of 21 this year" value="14" />
        <PortalMetricCard accent="emerald" icon={MapPin} label="Visits this week" value="38" />
        <PortalMetricCard accent="amber" icon={Clock3} label="Waiting on you" note="2 near their deadline" value="5" />
        <PortalMetricCard accent="rose" icon={Wallet} label="Short / absent" value="1" />
      </div>
    </div>
  ),
};

export const SectionWithTable: Story = {
  render: () => (
    <PortalSection
      actions={
        <button className={landingActionClassName("outline")} type="button">
          Export
        </button>
      }
      eyebrow="Leave"
      title="Requests"
    >
      <PortalResponsiveDataList
        empty={<PortalEmptyState message="Nothing has been requested this month." title="No requests" />}
        getKey={(row) => row.name}
        items={SAMPLE_ROWS}
        renderCard={(row) => (
          <PortalRecordCard
            accent={STATE_ACCENT[row.state]}
            meta={row.area}
            status={<span className={`text-phx-xs font-bold uppercase tracking-[0.08em] ${STATE_TEXT[row.state]}`}>{row.state}</span>}
            title={row.name}
          >
            <PortalRecordFields
              fields={[
                { label: "Days", value: row.days },
                { label: "State", value: row.state },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[44%]" />
                <col className="w-[28%]" />
                <col className="w-[12%]" />
                <col className="w-[16%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-slate-200">
                {["Person", "Area", "Days", "State"].map((heading) => (
                  <th className="px-4 py-2.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ROWS.map((row) => (
                <tr className="border-b border-slate-100 last:border-b-0" key={row.name}>
                  <td className="break-words px-4 py-3 font-bold">{row.name}</td>
                  <td className="break-words px-4 py-3 text-slate-600">{row.area}</td>
                  <td className="px-4 py-3">{row.days}</td>
                  <td className={`px-4 py-3 text-phx-xs font-bold uppercase tracking-[0.08em] ${STATE_TEXT[row.state]}`}>{row.state}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
      <PortalPagination label="Showing 3 of 3" />
    </PortalSection>
  ),
};

export const FiltersAndTabs: Story = {
  render: () => (
    <>
      <PortalSegmentedTabs>
        {["This week", "This month", "All"].map((tab, index) => (
          <button
            className={
              index === 0
                ? "min-h-9 bg-[#08111f] px-3 text-phx-xs font-bold uppercase tracking-[0.08em] text-white"
                : "min-h-9 px-3 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-600 hover:bg-white"
            }
            key={tab}
            type="button"
          >
            {tab}
          </button>
        ))}
      </PortalSegmentedTabs>
      <PortalFilterBar countLabel="3 shown">
        <p className="text-phx-sm text-slate-500">The page&apos;s own filter controls sit here, in the form kit&apos;s skin.</p>
      </PortalFilterBar>
    </>
  ),
};

export const Empty: Story = {
  render: () => (
    <PortalSection title="Requests">
      <PortalEmptyState
        action={
          <button className={landingActionClassName("solid")} type="button">
            New request
          </button>
        }
        message="Nothing has been requested this month."
        title="No requests"
      />
    </PortalSection>
  ),
};
