/** 固定前缀避免调用方为同一对象发明不同标记。 */
export const ID_PREFIXES = {
  project: "prj",
  diagnostic: "diag",
  boot: "boot",
  request: "req",
} as const;
/** 前缀只允许已登记的对象类别。 */
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
/** 前缀在类型中保留，避免混用不同类别的生成结果。 */
export type AppId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;
export function newId<P extends IdPrefix>(prefix: P): AppId<P> {
  return `${prefix}_${crypto.randomUUID()}`;
}
