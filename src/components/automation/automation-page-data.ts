import type { ChatAutomationCommand, ChatAutomationView } from "../../contracts/chat-automation";
import type { ChatAutomationErrorCode } from "../../contracts/chat-automation";

export type AutomationAction = ChatAutomationCommand["action"];
export type AutomationDenial = { code: ChatAutomationErrorCode; reason: string };
export type AutomationDenials = Partial<Record<AutomationAction, AutomationDenial>>;

/** Page adapter only. The service supplies authorization and the complete frozen read view. */
export type AutomationPageData = {
  view: ChatAutomationView;
  denials: AutomationDenials;
};
export type AutomationCommandResult =
  | { ok: true; data: AutomationPageData }
  | { ok: false; error: AutomationDenial & { requestId?: string } };
export type AutomationSubmit = (command: ChatAutomationCommand) => Promise<AutomationCommandResult>;

export const AUTOMATION_UNAVAILABLE = {
  code: "wake_provider_unavailable",
  reason: "自动接续读取与控制服务尚未接入，当前状态未知。",
} satisfies AutomationDenial;
