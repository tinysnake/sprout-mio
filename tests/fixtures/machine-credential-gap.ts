import assert from "node:assert/strict";
import { migrateDatabase } from "../../src/db/migrate";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import {
  createMachine,
  listMachines,
  MachineError,
  renewMachineEnrollment,
} from "../../src/domain/machine";
import { sqlite } from "../../src/db";

migrateDatabase();
const now = new Date("2026-01-01T00:00:00Z");
const bootId = newId(ID_PREFIXES.boot);
const requestId = newId(ID_PREFIXES.request);
sqlite
  .prepare(
    "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','owner@example.test',0,1,1)",
  )
  .run();
sqlite
  .prepare(
    "INSERT INTO runtime_boot (id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
const ctx = { now, bootId, requestId, userId: "owner" };

const created = createMachine({ name: "缺少凭据的机器" }, ctx);
const machineId = created.detail.machine.id;

// 直接删凭据行模拟数据不一致：产品入口在同一事务里建机器与凭据，只有外部写入才会留下这个缺口。
sqlite.pragma("foreign_keys = OFF");
sqlite.prepare("DELETE FROM machine_credential WHERE machine_id = ?").run(machineId);
sqlite.pragma("foreign_keys = ON");

const listed = listMachines(ctx);
const row = listed.find((item) => item.machine.id === machineId);
assert.ok(row, "缺少凭据行时机器仍应出现在列表里");
assert.equal(row.enrollmentStatus, "pending", "没有凭据行就是未配对");
console.log("PASS credential gap lists machine as pending");

let conflict: unknown;
try {
  renewMachineEnrollment(machineId, ctx);
} catch (error) {
  conflict = error;
}
assert.ok(conflict instanceof MachineError, "重新登记应抛域错误");
assert.equal((conflict as MachineError).code, "conflict");
assert.equal((conflict as MachineError).message, "Machine 缺少入网凭据，请删除后重新添加");
console.log("PASS credential gap rejects re-enrollment with a domain error");
