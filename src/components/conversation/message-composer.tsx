import { useState } from "react";
import type { FormEvent } from "react";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { sendMessageFn } from "../../server/functions/conversation";
import { Button } from "../ui/button";
import { FieldError, ResultError } from "../project/result-error";

/** 只发送当前登录者身份的 human 消息，成功后交给路由重新取数而不是本地插入。 */
export function MessageComposer({
  conversationId,
  onSent,
}: {
  conversationId: string;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await sendMessageFn({ data: { conversationId, body } });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setBody("");
      onSent();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={pending} className="space-y-3">
      <label className="block text-sm">
        以你的身份发送消息
        <textarea
          name="body"
          data-testid="message-input"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={8000}
          placeholder="输入消息…"
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2"
        />
        <FieldError errors={fieldErrors} name="body" />
      </label>
      {error && <ResultError error={error} testId="message-error" />}
      <Button type="submit" data-testid="message-send" disabled={pending}>
        {pending ? "正在发送…" : "发送"}
      </Button>
    </form>
  );
}
