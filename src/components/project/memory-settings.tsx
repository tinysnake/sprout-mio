import { MemoryConfigPanel } from "./memory-config-panel";

export function MemorySettings({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  return <MemoryConfigPanel key={projectId} projectId={projectId} projectName={projectName} />;
}
