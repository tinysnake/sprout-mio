import { useState } from "react";
import type { AppError } from "../../contracts/result";
import type {
  ExecutionLogFrame,
  ExecutionLogReadView,
  ExecutionView,
} from "../../contracts/remote";
import { EXECUTION_LOG_READ_LIMIT_MAX_BYTES } from "../../contracts/remote";
import { Button } from "../ui/button";
import { StatusLine } from "./machine-list";
import {
  LOG_STATE_LABELS,
  isIncompleteLogState,
  type ExecutionLogReader,
  type LogConnection,
} from "./presentation";

const toneText = {
  success: "text-status-success",
  warning: "text-status-warning",
  muted: "text-muted-foreground",
  danger: "text-status-failed",
} as const;

/** 缺口行没有正文；`text: null` 是缺口的唯一表达，不是空输出。 */
export type LogRow =
  | { kind: "frame"; sequence: number; stream: ExecutionLogFrame["stream"]; text: string }
  | { kind: "gap"; fromSequence: number; toSequence: number };

/**
 * 把一页读视图铺成行：帧按序排，缺口按 `gapRanges` 插到对应位置。
 * 只排列已有事实，不补空行、不推断缺失内容。
 */
export function logRows(view: ExecutionLogReadView): LogRow[] {
  const rows: LogRow[] = [];
  // 缺口行（`text: null`）与 `gapRanges` 可能描述同一段缺失：同一序号只出现一次。
  const gapSequences = new Set(
    view.frames.filter((frame) => frame.text === null).map((frame) => frame.sequence),
  );
  for (const gap of view.gapRanges) {
    rows.push({ kind: "gap", fromSequence: gap.fromSequence, toSequence: gap.toSequence });
  }
  for (const frame of view.frames) {
    if (frame.text === null) {
      if (!gapSequences.has(frame.sequence))
        rows.push({ kind: "gap", fromSequence: frame.sequence, toSequence: frame.sequence });
      continue;
    }
    rows.push({ kind: "frame", sequence: frame.sequence, stream: frame.stream, text: frame.text });
  }
  const start = (row: LogRow) => (row.kind === "gap" ? row.fromSequence : row.sequence);
  return rows.sort((left, right) => start(left) - start(right));
}

/** 三个位点各自的含义不同，不能合成一个「进度」。 */
export function cursorFacts(view: ExecutionLogReadView): string[] {
  const produced = view.producedThroughSequence;
  const acknowledged = view.acknowledgedThroughSequence;
  const available = view.availableFromSequence;
  return [
    `已产出到 ${produced === null ? "无记录" : `#${produced}`}`,
    `Worker 已确认到 ${acknowledged === null ? "无记录" : `#${acknowledged}`}`,
    `可读起点 ${available === null ? "无记录" : `#${available}`}`,
  ];
}

