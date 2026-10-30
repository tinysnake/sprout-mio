import { useState } from "react";
import type { CreateTaskInput, TaskDetail } from "../../contracts/task";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select } from "../ui/select";
import { responsibilityLabel } from "./task-view";

type Metadata = Pick<CreateTaskInput, "title" | "description" | "constraints" | "completionRequirements">;

export function TaskMetadataFields({ value, onChange }: { value: Metadata; onChange: (value: Metadata) => void }) {
  return <div className="grid gap-4">
    <Field label="目标"><Input required maxLength={120} value={value.title} onChange={e => onChange({ ...value, title: e.target.value })} /></Field>
    {([["description", "说明"], ["constraints", "约束"], ["completionRequirements", "完成要求"]] as const).map(([key, label]) => <Field key={key} label={label}><Textarea maxLength={8000} value={value[key]} onChange={e => onChange({ ...value, [key]: e.target.value })} /></Field>)}
  </div>;
}

export function TaskCreateForm({ projectId, pending, onSubmit }: { projectId: string; pending: boolean; onSubmit: (input: CreateTaskInput) => Promise<void> }) {
  const [value, setValue] = useState<Metadata>({ title: "", description: "", constraints: "", completionRequirements: "" });
  const [checklist, setChecklist] = useState("");
  return <form data-testid="task-create-form" className="space-y-5" onSubmit={e => { e.preventDefault(); void onSubmit({ projectId, ...value, checklist: checklist.split("\n").map(line => line.trim()).filter(Boolean) }); }}>
    <p className="text-xs text-muted-foreground">创建后进入待分配。</p>
    <TaskMetadataFields value={value} onChange={setValue} />
    <Field label="清单" hint="每行一项"><Textarea value={checklist} onChange={e => setChecklist(e.target.value)} /></Field>
    <Button type="submit" disabled={pending}>创建 Task</Button>
  </form>;
}

export function TaskAssignmentPanel({ detail, pending, onSubmit }: { detail: TaskDetail; pending: boolean; onSubmit: (targetChatId: string, startNow: boolean) => Promise<void> }) {
  const [target, setTarget] = useState(detail.assignmentTargets[0]?.chatId ?? "");
  const [startNow, setStartNow] = useState(false);
  const chosen = detail.assignmentTargets.find(item => item.chatId === target);
  return <form data-testid="task-assignment" className="space-y-4" onSubmit={e => { e.preventDefault(); void onSubmit(target, startNow); }}>
    <Field label="承接 Chat"><Select value={target} required onChange={e => setTarget(e.target.value)}><option value="" disabled>选择 Chat</option>{detail.assignmentTargets.map(item => <option key={item.chatId} value={item.chatId}>{item.displayTitle} · {responsibilityLabel(item.responsibility)}</option>)}</Select></Field>
    <label className="flex min-h-10 items-center gap-2 text-xs"><input type="checkbox" checked={startNow} onChange={e => setStartNow(e.target.checked)} />立即开始</label>
    <p className="text-xs text-muted-foreground">分配后为已分配；立即开始会向承接 Chat 写入请求。</p>
    {startNow && <div data-testid="task-start-snapshot" className="space-y-3 rounded-container border border-border p-4 text-xs leading-6 break-words whitespace-pre-wrap">
      <h4 className="font-medium">将写入 Chat 的完整快照</h4>
      <p>请求立即开始 · {detail.task.id}</p><p>目标：{detail.task.title}</p><p>说明：{detail.task.description || "（空）"}</p><p>约束：{detail.task.constraints || "（空）"}</p><p>完成要求：{detail.task.completionRequirements || "（空）"}</p>
      <div>清单：{detail.checklist.filter(item => !item.removedAt).map(item => <p key={item.id}>{item.checked ? "[x]" : "[ ]"} {item.body}</p>)}</div>
      {chosen?.responsibility.kind === "human" && <p>Human 负责人的请求将作为普通叙述消息写入 Chat。</p>}
    </div>}
    <Button disabled={pending || !target} type="submit">{startNow ? "分配并请求立即开始" : "仅保存分配"}</Button>
  </form>;
}
