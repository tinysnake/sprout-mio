import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { APP_ERROR_CODES, toAppError } from "../src/contracts";
import { APP_VERSION, CONTRACT_VERSION } from "../src/contracts/version";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
function sourceFiles(directory = sourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("工具链接口门禁", () => {
  it("应用版本与 package.json 一致，Worker 与 extension 的 --version 输出不会漂移", () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("契约版本是正整数，消费者可据此识别载荷版本", () => {
    expect(Number.isInteger(CONTRACT_VERSION)).toBe(true);
    expect(CONTRACT_VERSION).toBeGreaterThan(0);
  });

  it("错误码映射保持封闭，未知码与旧 requestId 都不会透传", () => {
    for (const code of APP_ERROR_CODES) {
      expect(toAppError({ code, message: "诊断提示", requestId: "req_stale" }, "req_now")).toEqual({
        code,
        message: code === "internal" ? "内部错误" : "诊断提示",
        requestId: "req_now",
      });
    }
    expect(toAppError("not_a_registered_code", "req_now")).toEqual({
      code: "internal",
      message: "内部错误",
      requestId: "req_now",
    });
  });

  it("参与判断的时间只能注入，不能就地读时钟", () => {
    // 注入的默认值写成 now = Date.now（引用），就地读时钟写成 Date.now()（调用）。
    // 只有后者能让一段时间参与分支，所以这里只禁后者。
    const reads = sourceFiles()
      .map((file) => ({
        file: relative(sourceRoot, file),
        reads: readFileSync(file, "utf8").match(/Date\.now\(\)/g)?.length ?? 0,
      }))
      .filter(({ reads }) => reads > 0);
    // domain/project.ts 那一处已改为参数注入，domain 层不再就地读时钟。
    // 新增的每一处都必须改成参数注入或走 Effect 的 Clock，见 docs/architecture-direction.md。
    expect(reads).toEqual([]);
  });

  it("限流器的时间来源是注入的，测试可以在不等待的情况下快进窗口", () => {
    const limiter = readFileSync(join(sourceRoot, "server/rate-limit.ts"), "utf8");
    expect(limiter).toContain("now = Date.now");
  });

  it("review 端口探测区分不可达、正常与僵死，且不经过宿主代理", async () => {
    const modulePath = new URL("../scripts/human-review/review.mjs", import.meta.url).href;
    const { probeHealth } = (await import(/* @vite-ignore */ modulePath)) as {
      probeHealth: (port: number, timeout?: number) => Promise<"ok" | "stale" | "down">;
    };
    const listen = (handler: (req: unknown, res: unknown) => void) =>
      new Promise<{ port: number; close: () => void }>((resolve) => {
        const server = createServer(handler);
        server.listen(0, "127.0.0.1", () =>
          resolve({
            port: (server.address() as { port: number }).port,
            close: () => server.close(),
          }),
        );
      });

    const healthy = await listen((_req, res) => {
      (res as { writeHead: (code: number) => void }).writeHead(200);
      (res as { end: () => void }).end();
    });
    // 宿主给全局 fetch 装了代理 dispatcher 时，回环探测会先超时再被判成僵死。
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    expect(await probeHealth(healthy.port, 1000)).toBe("ok");
    delete process.env.HTTP_PROXY;
    healthy.close();

    const stalled = await listen(() => {});
    expect(await probeHealth(stalled.port, 300)).toBe("stale");
    stalled.close();

    const closed = await listen(() => {});
    const closedPort = closed.port;
    closed.close();
    expect(await probeHealth(closedPort, 300)).toBe("down");
  });
});
