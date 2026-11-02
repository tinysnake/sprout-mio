export type RequestLogSummaryRow = {
  key: string;
  count: number;
  bytes: number;
  p50: number;
  p95: number;
  max: number;
  serverErrors: number;
  incomplete: number;
};

export type RequestLogSummary = {
  rows: RequestLogSummaryRow[];
  total: Omit<RequestLogSummaryRow, "key">;
};

export function summarize(text: string): RequestLogSummary;
