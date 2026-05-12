import { LoadingSpinner } from "@/components/ui/loading-state";

export default function EmployeePortalLoading() {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[26px] border border-slate-200 bg-white p-8 text-center shadow-[0_18px_46px_rgba(15,23,42,0.07)]">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-orange-100 bg-orange-50">
        <LoadingSpinner className="h-7 w-7 text-orange-500" />
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-900">Updating your portal</p>
      <p className="mt-1 text-sm text-slate-500">Preparing the latest workforce intelligence.</p>
    </div>
  );
}
