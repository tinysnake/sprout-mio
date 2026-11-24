export type ProcessRow = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  state: string;
  elapsed: number | null;
  command: string;
}>;

export type ProcessFact = Readonly<{ environment?: string; cwd?: string | null }>;

export type RunFact = Readonly<{ state: string; directory: string | null; root: string | null }>;

export type StrayEntry = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  kind: string;
  port: number | null;
  elapsedSeconds: number | null;
  runState: string;
  runDirectory: string | null;
}>;

export type StraySelection = Readonly<{
  related: StrayEntry[];
  strays: StrayEntry[];
  failing: StrayEntry[];
}>;

export function isForeignHost(command: string): boolean;
export function isProjectRuntime(command: string): boolean;
export function looksLikeRuntimeProcess(command: string): boolean;
export function parseElapsed(text: string): number | null;
export function parseProcessTable(text: string): ProcessRow[];
export function classifyKind(command: string): string;
export function detectPort(command: string): number | null;
export function processAlive(
  pid: number,
  options?: { kill?: (pid: number, signal: number) => void },
): boolean;
export function readRunContext(
  directory: string,
  options?: { read?: (file: string) => string },
): { ownerPid: number | null; root: string | null } | null;
export function verifyRunState(
  text: string,
  options?: {
    readContext?: (directory: string) => { ownerPid: number | null; root: string | null } | null;
    isAlive?: (pid: number) => boolean;
  },
): RunFact;
export function formatElapsed(seconds: number | null): string;
export function liveRunOwners(
  roots: readonly string[],
  options?: {
    list?: (directory: string) => string[];
    readContext?: (directory: string) => { ownerPid: number | null; root: string | null } | null;
    isAlive?: (pid: number) => boolean;
  },
): Set<number>;
export function protectedProcesses(
  rows: readonly ProcessRow[],
  ownerPids: Iterable<number>,
): Set<number>;
export function selectStrays(input: {
  rows: readonly ProcessRow[];
  roots: readonly string[];
  facts?: ReadonlyMap<number, ProcessFact>;
  runs?: ReadonlyMap<number, RunFact>;
  currentPid?: number;
  minimumAgeSeconds?: number;
  protectedPids?: ReadonlySet<number>;
}): StraySelection;
export function findRepositoryRoots(
  root?: string,
  options?: {
    runGit?: (root: string, args: string[]) => string | null;
    exists?: (path: string) => boolean;
  },
): string[];
export function readProcessTable(options?: { run?: unknown }): ProcessRow[] | null;
export function readEnvironments(
  pids: readonly number[],
  options?: { run?: unknown },
): Map<number, string> | null;
export function readWorkingDirectories(
  pids: readonly number[],
  options?: { run?: unknown },
): Map<number, string>;
export function stopStrays(
  strays: readonly StrayEntry[],
  options?: {
    delay?: (ms: number) => Promise<void>;
    alive?: unknown;
    ownPgid?: number | null;
  },
): Promise<{ survivors: StrayEntry[]; failures: string[] }>;
