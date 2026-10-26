import { Effect } from "effect";
import { z } from "zod";
import { machineIdSchema } from "../contracts/machine";
import { APP_VERSION } from "../contracts/version";
import { WORKER_PROTOCOL_VERSION } from "../contracts/worker";
import { readMcpConfig } from "./mcp";
import { enroll, runWorker } from "./client";
import { httpOriginSchema, initializeIdentity, readIdentity, readTicket } from "./identity";

const HELP = `sprout-worker init --server <origin> --machine <id> --state-dir <directory> [--ticket-file <private-file>] [--allow-http <origin> ...]
sprout-worker run --state-dir <directory> [--mcp-config <explicit-registration-file>]
sprout-worker help
sprout-worker version

init reads the enrollment ticket without echo and persists a private identity before enrollment.
HTTP defaults to loopback only. For non-loopback HTTP, repeat --allow-http <complete origin>
to explicitly authorize each exact origin (including its port). Authorizations persist in identity.json.
HTTPS needs no flag. --allow-http never disables TLS verification.
run connects this Machine and executes authorized remote operations.
--mcp-config loads only the explicit registration array. It autostarts configured stdio/HTTP services
and connects owner_managed HTTP services, including when autostart is false.
Closing a relay session leaves its service running. Worker exit stops its managed services.
No LaunchAgent is installed.`;
async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS verification is required");
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";
  if ((command === "help" || command === "--help") && args.length === 0) {
    console.log(HELP);
    return;
  }
  if ((command === "version" || command === "--version") && args.length === 0) {
    console.log(
      `sprout-worker ${APP_VERSION} protocol=${WORKER_PROTOCOL_VERSION} node=${process.version}`,
    );
    return;
  }
  const options: Record<string, string | string[]> = {};
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (
      !key.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      (key in options && key !== "--allow-http")
    )
      throw new Error("Invalid arguments");
    if (key === "--allow-http") {
      const origins = (options[key] ?? []) as string[];
      origins.push(value);
      options[key] = origins;
    } else options[key] = value;
  }
  if (command === "init") {
    const parsed = z
      .strictObject({
        "--server": z.string(),
        "--allow-http": z.array(httpOriginSchema).default([]),
        "--machine": machineIdSchema,
        "--state-dir": z.string().min(1),
        "--ticket-file": z.string().min(1).optional(),
      })
      .parse(options);
    const identity = await initializeIdentity(
      parsed["--state-dir"],
      parsed["--server"],
      parsed["--machine"],
      parsed["--allow-http"],
    );
    const ticket = await readTicket(parsed["--ticket-file"]);
    await Effect.runPromise(enroll(identity, ticket));
    console.log("Machine enrolled. Start sprout-worker run with the same --state-dir.");
  } else if (command === "run") {
    const parsed = z
      .strictObject({
        "--state-dir": z.string().min(1),
        "--mcp-config": z.string().min(1).optional(),
      })
      .parse(options);
    const identity = await readIdentity(parsed["--state-dir"]);
    const registrations = parsed["--mcp-config"]
      ? await readMcpConfig(parsed["--mcp-config"], identity.machineId)
      : [];
    await runWorker(identity, registrations, parsed["--state-dir"]);
  } else throw new Error("Unknown command");
}
try {
  await main();
} catch (error) {
  if (error instanceof z.ZodError)
    console.error(error.issues.map((issue) => issue.message).join("; "));
  else if (error instanceof Error) console.error(error.message);
  console.error(
    "Worker failed. Check arguments, private state permissions, server availability and enrollment. Run sprout-worker help for usage.",
  );
  process.exitCode = 1;
}
