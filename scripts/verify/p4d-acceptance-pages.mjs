import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

// Reuse only the existing real-page setup. Existing assertions are preserved;
// the extra assertion attacks a dialog already open when the refresh fails.
const root = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(root, `.verify/p4d-acceptance-pages-${process.pid}.ts`);
const gatePath = resolve(root, `scripts/verify/.p4d-acceptance-pages-${process.pid}.sh`);
let fixture = await readFile(resolve(root, "tests/fixtures/p4d-pages.ts"), "utf8");
let gate = await readFile(resolve(root, "scripts/verify/aq-p4d-pages.sh"), "utf8");
function insertBefore(anchor, insertion) {
  assert.equal(fixture.split(anchor).length, 2, "injection anchor must be unique");
  fixture = fixture.replace(anchor, insertion + anchor);
}
insertBefore(
  "    await page.route(snapshot.url, (route) => route.abort());",
  `    await pendingItem("lease_fencing").getByTestId("membership-force-trigger").click();
    await page.getByTestId("membership-force-dialog").waitFor();
    await page.getByTestId("membership-force-confirm").check();
    assert.equal(await page.getByTestId("membership-force-submit").isDisabled(), false);
`,
);
insertBefore(
  "    const staleText = await stale.innerText();",
  `    const submitDisabled = await page.getByTestId("membership-force-submit").isDisabled();
    console.log(JSON.stringify({acceptance: "open-force-dialog-after-refresh-failure", expectedDisabled: true, actualDisabled: submitDisabled}));
    await page.screenshot({path: join(evidence, "acceptance-open-force-dialog-stale.png"), fullPage: true});
    if (!submitDisabled) {
      const beforeGeneration = leaseRow({projectId: p1, machineId: m2.machineId})!.generation;
      await page.getByTestId("membership-force-submit").click();
      await page.getByTestId("membership-force-receipt").waitFor();
      const after = leaseRow({projectId: p1, machineId: m2.machineId});
      console.log(JSON.stringify({acceptance: "stale-dialog-confirmation-writes", beforeGeneration, afterGeneration: after?.generation, afterState: after?.state}));
      assert.equal(after?.generation, beforeGeneration + 1);
    }
    assert.equal(submitDisabled, true, "refresh failure must disable confirmation in an already-open force-reclaim dialog");
    await page.keyboard.press("Escape");
`,
);
assert.equal(gate.split("tests/fixtures/p4d-pages.ts").length, 2);
fixture = fixture
  .replaceAll('"../../src/', '"../src/')
  .replace('"./remote-actors"', '"../tests/fixtures/remote-actors"');
gate = gate.replace(
  "tests/fixtures/p4d-pages.ts",
  `.verify/p4d-acceptance-pages-${process.pid}.ts`,
);
await writeFile(fixturePath, fixture);
await writeFile(gatePath, gate);
try {
  const child = spawn("bash", [gatePath], {
    cwd: root,
    detached: true,
    stdio: "inherit",
    env: {
      ...process.env,
      SPROUT_PAGES_EVIDENCE: ".verify/p4d-acceptance-pages",
      SPROUT_PAGES_PORT: "3145",
    },
  });
  const deadline = setTimeout(() => {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  }, 300000);
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolveCode(status ?? 124));
  });
  clearTimeout(deadline);
  process.exitCode = code;
} finally {
  await Promise.all([unlink(fixturePath), unlink(gatePath)]);
}
