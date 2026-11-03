import { ID_PREFIXES, appIdPattern } from "./ids";

/**
 * 推送只回答「哪个主题变了」，页面仍走原来的 revision 读。
 * 误报由内容哈希吸收（未变化时只回 215 字节），漏报由安全轮询兜底。
 */
export const CHANGE_STREAM = {
  heartbeatMs: 20_000,
  coalesceMs: 150,
  maxTopics: 8,
  /** 一条连接允许积压的帧数：慢消费者超过这个量就被断开，由重连补齐事实。 */
  maxQueuedFrames: 64,
} as const;

/** 推送可用时的安全轮询间隔；连接断了就退回原来的节奏。 */
export const CHANGE_SAFETY_POLL_MS = { project: 30_000, chat: 15_000 } as const;

export type ChangeTopicKind = "project" | "chat";

/** 主题里的 id 直接复用共享 id 契约，不另发明一套更宽的规则。 */
const TOPIC_ID_PATTERN: Record<ChangeTopicKind, RegExp> = {
  project: appIdPattern(ID_PREFIXES.project),
  chat: appIdPattern(ID_PREFIXES.chat),
};

export function projectTopic(projectId: string): string {
  return `project:${projectId}`;
}

export function chatTopic(chatId: string): string {
  return `chat:${chatId}`;
}

export function topicKind(topic: string): { kind: ChangeTopicKind; id: string } | null {
  const separator = topic.indexOf(":");
  if (separator <= 0) return null;
  const kind = topic.slice(0, separator) as ChangeTopicKind;
  const id = topic.slice(separator + 1);
  if (kind !== "project" && kind !== "chat") return null;
  return TOPIC_ID_PATTERN[kind].test(id) ? { kind, id } : null;
}

/** 订阅入口只接受登记过的前缀；未知形状、重复与超量一律丢掉。 */
export function parseChangeTopics(raw: string | null): string[] {
  if (!raw) return [];
  const topics: string[] = [];
  for (const candidate of raw.split(",")) {
    const topic = candidate.trim();
    if (!topicKind(topic) || topics.includes(topic)) continue;
    topics.push(topic);
    if (topics.length >= CHANGE_STREAM.maxTopics) break;
  }
  return topics;
}
