/** 固定前缀避免调用方为同一对象发明不同标记。 */
export const ID_PREFIXES = {
  project: "prj",
  machine: "mch",
  execution: "exe",
  run: "run",
  leaseMutation: "lmu",
  leaseEscrow: "les",
  leaseGrant: "lgr",
  remoteToolGrant: "rtg",
  mcpRegistration: "mrg",
  mcpProcess: "mpr",
  mcpSession: "mcs",
  mcpFrame: "mcf",
  agentProfile: "agp",
  task: "tsk",
  taskChecklistItem: "tci",
  taskEvent: "tev",
  chat: "cnv",
  instance: "ins",
  message: "msg",
  attachment: "att",
  diagnostic: "diag",
  boot: "boot",
  request: "req",
  cancellation: "cnl",
  notice: "ntc",
  repoCheckout: "rco",
  repoProvenance: "rpn",
  delegation: "dlg",
  delegationEvent: "dge",
  delegationDelivery: "ddv",
  delegationResult: "drs",
  webhookRule: "whr",
  webhookTrigger: "wht",
  feishuRoute: "fsr",
  feishuEpoch: "fse",
} as const;
/** 前缀只允许已登记的对象类别。 */
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
/** 前缀在类型中保留，避免混用不同类别的生成结果。 */
export type AppId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;
/**
 * 随机段 8 位 hex：Prod 最大一族（diagnostic）约 9e3 行，单次插入撞上已存在 id 的概率是 2e-6。
 * 校验上限留到 16 位，将来加长 id 只需要改这里，不用再迁一次数据。
 */
const SHORT_ID_HEX = 8;
const SHORT_ID_HEX_MAX = 16;
/** 不带锚点的匹配片段，供复合 id（如 membership 台账键）拼进更大的正则。 */
export function appIdSource(prefix: IdPrefix): string {
  return `${prefix}_[0-9a-f]{${SHORT_ID_HEX},${SHORT_ID_HEX_MAX}}`;
}
/** 与 newId 一致的前缀加随机段格式，供所有运行时边界复用。 */
export function appIdPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${appIdSource(prefix)}$`);
}
/**
 * 全文随机 id。安全上下文（HTTPS、localhost）直接用 randomUUID；局域网 HTTP 这类不安全上下文里
 * 浏览器不提供 randomUUID，用 getRandomValues 自己拼一个 v4，避免整条 UI 路径直接抛错。
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newId<P extends IdPrefix>(prefix: P): AppId<P> {
  return `${prefix}_${randomUuid().replaceAll("-", "").slice(0, SHORT_ID_HEX)}`;
}
