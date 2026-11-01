// 用应用自己那份 better-auth 的哈希器改密码，避免自己实现算法。
import { hashPassword } from "better-auth/crypto";

const [databaseUrl, email, password] = process.argv.slice(2);
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databaseUrl);
  const user = db.prepare("select id from user where email = ?").get(email);
  if (!user) throw new Error(`没有这个账号：${email}`);
  const account = db
    .prepare("select id from account where user_id = ? and provider_id = 'credential'")
    .get(user.id);
  if (!account) throw new Error(`账号 ${email} 没有密码凭据（可能只用了 OAuth）`);
  const hash = await hashPassword(password);
  db.prepare("update account set password = ?, updated_at = ? where id = ?").run(
    hash,
    Date.now(),
    account.id,
  );
  db.close();
  console.log(`PASS 已更新 ${email} 的密码`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
