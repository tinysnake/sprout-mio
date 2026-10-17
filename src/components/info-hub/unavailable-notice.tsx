/** 未实现的 Info Hub 视角必须显式呈现：说明依赖的阶段与事实，不能渲染成空列表、0 值或成功状态。 */
export function UnavailableNotice({
  testId,
  title,
  reason,
}: {
  testId: string;
  title: string;
  reason: string;
}) {
  return (
    <section data-testid={testId} className="space-y-1 rounded-lg border border-dashed px-4 py-3">
      <p className="text-sm font-medium">
        {title}
        <span data-testid={`${testId}-badge`} className="ml-2 text-xs text-muted-foreground">
          未实现
        </span>
      </p>
      <p data-testid={`${testId}-reason`} className="text-sm text-muted-foreground">
        {reason}
      </p>
    </section>
  );
}
