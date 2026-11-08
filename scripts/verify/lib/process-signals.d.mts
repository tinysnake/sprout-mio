export type SignalResult = Readonly<{ delivered: boolean; reported: boolean }>;
export function groupHasLiveProcess(pid: number): boolean | null;
export function reportSignalFailure(
  pid: number,
  signal: string,
  error: { message: string },
  options?: { write?: (line: string) => void },
): string;
export function signalProcessGroup(
  pid: number,
  signal: string,
  options?: {
    kill?: (pid: number, signal: string) => void;
    group?: (pid: number) => boolean | null;
    report?: (pid: number, signal: string, error: { message: string }) => void;
  },
): SignalResult;
