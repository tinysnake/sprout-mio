import { createHash } from "node:crypto";
import { EXECUTION_LOG_FRAME_MAX_BYTES } from "../contracts/remote";

/** 日志帧按原始 UTF-8 bytes 切分；`bytes` 只承载可无损往返的文本，其余字节显式记为 gap。 */
export type LogStream = "stdout" | "stderr";
export type LogFrameDraft = {
  sequence: number;
  stream: LogStream;
  byteStart: number;
  byteEnd: number;
  checksum: string;
  bytes?: string;
  gapTo?: number;
};
type Segment = { start: number; end: number; text: string | null };
export type StreamGate = { pause(): void; resume(): void };

/** 待上行帧积压到高水位时暂停读取管道，让子进程承受真实背压，而不是丢弃未确认的帧。 */
const OUTBOX_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const OUTBOX_LOW_WATER_BYTES = 1024 * 1024;

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const continuation = (byte: number | undefined) =>
  byte !== undefined && byte >= 0x80 && byte <= 0xbf;
/** 单个码点的字节长度；`0` 表示不可承载（无效序列或 NUL），`-1` 表示等待更多字节。 */
function charLength(buffer: Buffer, index: number): number {
  const lead = buffer[index];
  if (lead === undefined) return -1;
  if (lead === 0) return 0;
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) {
    const next = buffer[index + 1];
    if (next === undefined) return -1;
    return continuation(next) ? 2 : 0;
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    const second = buffer[index + 1];
    if (second === undefined) return -1;
    if (
      !continuation(second) ||
      (lead === 0xe0 && second < 0xa0) ||
      (lead === 0xed && second > 0x9f)
    )
      return 0;
    if (buffer[index + 2] === undefined) return -1;
    return continuation(buffer[index + 2]) ? 3 : 0;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    const second = buffer[index + 1];
    if (second === undefined) return -1;
    if (
      !continuation(second) ||
      (lead === 0xf0 && second < 0x90) ||
      (lead === 0xf4 && second > 0x8f) ||
      !continuation(buffer[index + 2]) ||
      !continuation(buffer[index + 3])
    )
      return 0;
    return 4;
  }
  return 0;
}
/** 从 `start` 起最大的可承载前缀终点，最多 `limit`。不完整的码点留给下一批字节。 */
function frameEnd(buffer: Buffer, start: number, limit: number): number {
  let index = start;
  while (index < limit) {
    const length = charLength(buffer, index);
    if (length <= 0 || index + length > limit) return index;
    index += length;
  }
  return index;
}
/**
 * 按原始字节切段。`text === null` 的段是不可承载字节（无效 UTF-8、NUL 或末尾残字节），
 * 必须由调用方如实记为 gap。`final === false` 时保留末尾不完整码点等待下一批。
 */
export function sliceBuffer(buffer: Buffer, final: boolean): Segment[] {
  const segments: Segment[] = [];
  let position = 0;
  while (position < buffer.length) {
    const length = charLength(buffer, position);
    if (length === -1) {
      if (!final) break;
      segments.push({ start: position, end: buffer.length, text: null });
      break;
    }
    if (length > 0) {
      const end = frameEnd(
        buffer,
        position,
        Math.min(buffer.length, position + EXECUTION_LOG_FRAME_MAX_BYTES),
      );
      if (end > position) {
        segments.push({ start: position, end, text: buffer.toString("utf8", position, end) });
        position = end;
        continue;
      }
    }
    // 不可承载字节：跳到下一个可承载码点，或到末尾不完整码点的起点。
    let scan = position + 1;
    while (scan < buffer.length && charLength(buffer, scan) === 0) scan += 1;
    segments.push({ start: position, end: scan, text: null });
    position = scan;
  }
  return segments;
}
/** 单次执行的日志采集与未确认帧队列。sequence 跨 stdout 与 stderr 共享一个单调序。 */
export class ExecutionLog {
  private pending: Record<LogStream, Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  private offset: Record<LogStream, number> = { stdout: 0, stderr: 0 };
  private queue: LogFrameDraft[] = [];
  private produced = 0;
  private queuedBytes = 0;
  private paused = false;
  private gates: Partial<Record<LogStream, StreamGate>> = {};
  constructor(private readonly persist: (frame: LogFrameDraft) => void = () => {}) {}
  get producedThrough() {
    return this.produced;
  }
  get frames(): readonly LogFrameDraft[] {
    return this.queue;
  }
  get backlogBytes() {
    return this.queuedBytes;
  }
  /** 子进程管道建立后才挂背压闸门。 */
  bind(gates: Partial<Record<LogStream, StreamGate>>) {
    this.gates = gates;
    this.measure();
  }
  append(stream: LogStream, chunk: Buffer) {
    const buffer = Buffer.concat([this.pending[stream], chunk]);
    let consumed = 0;
    for (const segment of sliceBuffer(buffer, false)) {
      this.emit(stream, buffer, segment);
      consumed = segment.end;
    }
    this.pending[stream] = buffer.subarray(consumed);
    this.offset[stream] += consumed;
    this.measure();
  }
  /** 进程退出后调用：末尾残字节按 gap 记录，不静默丢弃。 */
  flush() {
    for (const stream of ["stdout", "stderr"] as const) {
      const buffer = this.pending[stream];
      if (buffer.length === 0) continue;
      for (const segment of sliceBuffer(buffer, true)) this.emit(stream, buffer, segment);
      this.pending[stream] = Buffer.alloc(0);
      this.offset[stream] += buffer.length;
    }
    this.measure();
  }
  /** 宿主只确认已落盘前缀；`availableFromSequence` 之前的帧已被宿主裁剪。 */
  acknowledge(through: number, availableFrom: number | null) {
    this.queue = this.queue.filter(
      (frame) =>
        frame.sequence > through && (availableFrom === null || frame.sequence >= availableFrom),
    );
    this.measure();
  }
  /** 重启后从 durable outbox 恢复未确认帧，序号与原位点不变。 */
  restore(frames: readonly LogFrameDraft[]) {
    for (const frame of frames) {
      this.queue.push(frame);
      this.produced = Math.max(this.produced, frame.sequence);
      this.offset[frame.stream] = Math.max(this.offset[frame.stream], frame.byteEnd);
    }
    this.measure();
  }
  private emit(stream: LogStream, buffer: Buffer, segment: Segment) {
    const sequence = ++this.produced;
    const frame: LogFrameDraft = {
      sequence,
      stream,
      byteStart: this.offset[stream] + segment.start,
      byteEnd: this.offset[stream] + segment.end,
      checksum: sha256(buffer.subarray(segment.start, segment.end)),
      ...(segment.text === null ? { gapTo: sequence } : { bytes: segment.text }),
    };
    this.queue.push(frame);
    try {
      this.persist(frame);
    } catch {
      // 落盘失败不终止正在运行的命令；帧仍在内存队列里等待上行。
    }
  }
  private measure() {
    this.queuedBytes = this.queue.reduce(
      (total, frame) => total + (frame.bytes === undefined ? 0 : Buffer.byteLength(frame.bytes)),
      0,
    );
    if (!this.paused && this.queuedBytes > OUTBOX_HIGH_WATER_BYTES) {
      this.paused = true;
      for (const gate of Object.values(this.gates)) gate?.pause();
    } else if (this.paused && this.queuedBytes < OUTBOX_LOW_WATER_BYTES) {
      this.paused = false;
      for (const gate of Object.values(this.gates)) gate?.resume();
    }
  }
}
