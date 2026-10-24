import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { hashCredential } from "../../src/domain/machine";
import type { AgentRemoteContext } from "../../src/server/lease";

/** Private fixtures only; production grants are created by pi-host, never by callers. */
export function seedRemoteActor(
  sqlite: Database.Database,
  userId: string,
  projectId: string,
  bootId: string,
  persistGrant = true,
): AgentRemoteContext {
  const profileId = newId(ID_PREFIXES.agentProfile);
  const chatId = newId(ID_PREFIXES.chat);
  const instanceId = newId(ID_PREFIXES.instance);
  const runId = `run_${randomUUID()}`;
  const grantId = newId(ID_PREFIXES.remoteToolGrant);
  sqlite
    .prepare("INSERT INTO agent_profile(id,name,created_by) VALUES (?,'Remote fixture',?)")
    .run(profileId, userId);
  sqlite
    .prepare("INSERT INTO chat(id,project_id,kind,created_by) VALUES (?,?,'dm',?)")
    .run(chatId, projectId, userId);
  sqlite
    .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)")
    .run(chatId, profileId);
  sqlite
    .prepare("INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)")
    .run(instanceId, profileId, chatId, projectId);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
    )
    .run(
      runId,
      instanceId,
      chatId,
      projectId,
      newId(ID_PREFIXES.request),
      Math.floor(Date.now() / 1000),
      randomBytes(16).toString("hex"),
    );
  if (persistGrant)
    sqlite
      .prepare(
        "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        grantId,
        hashCredential(randomBytes(32).toString("base64url")),
        userId,
        projectId,
        chatId,
        instanceId,
        runId,
        Date.now(),
        Date.now() + 3600000,
      );
  return {
    userId,
    projectId,
    chatId,
    instanceId,
    runId,
    grantId,
    bootId,
    now: new Date(),
    requestId: newId(ID_PREFIXES.request),
  };
}
