export function crewRailStorageKey(projectId: string): string {
  return `sprout:crew-rail:${projectId}`;
}

export function crewRailExpanded(stored: string | null, width: number): boolean {
  if (stored === "expanded") return true;
  if (stored === "collapsed") return false;
  return width >= 1024;
}
