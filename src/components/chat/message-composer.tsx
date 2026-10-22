import type { FormEvent, KeyboardEvent, Ref } from "react";
import { CornerDownLeft, MessageSquare } from "lucide-react";
import type { FieldErrors } from "../../contracts/project";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { FieldError, ResultError } from "../project/result-error";

export const MESSAGE_MAX_LENGTH = 8000;

/**
 * 输入区：发送、追加与停止都在这里。运行中发送的语义是追加到当前轮，
 * 文案与提交动作都随状态变化，未投递的输入由 run 状态区另行提示。
 */
export function MessageComposer({
  agentName,
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || pending) return;
    onSubmit();
  }

  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!canSend || pending) return;
    onSubmit();
  }

  return (
    <div className="shrink-0 px-6 pt-2.5 pb-3.5 max-desktop:px-3 max-desktop:pt-2.25 max-desktop:pb-[max(9px,env(safe-area-inset-bottom))]">
      <form
        onSubmit={submit}
        aria-busy={pending || undefined}
        className="rounded-container border border-input bg-background p-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring max-desktop:p-2.5"
      >
        <label className="sr-only" htmlFor="message-draft">
          发给{agentName}的消息
        </label>
        <textarea
          ref={inputRef}
          id="message-draft"
          name="body"
          data-testid="message-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={keydown}
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
              : `${agentName} · ${runStatusLabel === "已停止" ? "开始新一轮" : "准备就绪"}`}
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
      {error && <ResultError error={error} testId="message-error" />}
      {stopError && <ResultError error={stopError} testId="run-stop-error" />}
      <p className="mt-2 text-center text-[9px] text-muted-foreground">
        Project 的信息与分析依据，会随 Chat 一起保留。
      </p>
    </div>
  );
}
