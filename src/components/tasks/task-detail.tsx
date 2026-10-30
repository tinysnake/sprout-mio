import { useState } from "react";
import type { ReactNode } from "react";
import type { TaskAction } from "../../contracts/task-capabilities";
import type { TaskDetail, AssignTaskInput, UpdateTaskInput, CorrectTaskInput, ReopenTaskInput, AddTaskChecklistItemInput, UpdateTaskChecklistItemInput, RemoveTaskChecklistItemInput, AppendTaskRecordInput } from "../../contracts/task";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select } from "../ui/select";
import { TaskBadge } from "./task-badge";
import { responsibilityLabel, resultNotice } from "./task-view";
import { TaskAssignmentPanel, TaskMetadataFields } from "./task-forms";

export type TaskPageCommand =
  | { action: "assign" | "reassign"; input: AssignTaskInput }
  | { action: "update"; input: UpdateTaskInput }
  | { action: "correct"; input: CorrectTaskInput }
  | { action: "reopen"; input: ReopenTaskInput }
  | { action: "checklist_add"; input: AddTaskChecklistItemInput }
  | { action: "checklist_update"; input: UpdateTaskChecklistItemInput }
  | { action: "checklist_remove"; input: RemoveTaskChecklistItemInput }
  | { action: "record_append"; input: AppendTaskRecordInput }
  | { action: "start" | "unassign" | "complete" | "cancel"; input: { taskId: string; expectedRevision: number } };

export function TaskActionControl({ detail, action, label, pending, onClick }: { detail: TaskDetail; action: TaskAction; label: string; pending: boolean; onClick: () => void }) {
  const allowed = detail.capabilities.allowedActions.includes(action);
  const denial = detail.capabilities.denials[action];
  return <div className="space-y-2" data-testid={`task-action-${action}`}>
    <Button type="button" variant="secondary" disabled={pending || !allowed} onClick={onClick}>{label}</Button>
    {!allowed && denial && <p className="text-xs leading-5 break-words text-muted-foreground"><span>{denial.reason}</span> · <code>{denial.code}</code></p>}
  </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-4 border-b border-border py-6"><h2 className="text-sm font-medium">{title}</h2>{children}</section>;
}

