/** Vite 的 CSS 查询参数。用 `?raw`：vitest 默认不处理 CSS，`?inline` 会拿到空串。 */
declare module "*.css?raw" {
  const css: string;
  export default css;
}
