import {
  adminHeroSkeletonClassName,
  adminHeroSurfaceClassName,
} from "@/components/admin/admin-design-tokens";

/**
 * Mirrors the real page's band structure — hero, a 4-tile "money in motion" row, the payroll
 * cycle panel, then the queues. A skeleton whose shape does not match what arrives reads as a
 * layout jump; one that promises a section the page never renders reads as a stuck load.
 */
export default function Loading() {
  return (
    <div className="space-y-0 divide-y divide-slate-200">
      <div className={`${adminHeroSurfaceClassName} p-7`}>
        <div className={`${adminHeroSkeletonClassName} h-4 w-48`} />
        <div className={`${adminHeroSkeletonClassName} mt-4 h-8 w-2/3`} />
        <div className={`${adminHeroSkeletonClassName} mt-3 h-4 w-1/2`} />
      </div>

      <div className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-900 px-5 py-4">
          <div className="h-4 w-40 animate-pulse bg-slate-700" />
          <div className="mt-2 h-3 w-64 animate-pulse bg-slate-800" />
        </div>
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="min-h-32 border border-slate-200 bg-white px-4 py-4" key={index}>
              <div className="h-3 w-24 animate-pulse bg-slate-200" />
              <div className="mt-4 h-8 w-28 animate-pulse bg-slate-200" />
              <div className="mt-3 h-3 w-20 animate-pulse bg-slate-100" />
            </div>
          ))}
        </div>
      </div>

      <div className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-900 px-5 py-4">
          <div className="h-4 w-32 animate-pulse bg-slate-700" />
          <div className="mt-2 h-3 w-72 animate-pulse bg-slate-800" />
        </div>
        <div className="h-64 animate-pulse bg-slate-50" />
      </div>

      <div className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-900 px-5 py-4">
          <div className="h-4 w-36 animate-pulse bg-slate-700" />
        </div>
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="h-16 animate-pulse bg-slate-50" key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
