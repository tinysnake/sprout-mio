import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent, Ref } from "react";
import { AlertTriangle, CornerDownLeft, MessageSquare, Plus } from "lucide-react";
import type { FieldErrors } from "../../contracts/project";
import type { AppError } from "../../contracts/result";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_MAX_TOTAL_BYTES,
} from "../../contracts/attachment";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { FieldError } from "../project/result-error";
import { ChatErrorNotice } from "./chat-error-notice";
import type { ChatSkillChoices, SkillOption } from "../../contracts/skill";
import { insertSkill, SKILL_TRIGGER, skillQueryAt } from "../../lib/skill-token";
import { AttachmentBar } from "./attachment-bar";
import type { ComposerAttachment } from "./attachment-bar";
import { ComposerEditor } from "./composer-editor";
import type { ComposerEditorHandle } from "./composer-editor";
import "./composer-editor.css";
import { SkillPicker } from "./skill-picker";
import { MentionPicker, matchMembers, mentionOptionId, mentionQueryAt } from "./mention-picker";
import type { MentionMember, MentionQuery } from "./mention-picker";

export const MESSAGE_MAX_LENGTH = 8000;

/** 附件预检的数字取契约里那份常量（src/contracts/attachment.ts），客户端不另写一套。 */
const ATTACHMENT_MEGABYTE = 1024 * 1024;

let localIdCounter = 0;

