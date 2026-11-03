/** 推送只是「有东西变了」的提醒：具体事实仍由页面按 revision 重读。 */
export type ChangeSource = {
  subscribe: (onChange: () => void) => () => void;
  connected: () => boolean;
};

type Listener = (topic: string) => void;

/** 断线重连的退避上限：连续失败到上限就停手，页面退回轮询。 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_ATTEMPTS = 6;

const subscriptions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
const stateListeners = new Set<() => void>();
let source: EventSource | null = null;
let connected = false;
let attempts = 0;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let suspended = false;
let watching = false;

function notifyState() {
  for (const listener of Array.from(stateListeners)) listener();
}

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  notifyState();
}

function topics(): string[] {
  return [...subscriptions.keys()].sort();
}

/** 已连上的 URL 背后那份主题表：订阅集合变了就得换连接，否则新主题永远收不到。 */
let openKey: string | null = null;

/** 连上或重连之后都补一次提醒：断开期间的变化没人替页面记着。 */
function notifyAll() {
  const seen = new Set<Listener>();
  for (const topic of topics()) {
    for (const listener of listeners.get(topic) ?? []) {
      if (seen.has(listener)) continue;
      seen.add(listener);
      listener(topic);
    }
  }
}

function dispatch(topic: string) {
  for (const listener of Array.from(listeners.get(topic) ?? [])) listener(topic);
}

function close() {
  clearTimeout(reconnect);
  reconnect = undefined;
  source?.close();
  source = null;
  openKey = null;
  setConnected(false);
}

function scheduleReconnect() {
  if (suspended || subscriptions.size === 0) return;
  attempts += 1;
  if (attempts > RECONNECT_ATTEMPTS) return;
  const delay = Math.min(RECONNECT_MIN_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
  clearTimeout(reconnect);
  reconnect = setTimeout(() => {
    reconnect = undefined;
    open();
  }, delay);
}

function open() {
  if (typeof EventSource === "undefined" || source || suspended || subscriptions.size === 0) return;
  const key = topics().join(",");
  const events = new EventSource(`/api/events?topics=${encodeURIComponent(key)}`);
  source = events;
  openKey = key;
  events.addEventListener("ready", () => {
    attempts = 0;
    setConnected(true);
    notifyAll();
  });
  events.addEventListener("change", (event) => {
    const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
    const topic =
      typeof payload === "object" && payload !== null && "topic" in payload
        ? (payload as { topic: unknown }).topic
        : null;
    if (typeof topic === "string") dispatch(topic);
  });
  // EventSource 自己会重试网络断线；只有浏览器的自动重连被彻底放弃（例如 401/403）
  // 才会走到这里，此时改由我们退避重连，超出上限就停手，页面退回轮询。
  events.addEventListener("error", () => {
    // 浏览器的自动重连期间也是断的：先标记断连，页面据此退回轮询节奏。
    setConnected(false);
    if (events.readyState !== EventSource.CLOSED) return;
    close();
    scheduleReconnect();
  });
}

/** 页面隐藏时断开，恢复可见时重连并补一次提醒：后台标签页不该占着连接。 */
function watchEnvironment() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  // 首次挂载在后台标签页时不该先连一次再断。
  suspended = document.visibilityState !== "visible";
  document.addEventListener("visibilitychange", () => {
    suspended = document.visibilityState !== "visible";
    if (suspended) close();
    else {
      attempts = 0;
      open();
    }
  });
  window.addEventListener("online", () => {
    attempts = 0;
    open();
  });
  window.addEventListener("offline", close);
}

export function subscribeChangeSource(
  topicsIn: readonly string[],
  onChange: () => void,
): () => void {
  watchEnvironment();
  const wanted = [...new Set(topicsIn)];
  // 每次订阅一个独立条目：同一回调订阅两次时，退掉一次不能连累另一次。
  const entry: Listener = () => onChange();
  for (const topic of wanted) {
    subscriptions.set(topic, (subscriptions.get(topic) ?? 0) + 1);
    const bucket = listeners.get(topic) ?? new Set<Listener>();
    bucket.add(entry);
    listeners.set(topic, bucket);
  }
  open();
  resync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const topic of wanted) {
      const bucket = listeners.get(topic);
      bucket?.delete(entry);
      if (bucket && bucket.size === 0) listeners.delete(topic);
      const count = (subscriptions.get(topic) ?? 1) - 1;
      if (count > 0) subscriptions.set(topic, count);
      else subscriptions.delete(topic);
    }
    if (subscriptions.size === 0) close();
    else resync();
  };
}

/** 订阅集合变化后把连接对齐到当前主题表。 */
function resync() {
  if (!source || suspended || subscriptions.size === 0) return;
  if (openKey === topics().join(",")) return;
  close();
  open();
}

export function changeSource(topicsIn: readonly string[]): ChangeSource {
  return {
    subscribe: (onChange) => subscribeChangeSource(topicsIn, onChange),
    connected: () => connected,
  };
}

export function changeStreamConnected(): boolean {
  return connected;
}

export function onChangeStreamState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** 测试用：把模块级连接状态清空。 */
export function resetChangeStream(): void {
  close();
  attempts = 0;
  subscriptions.clear();
  listeners.clear();
  stateListeners.clear();
  suspended = false;
  watching = false;
}
