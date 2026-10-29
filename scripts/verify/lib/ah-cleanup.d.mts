import type { ChildProcess } from "node:child_process";
export function killAhNativeCommands(state: string): void;
export function cleanupAhFixture(options: {
  children: ChildProcess[];
  state: string;
  completionFiles?: Iterable<string>;
  childrenPids?: Iterable<number>;
}): Promise<void>;
