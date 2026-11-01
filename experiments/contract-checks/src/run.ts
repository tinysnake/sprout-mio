import { runConcurrencyChecks } from './checks-concurrency.ts';
import { runContractChecks } from './checks-contract.ts';
import { report, reset } from './harness.ts';

reset();
await runContractChecks();
await runConcurrencyChecks();
process.exitCode = report();
