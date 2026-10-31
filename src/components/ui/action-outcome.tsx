export type ActionOutcome = "processing" | "success" | "failure" | "unknown" | null;
const labels = { processing: "处理中", success: "成功", failure: "失败", unknown: "未知" };
export function ActionOutcomeNotice({
  action,
  state,
  detail,
  testId,
}: {
  action: string;
  state: ActionOutcome;
  detail?: string;
  testId: string;
}) {
  if (!state) return null;
  return (
    <p
      role={state === "failure" ? "alert" : "status"}
      data-testid={testId}
      data-state={state}
      className="shrink-0 px-3 py-2 text-xs text-muted-foreground"
    >
      {action} · {labels[state]}
      {detail ? ` · ${detail}` : ""}
    </p>
  );
}
