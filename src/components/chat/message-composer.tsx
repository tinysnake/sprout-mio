import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  Ref,
} from "react";
import { AlertTriangle, CornerDownLeft, MessageSquare, Paperclip, Plus } from "lucide-react";
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
import {
  insertAttachmentToken,
  removeAttachmentReferences,
  splitComposerSegments,
} from "./composer-markdown";
import type { ComposerTone } from "./composer-markdown";
import "./composer-markdown.css";
import { SkillMark } from "./skill-mark";
import { SkillPicker } from "./skill-picker";
import {
  MentionPicker,
  insertMention,
  matchMembers,
  mentionOptionId,
  mentionQueryAt,
} from "./mention-picker";
import type { MentionMember, MentionQuery } from "./mention-picker";

export const MESSAGE_MAX_LENGTH = 8000;

/** 附件预检的数字取契约里那份常量（src/contracts/attachment.ts），客户端不另写一套。 */
const ATTACHMENT_MEGABYTE = 1024 * 1024;

/** 装饰类名按 tone 查表：这些样式只改颜色、透明度或假粗体，不动字形前进宽度。 */
const TONE_CLASS: Record<ComposerTone, string | undefined> = {
  plain: undefined,
  strong: "composer-md-strong",
  emphasis: "composer-md-emphasis",
  code: "composer-md-code",
  heading: "composer-md-heading",
  marker: "composer-md-marker",
  reference: undefined,
};

let localIdCounter = 0;

