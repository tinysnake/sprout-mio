import { useState } from "react";
import type { FormEvent } from "react";
import { Pencil } from "lucide-react";
import { CHAT_TITLE_MAX_LENGTH, type Chat, type ChatResult } from "../../contracts/chat";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Field } from "../ui/field";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { ChatErrorNotice } from "./chat-error-notice";

/**
 * 对话标题的编辑入口。标题是人工命名的可选覆盖：可以留空恢复默认，
 * 默认展示回落到参与分身名。这里只做呈现与提交，归属与权限由服务端核对。
 *
 * 提交函数由调用方注入，因此正式路由接 server function，开发场景可以接
 * 本地回调，两边共用同一份界面和状态处理。
 */
export function ChatTitleEditor({
  chat,
  currentName,
  submit,
  restore,
  onChanged,
  variant = "icon",
}: {
  chat: Chat;
  /** 未命名时列表与标题栏显示的兜底名称（参与分身名）。 */
  currentName: string;
  submit: (title: string) => Promise<ChatResult<Chat>>;
  restore: () => Promise<ChatResult<Chat>>;
  onChanged: () => void;
  /**
   * `icon` 是 DM 消息头部的铅笔入口（P4b 形状）；`button` 是右栏治理段的
   * 文字入口，与「更改 Owner」同一行样式。两个入口共用同一套弹窗与提交。
   */
  variant?: "icon" | "button";
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<null | "save" | "restore">(null);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function change(next: boolean) {
    if (pending) return;
    if (next) {
      setError(null);
      setFieldErrors({});
    }
    setOpen(next);
  }

  async function apply(action: "save" | "restore", title: string) {
    if (pending) return;
    setPending(action);
    setError(null);
    setFieldErrors({});
    try {
      const result = action === "save" ? await submit(title) : await restore();
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setOpen(false);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entry = new FormData(event.currentTarget).get("title");
    const value = typeof entry === "string" ? entry : "";
    // 清空即恢复默认；空标题不写库，留空由 title 的 null 语义表达。
    if (value.trim().length === 0) return void apply("restore", "");
    return void apply("save", value.trim());
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      {variant === "button" ? (
        <DialogTrigger
          data-testid="chat-title-edit"
          data-governance-action="title_change"
          render={<Button type="button" variant="secondary" size="sm" />}
        >
          <Icon as={Pencil} size={13} />
          重命名
        </DialogTrigger>
      ) : (
        <DialogTrigger
          data-testid="chat-title-edit"
          aria-label="重命名对话"
          title="重命名对话"
          className="-my-1 flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-desktop:size-11"
        >
          <Icon as={Pencil} size={13} />
        </DialogTrigger>
      )}
      <DialogContent data-testid="chat-title-dialog">
        <DialogHeader>
          <DialogTitle>重命名对话</DialogTitle>
          <DialogDescription>
            当前显示：{chat.title?.trim() ? chat.title : `未命名，显示为「${currentName}」`}
            。留空保存即恢复默认，不会改动消息与分身。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} aria-busy={pending !== null} className="flex flex-col gap-4">
          <Field
            label="标题"
            htmlFor="chat-title-input"
            hint={`最多 ${CHAT_TITLE_MAX_LENGTH} 字，可留空。`}
            error={fieldErrors.title}
          >
            <Input
              id="chat-title-input"
              name="title"
              data-testid="chat-title-input"
              defaultValue={chat.title ?? ""}
              maxLength={CHAT_TITLE_MAX_LENGTH}
              disabled={pending !== null}
              autoComplete="off"
            />
          </Field>
          {error && <ChatErrorNotice error={error} testId="chat-title-error" />}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              data-testid="chat-title-cancel"
              disabled={pending !== null}
              onClick={() => change(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="chat-title-restore"
              disabled={pending !== null || !chat.title}
              loading={pending === "restore"}
              onClick={() => void apply("restore", "")}
            >
              恢复默认
            </Button>
            <Button
              type="submit"
              data-testid="chat-title-save"
              disabled={pending !== null}
              loading={pending === "save"}
            >
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