/** 续读游标：能继续读时给下一序号，读到尾时明确说明没有更多可读区段。 */
export function resumeFacts(view: ExecutionLogReadView): {
  canContinue: boolean;
  text: string;
} {
  const next = view.nextCursor.nextSequence;
  const produced = view.producedThroughSequence;
  const canContinue = produced !== null && next <= produced;
  return {
    canContinue,
    text: canContinue
      ? `下一游标 #${next}`
      : `没有更多可读区段（下一游标 #${next}，已产出到 ${
          produced === null ? "无记录" : `#${produced}`
        }）`,
  };
}

/**
 * 执行日志：只在显式点击后读一页，不自动轮询、不自动续读到尾。
 * `logState` 与三个位点始终与行一起显示，避免把「不完整」看成「没有输出」。
 */
export function ExecutionLogViewer({
  execution,
  read,
  connection,
  dense = false,
  testId = "execution-log",
}: {
  execution: ExecutionView;
  read: ExecutionLogReader | undefined;
  connection: LogConnection;
  /** 只读掠影（inspector、设置页）：状态与位点照常显示，不铺读取控件。 */
  dense?: boolean;
  testId?: string;
}) {
  const [view, setView] = useState<ExecutionLogReadView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const stateLabel = LOG_STATE_LABELS[view?.logState ?? execution.logState];
  const incomplete = view
    ? isIncompleteLogState(view.logState)
    : isIncompleteLogState(execution.logState);

  async function load(cursor: { nextSequence: number } | null) {
    if (!read || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await read({
        executionId: execution.executionId,
        cursor,
        limitBytes: EXECUTION_LOG_READ_LIMIT_MAX_BYTES,
      });
      if (result.ok) setView(result.data);
      else setError(result.error);
    } catch (cause) {
      setError({
        code: "execution_log_unavailable",
        message: cause instanceof Error ? "读取日志失败，未收到可读区段。" : "读取日志失败。",
        requestId: "unavailable",
      });
    } finally {
      setPending(false);
    }
  }

  const rows = view ? logRows(view) : [];
  const resume = view ? resumeFacts(view) : null;

  return (
    <div data-testid={testId} className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <StatusLine label={stateLabel.label} tone={stateLabel.tone} testId={`${testId}-state`} />
        <span className="text-[0.6875rem] text-muted-foreground">
          {view ? "读取时间点的一页" : "尚未读取"}
        </span>
      </div>
      <p data-testid={`${testId}-state-detail`} className="text-xs leading-6 text-muted-foreground">
        {stateLabel.detail}
      </p>
      {/*
        不完整必须显示为不完整：`partial` / `gap` / `truncated` 各自点名，
        即使一页里一行正文都没有，也不写成「没有输出」。
      */}
      {incomplete && (
        <p data-testid={`${testId}-incomplete`} className={toneText.warning}>
          当前日志不完整，已显示的部分不是完整输出。
        </p>
      )}
      {!connection.online && (
        <p data-testid={`${testId}-offline`} className={toneText.danger}>
          与 Worker 的连接已断开：以下是断开前已知的日志事实，位点不会因为断线而前进。
          {connection.detail ? ` ${connection.detail}` : ""}
        </p>
      )}
      <ul data-testid={`${testId}-cursors`} className="space-y-0.5 text-xs text-muted-foreground">
        {cursorFacts(view ?? logFactsFallback(execution)).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {rows.length > 0 && (
        <ol
          data-testid={`${testId}-rows`}
          className="max-h-64 min-w-0 overflow-auto rounded-lg border border-border bg-card px-3 py-2 text-[0.6875rem] leading-5"
        >
          {rows.map((row) =>
            row.kind === "gap" ? (
              <li
                key={`gap:${row.fromSequence}`}
                data-testid={`${testId}-gap`}
                data-gap-from={row.fromSequence}
                className={`${toneText.warning} break-all`}
              >
                #${row.fromSequence}
                {row.toSequence === row.fromSequence ? "" : `–#${row.toSequence}`} 行缺失，内容未知
              </li>
            ) : (
              <li
                key={`frame:${row.sequence}`}
                data-testid={`${testId}-frame`}
                data-stream={row.stream}
                className="min-w-0 whitespace-pre-wrap break-all"
              >
                <span className="text-muted-foreground">
                  #{row.sequence} {row.stream === "stderr" ? "err" : "out"}{" "}
                </span>
                {row.text}
              </li>
            ),
          )}
        </ol>
      )}
      {view && rows.length === 0 && (
        <p data-testid={`${testId}-empty-range`} className="text-xs text-muted-foreground">
          这一段范围内没有日志行。这只是一页的空范围，是否完整由上面的日志状态决定。
        </p>
      )}
      {error && (
        <p data-testid={`${testId}-error`} className={toneText.danger}>
          {error.message}
          {error.code === "execution_log_gap"
            ? " 请从新的可读起点重新读取，不静默续读。"
            : error.code === "execution_log_cursor_stale"
              ? " 游标已过期，请从最新一页重新开始。"
              : ""}
        </p>
      )}
      {dense ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid={`${testId}-load`}
            loading={pending}
            disabled={!read || pending}
            onClick={() => void load(null)}
          >
            读取日志
          </Button>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid={`${testId}-resume`}
            disabled={!read || pending || !view || !resume?.canContinue}
            onClick={() => view && void load({ nextSequence: view.nextCursor.nextSequence })}
          >
            从游标续读
          </Button>
          {resume && (
            <span
              data-testid={`${testId}-next-cursor`}
              className="text-[0.6875rem] text-muted-foreground"
            >
              {resume.text}
            </span>
          )}
        </div>
      )}
      {!read && !dense && (
        <p data-testid={`${testId}-unavailable`} className="text-[0.6875rem] text-muted-foreground">
          日志读取入口尚未接入服务端，此处只显示已知位点；接入后可从游标继续读取。
        </p>
      )}
    </div>
  );
}

/** 还没读时，位点取执行视图上的权威值，界面不自己推一个进度。 */
function logFactsFallback(execution: ExecutionView): ExecutionLogReadView {
  return {
    projectId: execution.projectId,
    machineId: execution.machineId,
    executionId: execution.executionId,
    frames: [],
    nextCursor: { nextSequence: 1 },
    availableFromSequence: execution.availableFromSequence,
    acknowledgedThroughSequence: execution.acknowledgedThroughSequence,
    producedThroughSequence: execution.producedThroughSequence,
    gapRanges: [],
    logState: execution.logState,
    workerOnline: false,
  };
}