/** 附件本地 id 只在本条消息内有效：服务端落库时按它把正文里的引用换成真实附件 id。 */
function nextLocalId(): string {
  localIdCounter += 1;
  return `local-${Date.now().toString(36)}-${localIdCounter.toString(36)}`;
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
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const canSend = draft.trim().length > 0;
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const [query, setQuery] = useState<(MentionQuery & { kind: "mention" | "skill" }) | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [composingVisual, setComposingVisual] = useState(false);
  const highlight = useRef<HTMLDivElement | null>(null);
  const composerSegments = useMemo(() => splitComposerSegments(draft), [draft]);
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

  const attachInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textarea.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );

  // 插入后光标落在名字之后：等新正文提交到 DOM 再定位，不整段重置到尾。
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const element = textarea.current;
    if (caret === null || !element) return;
    pendingCaret.current = null;
    element.setSelectionRange(caret, caret);
  });

  /** 按光标前的正文同步候选区间；同一区间不产生多余渲染。 */
  function sync(element: HTMLTextAreaElement) {
    const caret = element.selectionStart ?? element.value.length;
    const skill = skillQueryAt(element.value, caret);
    const mention = skill ? null : mentionQueryAt(element.value, caret);
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

  function change(event: ChangeEvent<HTMLTextAreaElement>) {
    const element = event.currentTarget;
    onDraftChange(element.value);
    // 组合期间不打开也不重算候选，上屏后再按最终正文同步。
    if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
    sync(element);
  }

  function pick(member: MentionMember) {
    const element = textarea.current;
    if (!element || !activeQuery) return;
    const next = insertMention(element.value, activeQuery, member.name);
    pendingCaret.current = next.caret;
    setQuery(null);
    setActiveIndex(0);
    onDraftChange(next.value);
    element.focus();
  }

  function pickSkill(skill: SkillOption) {
    const element = textarea.current;
    if (!element || !activeQuery) return;
    const next = insertSkill(element.value, activeQuery, skill.name);
    pendingCaret.current = next.caret;
    setQuery(null);
    setActiveIndex(0);
    onDraftChange(next.text);
    element.focus();
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

  /** 粘贴文件时接管这次输入：二进制不该被当文本插进草稿。 */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const list = event.clipboardData?.files;
    if (!list || list.length === 0) return;
    event.preventDefault();
    attach([...list]);
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
    const element = textarea.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    const next = insertAttachmentToken(draft, { start, end }, localId);
    pendingCaret.current = next.caret;
    setQuery(null);
    setActiveIndex(0);
    onDraftChange(next.text);
    element?.focus();
  }

  /** 「×」：附件下线，草稿里该附件的全部引用 token 一并删掉，光标不跳到别处。 */
  function removeAttachment(localId: string) {
    const caret = textarea.current?.selectionStart ?? draft.length;
    const next = removeAttachmentReferences(draft, localId, caret);
    const removed = attachments.find((attachment) => attachment.localId === localId);
    if (removed) {
      URL.revokeObjectURL(removed.url);
      urls.current = urls.current.filter((url) => url !== removed.url);
    }
    setAttachments((current) => current.filter((attachment) => attachment.localId !== localId));
    if (next.removed > 0) {
      pendingCaret.current = next.caret;
      onDraftChange(next.text);
    }
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

  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法组合中的按键属于上屏，既不选成员也不发送。
    if (composing.current || event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "Escape") {
        event.preventDefault();
        setQuery(null);
        return;
      }
      if (count > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((current) => (current + 1) % count);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((current) => (current - 1 + count) % count);
          return;
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
          return;
        }
      }
    }
    if (event.key !== "Enter") return;
    // Enter 与 Cmd/Ctrl+Enter 发送；Shift+Enter 换行。
    if (event.shiftKey) return;
    event.preventDefault();
    if (!canSend || pending) return;
    void send(draft);
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
        {/* 技能标记的负外边距、引用芯片的绝对定位都落在输入区内，不被 overflow 裁掉。 */}
        <div className="relative -mx-[7px]">
          <div
            ref={highlight}
            aria-hidden="true"
            data-testid="message-input-highlight"
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words px-[7px] text-xs leading-6 max-desktop:text-[13px] ${
              composingVisual ? "invisible" : ""
            } ${dragging ? "rounded-control outline-2 outline-dashed outline-ring" : ""}`}
          >
            {composerSegments.map((segment, index) =>
              segment.skill ? (
                <SkillMark
                  key={index}
                  name={segment.skill.name}
                  text={segment.text}
                  edge={segment.skillEdge}
                />
              ) : segment.localId !== undefined ? (
                // 引用沿用 skill-mark 的手法：原文留在文本流里撑宽度（透明），芯片绝对定位压上去。
                <span key={index} className="composer-ref" data-attachment-local-id={segment.localId}>
                  <span className="composer-ref-raw">{segment.text}</span>
                  <span className="composer-ref-chip" aria-hidden="true">
                    <Icon as={Paperclip} size={12} className="shrink-0" />
                    <span className="composer-ref-name">
                      {names.get(segment.localId ?? "") ?? "附件"}
                    </span>
                  </span>
                </span>
              ) : (
                <span key={index} className={TONE_CLASS[segment.tone]}>
                  {segment.text}
                </span>
              ),
            )}
          </div>
          <textarea
            ref={attachInput}
            id="message-draft"
            name="body"
            data-testid="message-input"
            value={draft}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={
              open && active >= 0 ? mentionOptionId(listId, active) : undefined
            }
            aria-haspopup="listbox"
            onChange={change}
            onKeyDown={keydown}
            onScroll={(event) => {
              const element = highlight.current;
              if (element) element.scrollTop = event.currentTarget.scrollTop;
            }}
            onSelect={() => {
              const element = textarea.current;
              if (!element || composing.current) return;
              sync(element);
            }}
            onPaste={paste}
            onBlur={() => setQuery(null)}
            onCompositionStart={() => {
              composing.current = true;
              setComposingVisual(true);
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              setComposingVisual(false);
              sync(event.currentTarget);
            }}
            maxLength={MESSAGE_MAX_LENGTH}
            rows={2}
            placeholder={runActive ? "继续补充上下文，追加到当前轮…" : `向${agentName}发送消息…`}
            className={`relative block h-12.5 w-full resize-none border-0 bg-transparent px-[7px] py-0 text-xs leading-6 outline-none placeholder:text-muted-foreground max-desktop:h-12 max-desktop:text-[13px] ${
              composingVisual ? "text-foreground" : "text-transparent caret-foreground"
            }`}
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
