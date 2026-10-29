#!/usr/bin/env node
import { runSandbox } from "./lib/sandbox.mjs";

try {
  const result = await runSandbox(process.argv.slice(2));
  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code;
  }
} catch (error) {
  console.error(`FAIL verification sandbox: ${error.message}`);
  process.exitCode = 1;
}
