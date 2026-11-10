declare const verifiedIdentity: unique symbol;
declare const verifiedEvent: unique symbol;
declare const localEpoch: unique symbol;

/** 只能由完成平台边界核验的 adapter 构造；不包含外部自报的 Sprout 身份。 */
export type VerifiedFeishuIdentity = Readonly<{
  appId: string;
  tenantKey: string;
  openId: string;
  [verifiedIdentity]: true;
}>;

/** 时间必须来自核验过的平台消息创建时间，单位毫秒。 */
export type VerifiedFeishuEvent = Readonly<{
  identity: VerifiedFeishuIdentity;
  messageId: string;
  chatType: string;
  messageType: string;
  body?: string;
  createdAtMs?: number;
  [verifiedEvent]: true;
}>;

export type FeishuEpoch = Readonly<{
  id: string;
  appId: string;
  [localEpoch]: true;
}>;

export type FeishuAdmissionScope = Readonly<{
  projectId: string;
  routeId: string;
  revision: number;
  epoch: FeishuEpoch;
}>;

export type FeishuTarget = Readonly<{ projectId: string; chatId: string }>;
export type FeishuBinding = {
  revision: number;
  bound: boolean;
  route?: FeishuTarget & { id: string };
};
export type FeishuAdmission =
  | { status: "accepted"; messageId: string; duplicate: boolean }
  | {
      status: "rejected";
      reason:
        | "unsupported_input"
        | "untrusted_timestamp"
        | "pre_epoch_message"
        | "pre_route_message"
        | "inactive_epoch"
        | "inactive_route"
        | "identity_mismatch"
        | "receipt_scope_mismatch"
        | "target_unavailable";
    };
