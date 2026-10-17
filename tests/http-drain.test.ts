import { describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { HttpDrain, type NodeRequest } from "../src/server/http-drain";

function transport() {
  const response = new EventEmitter();
  const request = new Request("http://localhost/api/auth/sign-up/email") as NodeRequest;
  // Model the two independent notifications from the Node adapter.
  Object.assign(request, { runtime: { node: { req: {}, res: response } } });
  return { request, response };
}

describe("HTTP drain", () => {
  it.each(["finish", "close"])("等待处理与传输结束，%s 不会提前释放或重复释放", async (event) => {
    const drain = new HttpDrain();
    const { request, response } = transport();
    const handled = drain.begin(request);
    const waiting = drain.wait(1000);
    response.emit(event);
    expect(drain.active).toBe(1); // Disconnect does not cancel an async DB operation.
    handled();
    handled();
    response.emit("close");
    await waiting;
    expect(drain.active).toBe(0);
    expect(drain.draining).toBe(true);
  });

  it("处理完成仍等响应发送，响应错误关闭也会释放", async () => {
    const drain = new HttpDrain();
    const { request, response } = transport();
    const handled = drain.begin(request);
    handled();
    expect(drain.active).toBe(1);
    const waiting = drain.wait(1000);
    response.emit("close");
    await waiting;
    expect(drain.active).toBe(0);
  });

  it("截止时拒绝排空，保留活跃请求直到业务结束", async () => {
    const drain = new HttpDrain();
    const handled = drain.begin(new Request("http://localhost/"));
    await expect(drain.wait(10)).rejects.toThrow("HTTP 排空超时");
    expect(drain.active).toBe(1);
    handled();
    await drain.wait(1000);
    expect(drain.active).toBe(0);
  });
});
