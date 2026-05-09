export type FilterState = {
  category: "all" | "sales" | "payroll" | "expenses" | "workforce";
  period: string | null;
  line: string | null;
};

export type ChartDataPoint = {
  label: string;
  value: number;
  meta?: string;
};

export type TrendDataPoint = {
  achievementRate?: number;
  label: string;
  month?: string;
  period?: string;
  sales: number;
  target: number;
  targetValue?: number;
  amount?: number;
};

export type ChartProps = {
  data: unknown;
  hoveredElement: string | null;
  onHover: (element: string | null) => void;
  filter: FilterState;
  loading?: boolean;
  tooltipConfig?: {
    showValue?: boolean;
    showPercent?: boolean;
    showContext?: boolean;
  };
};