/** 附件本地 id 只在本条消息内有效：服务端落库时按它把正文里的引用换成真实附件 id。 */
function nextLocalId(): string {
  localIdCounter += 1;
  // 不用时间戳：只有 domain 层允许就地读时钟（见 tests/tooling.test.ts）。
  return `local-${localIdCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 输入区：发送、追加与停止都在这里。运行中发送的语义是追加到当前轮，
 * 文案与提交动作都随状态变化，未投递的输入由 run 状态区另行提示。
 */
export function MessageComposer({
  agentName,
  members,
  skills = { state: "unavailable", items: [] },
  onSkillsRefresh,
  draft,
  onDraftChange,
  onSubmit,
  onSubmitWithAttachments,
  pending,
  error,
  fieldErrors,
  runActive,
  runStatusLabel,
  stopping,
  stopError,
  onStop,
  inputRef,
}: {
  agentName: string;
  /** 可以 @ 的成员：只有名字会进正文，id 只用来区分同一批候选项。 */
  members: readonly MentionMember[];
  skills?: ChatSkillChoices;
  onSkillsRefresh?: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  /**
   * 有附件时才走这条：把正文与附件一起交给上层投递，返回 true 表示已送达，
   * 输入区据此清空草稿与附件；false（含抛错）时两者都保留。没传就退回 onSubmit。
   */
  onSubmitWithAttachments?: (input: {
    body: string;
    attachments: readonly ComposerAttachment[];
  }) => Promise<boolean>;
  pending: boolean;
  error: AppError | null;
  fieldErrors: FieldErrors;
  /** 有排队中或运行中的 run：按钮变成追加，并出现停止。 */
  runActive: boolean;
  runStatusLabel: string;
  stopping: boolean;
  stopError: AppError | null;
  /** 群组里停止下沉到每个 Agent 的行内按钮，输入区不再提供总停止。 */
  onStop?: () => void;
  /** 未投递输入恢复到输入框后需要把焦点放回这里。 */
  inputRef?: Ref<ComposerEditorHandle>;
}) {
  const canSend = draft.trim().length > 0;
  const editor = useRef<ComposerEditorHandle | null>(null);
  const listId = useId();
  const [query, setQuery] = useState<(MentionQuery & { kind: "mention" | "skill" }) | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // 光标位置按 markdown 偏移给候选浮层用；正文自己排版，标记的显隐由编辑器内部决定。
  const [caret, setCaret] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement | null>(null);
  const urls = useRef<string[]>([]);
  // 引用芯片显示该附件的文件名；附件已被移除时只显示「附件」。
  const names = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.localId, attachment.file.name])),
    [attachments],
  );

  // object URL 不能由每次渲染决定存活期：卸载时统一回收，晚于所有预览节点消失。
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current = [];
    },
    [],
  );

  // 草稿被外部改写（发送后清空、恢复未投递输入）时区间不再成立，浮层跟着关掉。
  const trigger = query?.kind === "skill" ? SKILL_TRIGGER : "@";
  const activeQuery =
    query && draft.slice(query.start, query.end) === `${trigger}${query.query}` ? query : null;
  const matches = useMemo(
    () => (activeQuery?.kind === "mention" ? matchMembers(members, activeQuery.query) : []),
    [members, activeQuery],
  );
  const skillMatches =
    activeQuery?.kind === "skill"
      ? skills.items.filter((skill) =>
          skill.name.toLowerCase().includes(activeQuery.query.toLowerCase()),
        )
      : [];
  const count = activeQuery?.kind === "skill" ? skillMatches.length : matches.length;
  const open = activeQuery !== null;
  const active = count > 0 ? Math.min(activeIndex, count - 1) : -1;

  const attachEditor = useCallback(
    (handle: ComposerEditorHandle | null) => {
      editor.current = handle;
      if (typeof inputRef === "function") inputRef(handle);
      else if (inputRef) inputRef.current = handle;
    },
    [inputRef],
  );

  /** 按光标前的正文同步候选区间；同一区间不产生多余渲染。 */
  function syncQuery(value: string, position: number) {
    const skill = skillQueryAt(value, position);
    const mention = skill ? null : mentionQueryAt(value, position);
    const next = skill
      ? { ...skill, kind: "skill" as const }
      : mention
        ? { ...mention, kind: "mention" as const }
        : null;
    if (next?.kind === "skill" && query?.kind !== "skill") onSkillsRefresh?.();
    setQuery((previous) =>
      previous &&
      next &&
      previous.start === next.start &&
      previous.end === next.end &&
      previous.query === next.query &&
      previous.kind === next.kind
        ? previous
        : next,
    );
    setActiveIndex(0);
  }

  function change(value: string, position: number) {
    onDraftChange(value);
    setCaret(position);
    syncQuery(value, position);
  }

  function pick(member: MentionMember) {
    if (!activeQuery) return;
    setQuery(null);
    setActiveIndex(0);
    // 点名和技能、附件一样是不可拆的标签：插原子节点，而不是一段可以被逐个字符改掉的文本。
    editor.current?.insertMention(activeQuery.start, activeQuery.end, member);
    editor.current?.focus();
  }

  function pickSkill(skill: SkillOption) {
    if (!activeQuery) return;
    const next = insertSkill(draft, activeQuery, skill.name);
    setQuery(null);
    setActiveIndex(0);
    editor.current?.setMarkdown(next.text, next.caret);
    editor.current?.focus();
  }

  /**
   * 有附件时把正文与文件一起交给上层投递；上层回 true 才清空输入区。
   * 没有附件（或上层没给带附件回调）时保持原来的 onSubmit 路径不变。
   */
  async function send(body: string) {
    if (!onSubmitWithAttachments || attachments.length === 0) {
      onSubmit();
      return;
    }
    const sent = await onSubmitWithAttachments({ body, attachments });
    if (!sent) return;
    setAttachments([]);
    setFileError(null);
  }

  /** 本地预检用契约里的上限：能收的收下，超限的挑出来报一条人话错误；服务端仍会再拒一次。 */
  function pickable(list: readonly File[]): { accepted: File[]; error: string | null } {
    const accepted: File[] = [];
    const rejected: string[] = [];
    const room = ATTACHMENT_MAX_PER_MESSAGE - attachments.length;
    const perFileMb = Math.round(ATTACHMENT_MAX_BYTES / ATTACHMENT_MEGABYTE);
    const totalMb = Math.round(ATTACHMENT_MAX_TOTAL_BYTES / ATTACHMENT_MEGABYTE);
    let total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
    for (const file of list) {
      if (accepted.length >= room) {
        rejected.push(`${file.name}（一条消息最多 ${ATTACHMENT_MAX_PER_MESSAGE} 个）`);
        continue;
      }
      if (file.size === 0) {
        rejected.push(`${file.name}（空文件）`);
        continue;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        rejected.push(`${file.name}（单个上限 ${perFileMb} MB）`);
        continue;
      }
      if (total + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
        rejected.push(`${file.name}（总量上限 ${totalMb} MB）`);
        continue;
      }
      total += file.size;
      accepted.push(file);
    }
    return { accepted, error: rejected.length > 0 ? `未添加：${rejected.join("、")}` : null };
  }

  function attach(list: readonly File[]) {
    setDragging(false);
    if (list.length === 0) return;
    const { accepted, error } = pickable(list);
    setFileError(error);
    if (accepted.length === 0) return;
    setAttachments((current) => [
      ...current,
      ...accepted.map((file) => {
        const url = URL.createObjectURL(file);
        urls.current.push(url);
        return { localId: nextLocalId(), file, url };
      }),
    ]);
  }

  function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const element = event.currentTarget;
    attach([...(element.files ?? [])]);
    // 清空 value：同一个文件可以被再次选中，选择器也不记住上次的结果。
    element.value = "";
  }

  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function dragLeave(event: DragEvent<HTMLFormElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    const list = event.dataTransfer?.files;
    if (!list || list.length === 0) return;
    event.preventDefault();
    setDragging(false);
    attach([...list]);
  }

  /** 「标签」：在光标处插一条对该附件的引用，插完光标落回 token 之后。 */
  function insertReference(localId: string) {
    const at = caret ?? draft.length;
    setQuery(null);
    setActiveIndex(0);
    editor.current?.insertAttachment(at, at, localId, names.get(localId) ?? "附件");
  }

  /** 「×」：附件下线，草稿里该附件的全部引用 token 一并删掉，光标不跳到别处。 */
  function removeAttachment(localId: string) {
    const removed = attachments.find((attachment) => attachment.localId === localId);
    if (removed) {
      URL.revokeObjectURL(removed.url);
      urls.current = urls.current.filter((url) => url !== removed.url);
    }
    setAttachments((current) => current.filter((attachment) => attachment.localId !== localId));
    // 引用是文档里的原子节点，整段删除由编辑器在 markdown 坐标上完成。
    editor.current?.removeAttachment(localId);
  }

  /** 点开查看：本地预览直接在浏览器里开，不经过服务端。 */
  function openAttachment(localId: string) {
    const attachment = attachments.find((item) => item.localId === localId);
    if (attachment) window.open(attachment.url, "_blank", "noopener");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || pending) return;
    void send(draft);
  }

  function keydown(event: KeyboardEvent): boolean {
    // 中文输入法组合中的按键属于上屏，既不选成员也不发送。
    if (event.isComposing) return false;
    if (open) {
      if (event.key === "Escape") {
        event.preventDefault();
        setQuery(null);
        return true;
      }
      if (count > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((current) => (current + 1) % count);
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((current) => (current - 1 + count) % count);
          return true;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (activeQuery?.kind === "skill") {
            const skill = skillMatches[active];
            if (skill) pickSkill(skill);
          } else {
            const member = matches[active];
            if (member) pick(member);
          }
          return true;
        }
      }
    }
    if (event.key !== "Enter") return false;
    // Enter 与 Cmd/Ctrl+Enter 发送；Shift+Enter 换行（交给编辑器插硬换行）。
    if (event.shiftKey) return false;
    event.preventDefault();
    if (!canSend || pending) return false;
    void send(editor.current?.markdown() ?? draft);
    return true;
  }

  return (
    <div className="shrink-0 px-6 pt-2.5 pb-3.5 max-desktop:px-3 max-desktop:pt-2.25 max-desktop:pb-[max(9px,env(safe-area-inset-bottom))]">
      <form
        onSubmit={submit}
        aria-busy={pending || undefined}
        onDragOver={dragOver}
        onDragLeave={dragLeave}
        onDrop={drop}
        className="relative rounded-container border border-input bg-background p-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring max-desktop:p-2.5"
      >
        <input
          ref={files}
          type="file"
          multiple
          className="hidden"
          data-testid="attachment-input"
          onChange={pickFiles}
        />
        {open && activeQuery?.kind === "skill" && (
          <SkillPicker
            listId={listId}
            matches={skillMatches}
            state={skills.state}
            activeIndex={active}
            onPick={pickSkill}
            onActive={setActiveIndex}
          />
        )}
        {open && activeQuery?.kind === "mention" && (
          <MentionPicker
            listId={listId}
            label="可以 @ 的成员"
            matches={matches}
            activeIndex={active}
            onPick={pick}
            onActive={setActiveIndex}
          />
        )}
        <AttachmentBar
          attachments={attachments}
          onRemove={removeAttachment}
          onInsertReference={insertReference}
          onOpen={openAttachment}
        />
        <label className="sr-only" htmlFor="message-draft">
          发给{agentName}的消息
        </label>
        {/* 输入区自己排版：草稿就是 markdown，附件与技能是文档里的原子芯片。 */}
        <div className="relative px-[7px] text-xs leading-6 max-desktop:text-[13px]">
          {draft.length === 0 && (
            <span
              aria-hidden="true"
              data-testid="message-placeholder"
              className="pointer-events-none absolute inset-0 text-muted-foreground"
            >
              {runActive ? "继续补充上下文，追加到当前轮…" : `向${agentName}发送消息…`}
            </span>
          )}
          <ComposerEditor
            value={draft}
            caret={caret}
            mentions={members}
            labelFor={(localId) => names.get(localId) ?? "附件"}
            readOnly={false}
            dragging={dragging}
            listId={listId}
            expanded={open}
            activeOptionId={open && active >= 0 ? mentionOptionId(listId, active) : undefined}
            canGrow={(length) => length <= MESSAGE_MAX_LENGTH}
            onValueChange={change}
            onKeyDown={keydown}
            onFiles={attach}
            onBlur={() => setQuery(null)}
            onHandle={attachEditor}
          />
        </div>
        <div className="mt-2.25 flex items-center justify-between gap-1.5 max-desktop:flex-wrap">
          {/* 这一行只说输入区自己的语义：Agent 名在页头与 placeholder 里，run 状态在页头徽标里。 */}
          {(runActive || runStatusLabel === "已停止") && (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Icon as={runActive ? CornerDownLeft : MessageSquare} size={12} />
              {runActive ? "追加到当前轮" : "已停止，可开始新一轮"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="attachment-add"
              aria-label="添加附件"
              title="添加附件"
              onClick={() => files.current?.click()}
            >
              <Icon as={Plus} />
            </Button>
            {runActive && onStop && (
              <Button
                type="button"
                variant="secondary"
                data-testid="run-stop"
                disabled={stopping}
                loading={stopping}
                onClick={onStop}
              >
                {stopping ? "正在停止…" : "停止"}
              </Button>
            )}
            <Button
              type="submit"
              data-testid="message-send"
              disabled={!canSend}
              loading={pending}
              aria-label={pending ? "发送中" : runActive ? "追加消息" : "发送消息"}
            >
              {pending ? "发送中" : runActive ? "追加" : "发送"}
            </Button>
          </div>
        </div>
      </form>
      {fileError && (
        <p
          role="alert"
          data-testid="attachment-error"
          className="mt-1 flex items-start gap-1.5 text-sm text-destructive"
        >
          <Icon as={AlertTriangle} size={14} className="mt-0.5 shrink-0" />
          {fileError}
        </p>
      )}
      {fieldErrors.body && <FieldError errors={fieldErrors} name="body" />}
      {error && <ChatErrorNotice error={error} testId="message-error" />}
      {stopError && <ChatErrorNotice error={stopError} testId="run-stop-error" />}
    </div>
  );
}
