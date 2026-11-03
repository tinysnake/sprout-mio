import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Handler = (event: unknown) => void;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private handlers = new Map<string, Set<Handler>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler) {
    const bucket = this.handlers.get(type) ?? new Set<Handler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);
  }

  removeEventListener(type: string, handler: Handler) {
    this.handlers.get(type)?.delete(handler);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, event: unknown = {}) {
    if (type === "ready") this.readyState = FakeEventSource.OPEN;
    for (const handler of Array.from(this.handlers.get(type) ?? [])) handler(event);
  }

  static get latest() {
    return FakeEventSource.instances.at(-1)!;
  }
}

/** 只实现被测代码用到的那部分 DOM：可见性事件由测试自己触发。 */
class FakeDocument {
  visibilityState: "visible" | "hidden" = "visible";
  private handlers = new Map<string, Set<Handler>>();

  addEventListener(type: string, handler: Handler) {
    const bucket = this.handlers.get(type) ?? new Set<Handler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);
  }

  removeEventListener(type: string, handler: Handler) {
    this.handlers.get(type)?.delete(handler);
  }

  setVisibility(state: "visible" | "hidden") {
    this.visibilityState = state;
    for (const handler of Array.from(this.handlers.get("visibilitychange") ?? [])) handler({});
  }
}

const PROJECT = "prj_1234abcd";
const OTHER = "prj_8765fedc";
const CHAT = "cnv_1234abcd";

let document: FakeDocument;
let store: typeof import("../src/lib/change-stream");
let projectTopic: typeof import("../src/contracts/change-stream").projectTopic;
let chatTopic: typeof import("../src/contracts/change-stream").chatTopic;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  document = new FakeDocument();
  Object.assign(globalThis, {
    EventSource: FakeEventSource,
    document,
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  });
  store = await import("../src/lib/change-stream");
  ({ projectTopic, chatTopic } = await import("../src/contracts/change-stream"));
  store.resetChangeStream();
});

afterEach(() => {
  store.resetChangeStream();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "EventSource");
  Reflect.deleteProperty(globalThis, "window");
});

describe("客户端推送连接", () => {
  it("同一回调订阅两次时，退掉一次不影响另一次", () => {
    const calls: string[] = [];
    const onChange = () => calls.push("hit");
    const topic = projectTopic(PROJECT);
    const releaseFirst = store.subscribeChangeSource([topic], onChange);
    store.subscribeChangeSource([topic], onChange);

    FakeEventSource.latest.emit("ready");
    calls.length = 0;
    releaseFirst();
    FakeEventSource.latest.emit("change", { data: JSON.stringify({ topic }) });

    // 剩下那次订阅还在：重复回调退一次不能把另一次也删掉。
    expect(calls).toHaveLength(1);
  });

  it("退订函数幂等，重复调用不会关掉别人的连接", () => {
    const topic = projectTopic(PROJECT);
    const mine: string[] = [];
    const theirs: string[] = [];
    const releaseMine = store.subscribeChangeSource([topic], () => mine.push("mine"));
    store.subscribeChangeSource([topic], () => theirs.push("theirs"));

    FakeEventSource.latest.emit("ready");
    mine.length = 0;
    theirs.length = 0;
    releaseMine();
    releaseMine();
    FakeEventSource.latest.emit("change", { data: JSON.stringify({ topic }) });

    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(1);
    expect(store.changeStreamConnected()).toBe(true);
  });

  it("主题集合变化时重建连接，新主题不会静默丢推送", () => {
    const releaseProject = store.subscribeChangeSource([projectTopic(PROJECT)], () => {});
    expect(FakeEventSource.instances).toHaveLength(1);
    const releaseChat = store.subscribeChangeSource([chatTopic(CHAT)], () => {});
    expect(FakeEventSource.instances).toHaveLength(2);
    const url = decodeURIComponent(FakeEventSource.latest.url);
    expect(url).toContain(projectTopic(PROJECT));
    expect(url).toContain(chatTopic(CHAT));
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    // 退掉一个主题也要换连接，别让服务端继续发已经不看的主题。
    releaseChat();
    expect(decodeURIComponent(FakeEventSource.latest.url)).toContain(projectTopic(PROJECT));
    expect(decodeURIComponent(FakeEventSource.latest.url)).not.toContain(chatTopic(CHAT));

    releaseProject();
    expect(FakeEventSource.latest.closed).toBe(true);
  });

  it("自动重连期间也算断开，页面据此退回轮询", () => {
    store.subscribeChangeSource([projectTopic(PROJECT)], () => {});
    FakeEventSource.latest.emit("ready");
    expect(store.changeStreamConnected()).toBe(true);

    FakeEventSource.latest.readyState = FakeEventSource.CONNECTING;
    FakeEventSource.latest.emit("error");
    expect(store.changeStreamConnected()).toBe(false);
  });

  it("后台首次挂载不开连接，恢复可见时才连", () => {
    document.visibilityState = "hidden";
    store.subscribeChangeSource([projectTopic(OTHER)], () => {});
    expect(FakeEventSource.instances).toHaveLength(0);

    document.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("浏览器放弃自动重连后退避重连，到上限就停手", () => {
    store.subscribeChangeSource([projectTopic(PROJECT)], () => {});
    expect(FakeEventSource.instances).toHaveLength(1);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      FakeEventSource.latest.close();
      FakeEventSource.latest.emit("error");
      vi.advanceTimersByTime(20_000);
    }

    expect(FakeEventSource.instances).toHaveLength(7);
    expect(store.changeStreamConnected()).toBe(false);
  });
});
