export function crewRailStorageKey(projectId: string): string {
  return `sprout:crew-rail:${projectId}`;
}

export function crewRailExpanded(stored: string | null, width: number): boolean {
  if (stored === "expanded") return true;
  if (stored === "collapsed") return false;
  return width >= 1024;
}

/** 未折叠的非进行中委派：总数最多 3，进行中越多，留给历史的预览位越少。 */
export function crewVisibleInactiveCount(activeCount: number, inactiveCount: number): number {
  return Math.min(3, Math.max(0, 3 - activeCount), inactiveCount);
}
