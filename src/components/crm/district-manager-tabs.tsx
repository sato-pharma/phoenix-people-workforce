import Link from "next/link";

// The two tabs of the District Manager page, as the owner specified it: "Doctor list" and "Plans".
//
// Two ROUTES rather than one route with client-side tab state, on purpose. Each tab resolves a
// different server-side scope — the doctor list is scoped by rep, the plans board by the reps a
// manager owns — and a client tab switch would render the second tab's shell before its gate had
// run. A link re-enters the page, and the page re-runs the gate. It also means a manager can
// bookmark the plans he has to clear.
//
// Rendered by both pages, so a viewer always sees both tabs and always knows which one he is on.

const TABS = [
  { href: "/admin/doctor-list", label: "Doctor list" },
  { href: "/admin/plan-verification", label: "Plans" },
] as const;

export function DistrictManagerTabs({ active }: { active: "doctor-list" | "plan-verification" }) {
  return (
    <nav className="flex flex-wrap gap-0 border border-b-0 border-slate-200 bg-white">
      {TABS.map((tab) => {
        const isActive = tab.href.endsWith(active);
        return (
          <Link
            className={
              isActive
                ? "border-b-2 border-orange-500 px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900"
                : "border-b-2 border-transparent px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400 hover:text-slate-700"
            }
            href={tab.href}
            key={tab.href}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
