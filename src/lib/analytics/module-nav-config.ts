export const SOS_TABS = [
  { href: "/admin/analytics/source-sales",              label: "Overview"    },
  { href: "/admin/analytics/source-sales/by-line",      label: "By Line"     },
  { href: "/admin/analytics/source-sales/by-area",      label: "By Area"     },
  { href: "/admin/analytics/source-sales/by-product",   label: "By Product"  },
  { href: "/admin/analytics/source-sales/by-customer",  label: "Customers"   },
] as const;

export const CLOSING_TABS = [
  { href: "/admin/analytics/monthly-closing",              label: "Overview"     },
  { href: "/admin/analytics/monthly-closing/by-line",      label: "By Line"      },
  { href: "/admin/analytics/monthly-closing/by-employee",  label: "By Employee"  },
] as const;

export const WEEKLY_TABS = [
  { href: "/admin/analytics/weekly-sales",                  label: "Overview"        },
  { href: "/admin/analytics/weekly-sales/by-distributor",   label: "By Distributor"  },
  { href: "/admin/analytics/weekly-sales/detail",           label: "Detail"          },
] as const;
