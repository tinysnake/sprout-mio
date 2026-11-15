import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** Live gates seed Crew through the same domain fixture as SQLite gates. */
export async function createCrewFixture(call, database, input) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import { sqlite } from "./src/db/index.ts";
      import { createCrewChat } from "./tests/fixtures/crew-chat.ts";
      const input = JSON.parse(process.env.CREW_FIXTURE_INPUT);
      const owner = sqlite.prepare("SELECT created_by FROM project WHERE id=?").get(input.projectId);
      const ctx = { userId: owner.created_by, requestId: "req_crew_fixture" };
      const crew = createCrewChat(input.projectId, input, {kind:"human", userId:ctx.userId, ctx});
      console.log(JSON.stringify({id: crew.id}));
      sqlite.close();
    `,
    ],
    {
      env: { ...process.env, DATABASE_URL: database, CREW_FIXTURE_INPUT: JSON.stringify(input) },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const { id } = JSON.parse(result.stdout.trim().split("\n").at(-1));
  return call("getChatFn", { chatId: id });
}
