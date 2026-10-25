import assert from "node:assert/strict";

export async function assertForcedReceiptPersists({
  page,
  projectId,
  machineId,
  call,
  until,
  refreshFunctionId,
}) {
  const before = (await call("getLeaseFn", { projectId, machineId })).lease;
  assert.equal(before.state, "fencing", "forced receipt scenario starts in fencing");
  assert.ok(before.pendingMutationId, "fencing has a pending mutation");
  const row = page.getByTestId(`lease-row-${machineId}`);
  assert.equal(await row.getAttribute("data-lease-state"), "fencing");
  await row.getByTestId("lease-fencing-details-trigger").click();
  await page.getByTestId("lease-force-reclaim-confirm").check();
  await page.getByTestId("lease-force-reclaim").click();

  const free = await until(async () => {
    const lease = (await call("getLeaseFn", { projectId, machineId })).lease;
    return lease.state === "free" && lease.generation > before.generation ? lease : null;
  }, "forced reclaim leaves fencing on the server");
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="lease-row-${id}"]`)
        ?.getAttribute("data-lease-state") === "free",
    machineId,
  );
  const original = await call("getLeaseFn", {
    projectId,
    machineId,
    mutationId: before.pendingMutationId,
  });
  const mutationId = original.mutation?.forcedReclaim?.mutationId;
  assert.ok(mutationId, "server identifies the forced reclaim receipt");
  assert.equal(original.mutation.completedGeneration, free.generation);
  assert.equal(
    await page.getByTestId("lease-fencing-facts").count(),
    0,
    "fencing subtree has unmounted",
  );
  assert.equal(
    await page.getByTestId("lease-force-reclaim-controls").count(),
    0,
    "forced reclaim controls disappear after fencing",
  );
  assert.equal(
    await page.getByTestId("lease-force-reclaim").count(),
    0,
    "forced reclaim button disappears after fencing",
  );

  console.log(
    `FORCED_RECEIPT fencing -> free; fencing subtree and force controls absent; mutationId=${mutationId}`,
  );
  const receipt = page.getByTestId(`machine-lease-section-overview-forced-receipt-${machineId}`);
  await receipt.waitFor({ state: "visible", timeout: 15000 });
  assert.ok(
    (await receipt.innerText()).includes(mutationId),
    "forced receipt survives fencing subtree unmount with this mutationId",
  );
  assert.match(
    await receipt.getByTestId("machine-lease-section-overview-forced-receipt-state").innerText(),
    /未确认/,
    "completed forced receipt must state that Worker drain is unconfirmed",
  );

  const refresh = await page.waitForResponse(
    (response) => response.url().includes(refreshFunctionId) && response.ok(),
    { timeout: 15000 },
  );
  await refresh.finished();
  assert.equal(await row.getAttribute("data-lease-state"), "free");
  assert.ok(await receipt.isVisible(), "forced receipt remains visible after automatic refresh");
  assert.ok(
    (await receipt.innerText()).includes(mutationId),
    "automatic refresh preserves this forced receipt",
  );
  return { mutationId, generation: free.generation };
}
