// F8a 数据集：真实注册会话、一个额外 Project 和 212 条诊断行，供本地 HTTP 分页读取测量。
import { ID_PREFIXES, newId } from "../../../src/contracts/ids";
import { sqlite } from "../../../src/db";
import { migrateDatabase } from "../../../src/db/migrate";
import { createProject } from "../../../src/domain/project";
import { auth } from "../../../src/lib/auth";

const email = process.env.SEED_EMAIL ?? "baseline@sprout.test";
const password = process.env.SEED_PASSWORD ?? "snapshot-password-9f4c";
migrateDatabase();
const signedUp = await auth.api.signUpEmail({ body: { email, password, name: "Baseline Human" } });
const ctx = { userId: signedUp.user.id, requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "基线项目" }, ctx);
const listRequestId = newId(ID_PREFIXES.request);
const insert = sqlite.prepare(
  "INSERT INTO diagnostic_event(id, at, level, event, request_id, project_id, message) VALUES (?, ?, 'info', ?, ?, ?, ?)",
);
const seedRows = sqlite.transaction(() => {
  for (let index = 0; index < 200; index += 1)
    insert.run(
      `diag_baseline_page_${index}`,
      Math.floor(Date.now() / 1000) + index,
      "baseline.page",
      `req_baseline_page_${index}`,
      project.id,
      `分页样本 ${index}`,
    );
  for (let index = 0; index < 12; index += 1)
    insert.run(
      `diag_baseline_list_${index}`,
      Math.floor(Date.now() / 1000) + 1000 + index,
      "baseline.list",
      listRequestId,
      project.id,
      `同请求样本 ${index}`,
    );
});
seedRows();
console.log(
  "SEED " +
    JSON.stringify({
      email,
      password,
      userId: signedUp.user.id,
      projectId: project.id,
      listRequestId,
    }),
);
sqlite.close();
