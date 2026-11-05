import { join } from "node:path";

export function projectRepositoryPath(root: string, projectId: string, workDirectory?: string) {
  return join(root, workDirectory ?? projectId);
}
