import { useSyncExternalStore } from "react";

let connected = true;
const listeners = new Set<() => void>();
export function setConnected(value: boolean) {
  connected = value;
  for (const listener of listeners) listener();
}
export function useConnected() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => connected,
    () => true,
  );
}
export function isOffline() {
  return typeof navigator !== "undefined" && !navigator.onLine;
}
