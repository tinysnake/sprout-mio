import type {
  ChatContinuationCommand,
  ChatContinuationView,
} from "../../contracts/chat-continuation";
import type { ChatContinuationErrorCode } from "../../contracts/chat-continuation";

export type ContinuationAction = ChatContinuationCommand["action"];
export type ContinuationDenial = { code: ChatContinuationErrorCode; reason: string };
export type ContinuationDenials = Partial<Record<ContinuationAction, ContinuationDenial>>;

/** Page adapter only. The service supplies authorization and the complete frozen read view. */
export type ContinuationPageData = {
  view: ChatContinuationView;
  denials: ContinuationDenials;
};
export type ContinuationCommandResult =
  | { ok: true; data: ContinuationPageData }
  | { ok: false; error: ContinuationDenial & { requestId?: string } };
export type ContinuationSubmit = (
  command: ChatContinuationCommand,
) => Promise<ContinuationCommandResult>;

export const CONTINUATION_UNAVAILABLE = {
  code: "wake_provider_unavailable",
  reason: "对话接续读取与控制服务尚未接入，当前状态未知。",
} satisfies ContinuationDenial;
