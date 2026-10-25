import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function probeNativePiVersion(nativeModulePath: string) {
  try {
    const modulePath = await realpath(nativeModulePath);
    const mcpRoot = dirname(dirname(modulePath));
    const mcpPackage = JSON.parse(await readFile(join(mcpRoot, "package.json"), "utf8"));
    if (mcpPackage.name !== "@earendil-works/pi-mcp") throw new Error("Unexpected MCP package");
    const packageJson = await realpath(join(dirname(mcpRoot), "pi-coding-agent", "package.json"));
    const sdkPackage = JSON.parse(await readFile(packageJson, "utf8"));
    if (
      sdkPackage.name !== "@earendil-works/pi-coding-agent" ||
      typeof sdkPackage.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(sdkPackage.version)
    )
      throw new Error("Invalid Pi package metadata");
    return {
      nativePiVersion: sdkPackage.version as string,
      nativePiVersionProbe: "package.json" as const,
      nativePiPackageJson: packageJson,
    };
  } catch {
    return {
      nativePiVersion: null,
      nativePiVersionProbe: "unavailable" as const,
      nativePiPackageJson: null,
    };
  }
}
