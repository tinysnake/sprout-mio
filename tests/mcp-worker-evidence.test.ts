import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { probeNativePiVersion } from "./fixtures/mcp-native-version";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sprout-mcp-version-"));
  const packages = join(directory, "node_modules", "@earendil-works");
  const modulePath = join(packages, "pi-mcp", "dist", "index.js");
  const sdkPackage = join(packages, "pi-coding-agent", "package.json");
  await mkdir(join(packages, "pi-mcp", "dist"), { recursive: true });
  await mkdir(join(packages, "pi-coding-agent"), { recursive: true });
  await writeFile(modulePath, "export {};\n");
  await writeFile(
    join(packages, "pi-mcp", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-mcp" }),
  );
  return { directory, modulePath, sdkPackage };
}

test("native Pi version comes from the loaded MCP installation's actual SDK package metadata", async () => {
  const { directory, modulePath, sdkPackage } = await fixture();
  try {
    for (const version of ["9.8.7", "9.8.8-rc.1"]) {
      await writeFile(
        sdkPackage,
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
      );
      expect(await probeNativePiVersion(modulePath)).toEqual({
        nativePiVersion: version,
        nativePiVersionProbe: "package.json",
        nativePiPackageJson: await realpath(sdkPackage),
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or invalid SDK metadata records unavailable without inventing a Pi version", async () => {
  const { directory, modulePath, sdkPackage } = await fixture();
  try {
    const unavailable = {
      nativePiVersion: null,
      nativePiVersionProbe: "unavailable",
      nativePiPackageJson: null,
    };
    expect(await probeNativePiVersion(modulePath)).toEqual(unavailable);
    await writeFile(sdkPackage, JSON.stringify({ name: "another-package", version: "9.8.7" }));
    expect(await probeNativePiVersion(modulePath)).toEqual(unavailable);
    await writeFile(
      sdkPackage,
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: null }),
    );
    expect(await probeNativePiVersion(modulePath)).toEqual(unavailable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
