import { Effect } from "effect";
import { z } from "zod";
import { machineIdSchema } from "../contracts/machine";
import { APP_VERSION } from "../contracts/version";
import { enroll, runWorker } from "./client";
import { initializeIdentity, readIdentity, readTicket, serverSchema } from "./identity";

const HELP = `sprout-worker init --server <origin> --machine <id> --state-dir <directory> [--ticket-file <private-file>]
sprout-worker run --state-dir <directory>
sprout-worker help
sprout-worker version

init reads the enrollment ticket without echo and persists a private identity before enrollment.
run connects this macOS Machine and reports shell and directory observations.
Remote operations are not implemented. No LaunchAgent is installed.`;
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
    console.log(`sprout-worker ${APP_VERSION} protocol=1 node=${process.version}`);
    return;
  }
  const options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (!key.startsWith("--") || !value || value.startsWith("--") || key in options)
      throw new Error("Invalid arguments");
    options[key] = value;
  }
  if (command === "init") {
    const parsed = z
      .strictObject({
        "--server": serverSchema,
        "--machine": machineIdSchema,
        "--state-dir": z.string().min(1),
        "--ticket-file": z.string().min(1).optional(),
      })
      .parse(options);
    const identity = await initializeIdentity(
      parsed["--state-dir"],
      new URL(parsed["--server"]).origin,
      parsed["--machine"],
    );
    const ticket = await readTicket(parsed["--ticket-file"]);
    await Effect.runPromise(enroll(identity, ticket));
    console.log("Machine enrolled. Start sprout-worker run with the same --state-dir.");
  } else if (command === "run") {
    const parsed = z.strictObject({ "--state-dir": z.string().min(1) }).parse(options);
    await runWorker(await readIdentity(parsed["--state-dir"]));
  } else throw new Error("Unknown command");
}
try {
  await main();
} catch {
  console.error(
    "Worker failed. Check arguments, private state permissions, server availability and enrollment. Run sprout-worker help for usage.",
  );
  process.exitCode = 1;
}
