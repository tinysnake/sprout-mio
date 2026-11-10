export type MachineState = Readonly<{
  cpus: number;
  totalMemMB: number;
  freeMemMB: number;
  load: readonly number[];
}>;
export const LOADED_FACTOR: number;
export const UNFIT_LOAD_FACTOR: number;
export const LOADED_BYPASS_ENV: string;
export const MACHINE_STATE_ENV: string;
export function machineState(environment?: Record<string, string | undefined>): MachineState;
export function loadedMachine(state: MachineState): boolean;
export function unfitMachine(state: MachineState): boolean;
export function unfitReason(state: MachineState): string;
