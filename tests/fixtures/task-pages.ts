import type { TaskDetail } from "../../src/contracts/task";
import { taskSceneDetail } from "../../src/dev/scenes/tasks/fixtures";

export function taskPageDetail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return { ...structuredClone(taskSceneDetail), ...patch };
}
