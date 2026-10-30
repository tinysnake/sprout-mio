import { useState } from "react";
import { TaskBoard } from "../../../components/tasks/task-board";
import { TaskDetailView } from "../../../components/tasks/task-detail";
import { Button } from "../../../components/ui/button";
import { taskSceneBoard, taskSceneDetail } from "./fixtures";

export function TaskScenes() {
  const [showDetail, setShowDetail] = useState(false);
  return <div className="min-w-0 overflow-auto p-5"><p className="mb-3 text-xs text-muted-foreground">Task 演示 · 虚构数据，不连接业务服务</p><Button variant="secondary" onClick={() => setShowDetail(value => !value)}>{showDetail ? "四态总览" : "详情与历史结果"}</Button>{showDetail ? <TaskDetailView detail={taskSceneDetail} onCommand={async () => {}} /> : <div className="mt-5"><TaskBoard view={taskSceneBoard} /></div>}</div>;
}
