/** 固定前缀避免调用方为同一对象发明不同标记。 */
export const ID_PREFIXES = {
  project: "prj",
  machine: "mch",
  agentProfile: "agp",
  projectMember: "pmb",
  chat: "cnv",
  instance: "ins",
  message: "msg",
  diagnostic: "diag",
  boot: "boot",
  request: "req",
} as const;
/** 前缀只允许已登记的对象类别。 */
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
/** 前缀在类型中保留，避免混用不同类别的生成结果。 */
export type AppId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;
/** 与 newId 一致的前缀 UUID v4 格式，供所有运行时边界复用。 */
export function appIdPattern(prefix: IdPrefix): RegExp {
  return new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
  );
}
export function newId<P extends IdPrefix>(prefix: P): AppId<P> {
  return `${prefix}_${crypto.randomUUID()}`;
}
