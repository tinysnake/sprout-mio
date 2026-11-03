import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  HOST_CORE_TOOLS,
  HOST_WEB_TOOLS,
  hostToolNames,
  resolveWebAccessExtension,
} from "../src/extension/host-tools";

const directory = mkdtempSync(join(tmpdir(), "sprout-host-tools-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("host tool surface", () => {
  it("keeps read-only host tools and excludes bash/edit/write", () => {
    for (const name of [
      "read",
      "grep",
      "find",
      "ls",
      "current_time",
      "git_read",
      "codemode",
      "tool_search",
    ]) {
      expect(HOST_CORE_TOOLS).toContain(name);
    }
    for (const name of ["bash", "edit", "write"]) {
      expect(HOST_CORE_TOOLS).not.toContain(name);
    }
  });

  it("only adds web tools when the extension is present", () => {
    expect(hostToolNames(null)).toEqual([...HOST_CORE_TOOLS]);
    expect(hostToolNames("/some/pi-web-access/dist/index.js")).toEqual([
      ...HOST_CORE_TOOLS,
      ...HOST_WEB_TOOLS,
    ]);
  });

  it("resolves an explicit extension directory and an agentDir npm install", () => {
    const explicit = join(directory, "explicit");
    mkdirSync(join(explicit, "dist"), { recursive: true });
    writeFileSync(join(explicit, "dist", "index.js"), "export default () => {};");
    expect(resolveWebAccessExtension(directory, { SPROUT_PI_WEB_ACCESS_PATH: explicit })).toBe(
      join(explicit, "dist", "index.js"),
    );

    const agentDir = join(directory, "agent");
    const installed = join(agentDir, "npm", "node_modules", "pi-web-access", "dist");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "index.js"), "export default () => {};");
    expect(resolveWebAccessExtension(agentDir, {})).toBe(join(installed, "index.js"));
  });

  it("returns null for a missing explicit path instead of guessing", () => {
    expect(
      resolveWebAccessExtension(directory, {
        SPROUT_PI_WEB_ACCESS_PATH: join(directory, "missing"),
      }),
    ).toBeNull();
  });
});
