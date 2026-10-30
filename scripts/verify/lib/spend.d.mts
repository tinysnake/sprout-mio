export interface SpendGate {
  id: string;
  status: string;
  durationMs: number;
}
export interface SpendEntry {
  at: string;
  head: string | null;
  target: string;
  selection: readonly string[] | null;
  durationMs: number;
  count: number;
  failed: number;
  gates: SpendGate[];
}
export interface SpendReport {
  finishedAt: string;
  target: string;
  selection: readonly string[] | null;
  durationMs: number;
  count: number;
  failed: number;
  outcomes: readonly { id: string; status: string; durationMs: number }[];
}
export function spendEntry(report: SpendReport, head: string | null): SpendEntry;
export function parseLedger(text: string): SpendEntry[];
export function greenFullRunOn(text: string, head: string | null): SpendEntry | null;
