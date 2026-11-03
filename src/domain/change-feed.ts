import { eq } from "drizzle-orm";
import { CHANGE_STREAM, chatTopic, projectTopic } from "../contracts/change-stream";
import { db } from "../db";
import { chat, projectMachine, projectMember } from "../db/schema";

/** 一条推送事实：主题变了，页面据此重读该主题下的 revision。 */
export type ChangeEvent = { readonly id: number; readonly topic: string; readonly at: number };

type Subscriber = {
  readonly topics: ReadonlySet<string>;
  readonly send: (event: ChangeEvent) => void;
};

type Feed = {
  subscribers: Map<number, Subscriber>;
  pending: Map<string, { timer: ReturnType<typeof setTimeout>; at: number }>;
  sequence: number;
  nextSubscriberId: number;
};
/**
 * 构建产物把服务入口与 SSR 路由拆成两套模块图，同一个文件会有两份实例。
 * 订阅者与合窗定时器必须挂在 process 上，否则一边的发布永远到不了另一边的连接。
 */
const processScope = globalThis as typeof globalThis & { sproutChangeFeed?: Feed };
const feed = (processScope.sproutChangeFeed ??= {
  subscribers: new Map(),
  pending: new Map(),
  sequence: 0,
  nextSubscriberId: 1,
});

function deliver(subscriber: Subscriber, event: ChangeEvent) {
  try {
    subscriber.send(event);
  } catch {
    removeSubscriber(subscriber);
  }
}

function removeSubscriber(target: Subscriber) {
  for (const [id, subscriber] of feed.subscribers)
    if (subscriber === target) feed.subscribers.delete(id);
  prunePending();
}

/** 最后一个订阅者走了，还没发出的那一条连同定时器一起取消，不留悬空 timer。 */
function prunePending() {
  for (const [topic, entry] of feed.pending) {
    if ([...feed.subscribers.values()].some((subscriber) => subscriber.topics.has(topic))) continue;
    clearTimeout(entry.timer);
    feed.pending.delete(topic);
  }
}

/** 连接有一个订阅者就够；主题各自计数由调用方（客户端 store 与页面）负责。 */
export function subscribeChanges(input: {
  topics: readonly string[];
  send: (event: ChangeEvent) => void;
}): () => void {
  const id = feed.nextSubscriberId++;
  const subscriber: Subscriber = { topics: new Set(input.topics), send: input.send };
  feed.subscribers.set(id, subscriber);
  return () => {
    feed.subscribers.delete(id);
    prunePending();
  };
}

/**
 * 同一主题在合窗内的多次写入只发一条：run 的一次转移会顺手改消息、会话与队列，
 * 分开发等于让页面连读四次。这里只排定时器，事务回滚时最多产生一次无害的误报。
 */
export function publishChange(topic: string, now: () => number = Date.now): void {
  if (feed.pending.has(topic)) return;
  if (![...feed.subscribers.values()].some((subscriber) => subscriber.topics.has(topic))) return;
  const at = now();
  const timer = setTimeout(() => {
    feed.pending.delete(topic);
    flush(topic, at);
  }, CHANGE_STREAM.coalesceMs);
  timer.unref?.();
  feed.pending.set(topic, { timer, at });
}

function flush(topic: string, at: number) {
  const event: ChangeEvent = { id: ++feed.sequence, topic, at };
  for (const subscriber of Array.from(feed.subscribers.values()))
    if (subscriber.topics.has(topic)) deliver(subscriber, event);
}

/** 页面按 Project 看列表、按 Chat 看对话：一次写入常常同时属于两者。 */
export function publishProjectChange(projectId: string, chatId?: string): void {
  if (!projectId) return;
  publishChange(projectTopic(projectId));
  if (chatId) publishChange(chatTopic(chatId));
}

/**
 * 机器上线、下线与绑定改变的是 Project 的机器列表，而写入点只拿着 machineId。
 * 连接开合是低频事件，这里查一次绑定比让每个写入点自己带 projectId 更稳。
 */
export function publishMachineChange(machineId: string): void {
  for (const binding of db
    .select({ projectId: projectMachine.projectId })
    .from(projectMachine)
    .where(eq(projectMachine.machineId, machineId))
    .all())
    publishProjectChange(binding.projectId);
}

/**
 * Agent profile 是全局对象，改它会同时改变所有已加入该 profile 的 Project 聚合。
 * 写入点只拿着 profileId，这里查一次成员关系再逐 Project 通知。
 */
export function publishAgentProfileChange(agentProfileId: string): void {
  for (const member of db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .where(eq(projectMember.agentProfileId, agentProfileId))
    .all())
    publishProjectChange(member.projectId);
}

/**
 * 自动接续的写入点只拿着 chatId，而页面按 Project 与 Chat 两个主题看。
 * 判定本身也会改变对话里的状态提示，所以 Chat 主题同样要发。
 */
export function publishChatAutomationChange(chatId: string): void {
  const scope = db
    .select({ projectId: chat.projectId })
    .from(chat)
    .where(eq(chat.id, chatId))
    .get();
  if (scope) publishProjectChange(scope.projectId, chatId);
}

/** 测试与诊断用：不给业务代码清空全局订阅者。 */
export function changeFeedSnapshot(): {
  subscribers: number;
  topics: readonly string[];
} {
  return {
    subscribers: feed.subscribers.size,
    topics: [...feed.subscribers.values()].flatMap((subscriber) => [...subscriber.topics]),
  };
}

export function resetChangeFeed(): void {
  for (const entry of feed.pending.values()) clearTimeout(entry.timer);
  feed.pending.clear();
  feed.subscribers.clear();
}
