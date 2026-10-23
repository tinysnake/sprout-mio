import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { machineIdSchema } from "../contracts/machine";
import { workerSecretSchema } from "../contracts/worker";

export const serverSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Server requires HTTPS or loopback HTTP");
const identitySchema = z.strictObject({
  version: z.literal(1),
  server: serverSchema,
  machineId: machineIdSchema,
  secret: workerSecretSchema,
});
export type Identity = z.infer<typeof identitySchema>;
async function privatePath(path: string, directory: boolean) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Private state permissions required");
}
export async function readIdentity(directory: string): Promise<Identity> {
  await privatePath(directory, true);
  const path = join(directory, "identity.json");
  await privatePath(path, false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return identitySchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}
export async function initializeIdentity(
  directory: string,
  server: string,
  machineId: string,
): Promise<Identity> {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privatePath(directory, true);
  try {
    const existing = await readIdentity(directory);
    if (existing.server !== server || existing.machineId !== machineId)
      throw new Error("State belongs to another identity");
    return existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const identity = identitySchema.parse({
    version: 1,
    server,
    machineId,
    secret: randomBytes(32).toString("base64url"),
  });
  const temporary = join(directory, `.identity-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(identity));
    await handle.sync();
    await handle.close();
    await link(temporary, join(directory, "identity.json"));
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => {});
  }
  return identity;
}
export async function readTicket(path?: string): Promise<string> {
  if (path) {
    await privatePath(path, false);
    await access(path, constants.R_OK);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return workerSecretSchema.parse((await handle.readFile("utf8")).trim());
    } finally {
      await handle.close();
    }
  }
  if (!process.stdin.isTTY) throw new Error("Ticket requires a terminal or --ticket-file");
  return new Promise((resolveTicket, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", data);
      process.stderr.write("\n");
    };
    const data = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") {
          finish();
          reject(new Error("Interrupted"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          const parsed = workerSecretSchema.safeParse(value);
          if (parsed.success) resolveTicket(parsed.data);
          else reject(new Error("Invalid ticket"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else if (value.length < 100) value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stderr.write("Enrollment ticket (hidden): ");
    process.stdin.resume();
    process.stdin.on("data", data);
  });
}