export function TaskDetailView({ detail, pending = false, onCommand, chatFacts }: { detail: TaskDetail; pending?: boolean; onCommand: (command: TaskPageCommand) => Promise<void>; chatFacts?: ReactNode }) {
  const { task } = detail;
  const [record, setRecord] = useState("");
  const [newItem, setNewItem] = useState("");
  const [editor, setEditor] = useState<"update" | "correct" | null>(null);
  const [metadata, setMetadata] = useState({ title: task.title, description: task.description, constraints: task.constraints, completionRequirements: task.completionRequirements });
  const [correction, setCorrection] = useState("");
  const [initialChatId, setInitialChatId] = useState(detail.assignmentTargets[0]?.chatId ?? "");
  const write = { taskId: task.id, expectedRevision: task.revision };
  const allowed = (action: TaskAction) => detail.capabilities.allowedActions.includes(action);
  const notice = resultNotice(detail);
  return <article data-testid="task-detail" className="relative mx-auto w-full min-w-0 max-w-4xl text-sm [overflow-wrap:anywhere]">
    <header className="space-y-4 py-5">
      <a href={`/projects/${task.projectId}/tasks`} className="text-xs text-muted-foreground underline underline-offset-4">返回四态总览</a>
      <div className="flex flex-wrap items-center gap-3"><TaskBadge status={task.status} reopened={Boolean(detail.previousCompletionRecord)} /><span className="font-mono text-[10px] text-muted-foreground">{task.id} · v{task.revision}</span></div>
      <h1 className="text-xl leading-8 font-semibold break-words">{task.title}</h1>
      <p className="text-xs">{responsibilityLabel(detail.responsibility)}{detail.chat && <> · <a className="underline underline-offset-4" href={`/projects/${task.projectId}/chats/${detail.chat.id}`}>{detail.chat.displayTitle} · 进入 Chat</a></>}</p>
    </header>
    <div data-testid="task-result-notice" className="sticky top-0 z-10 border-y border-border bg-background px-3 py-3 text-xs leading-6">
      {notice.record ? <a className="underline underline-offset-4" href={`#task-record-${notice.record.seq}`}>{notice.label}</a> : notice.label}
    </div>
    <Section title="目标与要求"><dl className="space-y-5">{([["说明", task.description], ["约束", task.constraints], ["完成要求", task.completionRequirements]] as const).map(([label, body]) => <div key={label}><dt className="mb-1 text-xs text-muted-foreground">{label}</dt><dd className="text-sm leading-7 whitespace-pre-wrap">{body || "（空）"}</dd></div>)}</dl></Section>
    <Section title="Checklist">
      <p className="text-xs text-muted-foreground">清单未全部勾选也可以完成，动作能力以服务端为准。</p>
      <ul className="space-y-3">{detail.checklist.filter(item => !item.removedAt).map(item => <li key={item.id} className="flex items-start gap-3">
        <label className="flex min-w-0 flex-1 items-start gap-3 text-xs leading-6"><input className="mt-1" type="checkbox" checked={item.checked} disabled={pending || !allowed("checklist_update")} onChange={e => { void onCommand({ action: "checklist_update", input: { ...write, itemId: item.id, checked: e.target.checked } }); }} /><span>{item.body}</span></label>
        {allowed("checklist_remove") && <Button variant="ghost" disabled={pending} onClick={() => { void onCommand({ action: "checklist_remove", input: { ...write, itemId: item.id } }); }}>移除</Button>}
      </li>)}</ul>
      {detail.checklist.filter(item => !item.removedAt).length === 0 && <p className="text-xs text-muted-foreground">暂无清单项</p>}
      {allowed("checklist_add") && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void onCommand({ action: "checklist_add", input: { ...write, body: newItem } }).then(() => setNewItem("")); }}><Field label="新增清单项" className="min-w-0 flex-1"><Input required maxLength={1000} value={newItem} onChange={e => setNewItem(e.target.value)} /></Field><Button type="submit" disabled={pending}>添加</Button></form>}
    </Section>
    <Section title="施工记录">
      {detail.records.length === 0 && <p className="text-xs text-muted-foreground">尚无施工记录</p>}
      <ol className="space-y-5">{detail.records.map(item => <li key={item.seq} id={`task-record-${item.seq}`} className="scroll-mt-20 rounded-container border border-border p-4" data-testid={`task-record-${item.seq}`}>
        <p className="mb-2 text-xs text-muted-foreground">记录 #{item.seq}{item.visibility === "readable" && <> · {({ start: "请求立即开始", progress: "进展", correction: "Human 纠正" })[item.kind]} · {item.senderId}</>}</p>
        {notice.current && notice.record?.seq === item.seq && <p className="mb-2 text-xs text-status-success">当前完成结果</p>}
        {detail.completionHistory.some(history => history.record.seq === item.seq) && (!notice.current || notice.record?.seq !== item.seq) && <p className="mb-2 text-xs text-muted-foreground">历史完成结果</p>}
        <p className="text-sm leading-7 whitespace-pre-wrap">{item.visibility === "readable" ? item.body : "记录内容受限"}</p>
      </li>)}</ol>
      {allowed("record_append") && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void onCommand({ action: "record_append", input: { ...write, body: record } }).then(() => setRecord("")); }}><Field label="追加施工记录"><Textarea required maxLength={8000} value={record} onChange={e => setRecord(e.target.value)} /></Field><Button type="submit" disabled={pending}>追加进展记录</Button></form>}
    </Section>
    {(allowed("assign") || allowed("reassign")) && <Section title="分配"><TaskAssignmentPanel key={`${task.id}-${task.assignmentRevision}`} detail={detail} pending={pending} onSubmit={(targetChatId, startNow) => onCommand({ action: allowed("assign") ? "assign" : "reassign", input: { ...write, targetChatId, startNow } })} /></Section>}
    <Section title="动作">
      <p className="text-xs text-muted-foreground">完成时以末条施工记录作为结果。</p>
      <div className="grid gap-4 sm:grid-cols-2">{([["complete", "完成 Task"], ["cancel", "取消 Task"], ["start", "请求立即开始"], ["unassign", "撤回分配"]] as const).map(([action, label]) => <TaskActionControl key={action} detail={detail} action={action} label={label} pending={pending} onClick={() => { void onCommand({ action, input: write }); }} />)}
        <TaskActionControl detail={detail} action="update" label="编辑目标与要求" pending={pending} onClick={() => setEditor("update")} />
        <TaskActionControl detail={detail} action="correct" label="Human 纠正" pending={pending} onClick={() => setEditor("correct")} />
        <TaskActionControl detail={detail} action="reopen" label="重开 Task" pending={pending} onClick={() => { void onCommand({ action: "reopen", input: { ...write, ...(!task.chatId ? { initialChatId } : {}) } }); }} />
      </div>
      {!task.chatId && allowed("reopen") && <Field label="重开后承接 Chat"><Select value={initialChatId} onChange={e => setInitialChatId(e.target.value)}>{detail.assignmentTargets.map(target => <option key={target.chatId} value={target.chatId}>{target.displayTitle}</option>)}</Select></Field>}
      {editor && <form className="space-y-4" onSubmit={e => { e.preventDefault(); void onCommand(editor === "correct" ? { action: "correct", input: { ...write, ...metadata, ...(correction.trim() ? { record: { body: correction } } : {}) } } : { action: "update", input: { ...write, ...metadata } }).then(() => setEditor(null)); }}>
        <TaskMetadataFields value={metadata} onChange={setMetadata} />
        {editor === "correct" && <Field label="追加纠正记录" hint="已完成 Task 的结果以追加的纠正记录为准，原记录保留。"><Textarea maxLength={8000} value={correction} onChange={e => setCorrection(e.target.value)} /></Field>}
        <Button type="submit" disabled={pending}>保存{editor === "correct" ? "纠正" : "修改"}</Button><Button variant="ghost" type="button" onClick={() => setEditor(null)}>关闭</Button>
      </form>}
    </Section>
    {chatFacts && <Section title="承接 Chat 的独立事实">{chatFacts}</Section>}
  </article>;
}
