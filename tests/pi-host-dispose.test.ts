import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import { PiSessionProcess } from "../src/server/pi-host/process";

it("宿主 abort/close/自然退出均立即且只触发一次 grant 清理，迟到注册也会清理", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4b-grant-dispose-"));
  const runner = join(directory, "runner.mjs");
  writeFileSync(
    runner,
    `
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line', raw => {
      const {type} = JSON.parse(raw);
      if (type === 'close') process.exit(0);
      if (type === 'steer') process.exit(0);
    });
  `,
  );
  try {
    for (const action of ["abort", "close", "exit"] as const) {
      const process = new PiSessionProcess("dispose-probe", runner);
      let count = 0;
      let disposed!: () => void;
      const disposal = new Promise<void>((resolve) => {
        disposed = resolve;
      });
      process.onDispose(() => {
        count += 1;
        disposed();
      });
      let otherCleanup = 0;
      process.onDispose(() => {
        otherCleanup += 1;
      });
      try {
        if (action === "abort") process.abortSession();
        if (action === "close") await process.close();
        if (action === "exit") process.steer("probe", "exit");
        await disposal;
        expect(count).toBe(1);
        await process.close();
        expect(count).toBe(1);
        expect(otherCleanup).toBe(1);
        let late = 0;
        process.onDispose(() => {
          late += 1;
        });
        expect(late).toBe(1);
      } finally {
        await process.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
