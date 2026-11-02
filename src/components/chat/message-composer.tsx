import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, Ref } from "react";
import { CornerDownLeft, MessageSquare } from "lucide-react";
import type { FieldErrors } from "../../contracts/project";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { FieldError } from "../project/result-error";
import { ChatErrorNotice } from "./chat-error-notice";
import {
  MentionPicker,
  insertMention,
  matchMembers,
  mentionOptionId,
  mentionQueryAt,
} from "./mention-picker";
import type { MentionMember, MentionQuery } from "./mention-picker";

export const MESSAGE_MAX_LENGTH = 8000;

/**
 * 输入区：发送、追加与停止都在这里。运行中发送的语义是追加到当前轮，
 * 文案与提交动作都随状态变化，未投递的输入由 run 状态区另行提示。
 */
export function MessageComposer({
  agentName,
  members,
  draft,
  onDraftChange,
  onSubmit,
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
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: AppError | null;
  fieldErrors: FieldErrors;
  /** 有排队中或运行中的 run：按钮变成追加，并出现停止。 */
  runActive: boolean;
  runStatusLabel: string;
  stopping: boolean;
  stopError: AppError | null;
  onStop: () => void;
  /** 未投递输入恢复到输入框后需要把焦点放回这里。 */
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const canSend = draft.trim().length > 0;
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // 草稿被外部改写（发送后清空、恢复未投递输入）时区间不再成立，浮层跟着关掉。
  const activeQuery =
    query && draft.slice(query.start, query.end) === `@${query.query}` ? query : null;
  const matches = useMemo(
    () => (activeQuery ? matchMembers(members, activeQuery.query) : []),
    [members, activeQuery],
  );
  const open = activeQuery !== null;
  const active = matches.length > 0 ? Math.min(activeIndex, matches.length - 1) : -1;

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
    const next = mentionQueryAt(element.value, element.selectionStart ?? element.value.length);
    setQuery((previous) =>
      previous &&
      next &&
      previous.start === next.start &&
      previous.end === next.end &&
      previous.query === next.query
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || pending) return;
    onSubmit();
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
      if (matches.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((current) => (current + 1) % matches.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((current) => (current - 1 + matches.length) % matches.length);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const member = matches[active];
          if (member) pick(member);
          return;
        }
      }
    }
    if (event.key !== "Enter") return;
    // Enter 与 Cmd/Ctrl+Enter 发送；Shift+Enter 换行。
    if (event.shiftKey) return;
    event.preventDefault();
    if (!canSend || pending) return;
    onSubmit();
  }

  return (
    <div className="shrink-0 px-6 pt-2.5 pb-3.5 max-desktop:px-3 max-desktop:pt-2.25 max-desktop:pb-[max(9px,env(safe-area-inset-bottom))]">
      <form
        onSubmit={submit}
        aria-busy={pending || undefined}
        className="relative rounded-container border border-input bg-background p-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring max-desktop:p-2.5"
      >
        {open && (
          <MentionPicker
            listId={listId}
            label="可以 @ 的成员"
            matches={matches}
            activeIndex={active}
            onPick={pick}
            onActive={setActiveIndex}
          />
        )}
        <label className="sr-only" htmlFor="message-draft">
          发给{agentName}的消息
        </label>
        <textarea
          ref={attachInput}
          id="message-draft"
          name="body"
          data-testid="message-input"
          value={draft}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? mentionOptionId(listId, active) : undefined}
          aria-haspopup="listbox"
          onChange={change}
          onKeyDown={keydown}
          onSelect={() => {
            const element = textarea.current;
            if (!element || composing.current) return;
            sync(element);
          }}
          onBlur={() => setQuery(null)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            sync(event.currentTarget);
          }}
          maxLength={MESSAGE_MAX_LENGTH}
          rows={2}
          placeholder={runActive ? "继续补充上下文，追加到当前轮…" : `向${agentName}发送消息…`}
          className="block h-12.5 w-full resize-none border-0 bg-transparent p-0 text-xs leading-6 text-foreground outline-none placeholder:text-muted-foreground max-desktop:h-12 max-desktop:text-[13px]"
        />
        <div className="mt-2.25 flex items-center justify-between gap-1.5 max-desktop:flex-wrap">
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Icon as={runActive ? CornerDownLeft : MessageSquare} size={12} />
            {runActive
              ? "追加到当前轮"
              : `${agentName} · ${runStatusLabel === "已停止" ? "已停止，可开始新一轮" : runStatusLabel || "运行状态暂不可用"}`}
          </span>
          <div className="flex items-center gap-2">
            {runActive && (
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
      {fieldErrors.body && <FieldError errors={fieldErrors} name="body" />}
      {error && <ChatErrorNotice error={error} testId="message-error" />}
      {stopError && <ChatErrorNotice error={stopError} testId="run-stop-error" />}
      <p className="mt-2 text-center text-[9px] text-muted-foreground">
        Project 的信息与分析依据，会随 Chat 一起保留。
      </p>
    </div>
  );
}
