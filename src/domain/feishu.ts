import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type {
  FeishuAdmission,
  FeishuAdmissionScope,
  FeishuBinding,
  FeishuEpoch,
  FeishuTarget,
  VerifiedFeishuEvent,
  VerifiedFeishuIdentity,
} from "../contracts/feishu";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  feishuChallenge,
  feishuConnectionEpoch,
  feishuIdentitySlot,
  feishuInboundReceipt,
  feishuRoute,
  diagnosticEvent,
} from "../db/schema";
import { ProjectAccessError, type ProjectContext } from "./access";
import { AssistantError, assistantSource } from "./assistant";
import { ChatError, sendMessage } from "./chat";
import type { IdentityWriteHooks } from "./identity-write";

export class FeishuBindingError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "target_unavailable"
      | "already_bound"
      | "identity_conflict"
      | "invalid_challenge"
      | "revision_conflict"
      | "not_bound",
  ) {
    super(`Feishu binding: ${code}`);
  }
}

function humanOnly(ctx: ProjectContext) {
  if (ctx.agent) throw new FeishuBindingError("forbidden");
}

function eligible(target: FeishuTarget, ctx: ProjectContext) {
  humanOnly(ctx);
  try {
    const { current } = assistantSource(target.chatId, ctx);
    if (current.projectId !== target.projectId) throw new FeishuBindingError("target_unavailable");
  } catch (error) {
    if (
      error instanceof AssistantError ||
      error instanceof ChatError ||
      error instanceof ProjectAccessError
    )
      throw new FeishuBindingError("target_unavailable");
    throw error;
  }
}

function audit(
  event: string,
  requestId: string,
  target?: FeishuTarget,
  hooks: IdentityWriteHooks = {},
) {
  hooks.afterWrite?.();
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: new Date(),
      level: "info",
      event: `feishu.${event}`,
      message: `Feishu ${event}`,
      requestId,
      ...(target ? { projectId: target.projectId, chatId: target.chatId } : {}),
    })
    .run();
}

const digest = (opaque: string) => createHash("sha256").update(opaque).digest("hex");

/** 绑定码要在飞书私聊里手打，所以只用无歧义字符：8 位 = 40 bit。 */
const CHALLENGE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function compactChallengeCode(value: string): string | null {
  const compact = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (compact.length !== 8) return null;
  for (const character of compact) {
    if (!CHALLENGE_ALPHABET.includes(character)) return null;
  }
  return compact;
}

/** 入站文本只有这种形状才当绑定码处理，其余一律是普通消息。 */
export function isFeishuChallengeCode(text: string): boolean {
  return compactChallengeCode(text) !== null;
}

function newChallengeCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += CHALLENGE_ALPHABET[byte & 31];
  return code;
}
const slotFor = (humanId: string, projectId: string) =>
  db
    .select()
    .from(feishuIdentitySlot)
    .where(
      and(eq(feishuIdentitySlot.humanId, humanId), eq(feishuIdentitySlot.projectId, projectId)),
    )
    .get();
const activeRoute = (humanId: string, projectId: string) =>
  db
    .select()
    .from(feishuRoute)
    .where(
      and(
        eq(feishuRoute.humanId, humanId),
        eq(feishuRoute.projectId, projectId),
        isNull(feishuRoute.closedAtMs),
      ),
    )
    .get();

export function getFeishuBinding(projectId: string, ctx: ProjectContext): FeishuBinding {
  humanOnly(ctx);
  const slot = slotFor(ctx.userId, projectId);
  const route = activeRoute(ctx.userId, projectId);
  return {
    revision: slot?.revision ?? 0,
    bound: !!slot?.appId,
    ...(route ? { route: { id: route.id, projectId: route.projectId, chatId: route.chatId } } : {}),
  };
}

/**
 * 绑定页只读：当前 Human 未消费且未过期的挑战码还剩多久。
 * 只回过期时间，不回摘要——挑战码本身只在发起时出现一次。
 */
export function readFeishuChallenge(
  projectId: string,
  ctx: ProjectContext,
  now = new Date(),
): { expiresAtMs: number } | null {
  humanOnly(ctx);
  if (!slotFor(ctx.userId, projectId)) return null;
  const row = db
    .select()
    .from(feishuChallenge)
    .where(
      and(
        eq(feishuChallenge.humanId, ctx.userId),
        eq(feishuChallenge.projectId, projectId),
        isNull(feishuChallenge.consumedAtMs),
        gt(feishuChallenge.expiresAtMs, now.getTime()),
      ),
    )
    .orderBy(desc(feishuChallenge.expiresAtMs))
    .get();
  return row ? { expiresAtMs: row.expiresAtMs } : null;
}

export function startFeishuChallenge(
  target: FeishuTarget,
  ctx: ProjectContext,
  now = new Date(),
  hooks: IdentityWriteHooks = {},
): { challenge: string; expiresAtMs: number; revision: number } {
  return sqlite
    .transaction(() => {
      eligible(target, ctx);
      const projectId = target.projectId;
      const old = slotFor(ctx.userId, projectId);
      if (old?.appId) throw new FeishuBindingError("already_bound");
      const revision = (old?.revision ?? 0) + 1;
      db.insert(feishuIdentitySlot)
        .values({ humanId: ctx.userId, projectId: target.projectId, revision })
        .onConflictDoUpdate({
          target: [feishuIdentitySlot.humanId, feishuIdentitySlot.projectId],
          set: { revision },
        })
        .run();
      const code = newChallengeCode();
      const challenge = `${code.slice(0, 4)}-${code.slice(4)}`;
      const expiresAtMs = now.getTime() + 10 * 60 * 1000;
      db.insert(feishuChallenge)
        .values({
          hash: digest(code),
          humanId: ctx.userId,
          revision,
          projectId: target.projectId,
          chatId: target.chatId,
          expiresAtMs,
        })
        .run();
      audit("challenge_started", ctx.requestId, target, hooks);
      return { challenge, expiresAtMs, revision };
    })
    .immediate();
}

function insertRoute(
  humanId: string,
  revision: number,
  identity: Pick<VerifiedFeishuIdentity, "appId" | "tenantKey" | "openId">,
  target: FeishuTarget,
  openedAt: Date,
) {
  db.insert(feishuRoute)
    .values({
      id: newId(ID_PREFIXES.feishuRoute),
      humanId,
      revision,
      appId: identity.appId,
      tenantKey: identity.tenantKey,
      openId: identity.openId,
      openedAtMs: openedAt.getTime(),
      projectId: target.projectId,
      chatId: target.chatId,
    })
    .run();
}

export function finishFeishuChallenge(
  projectId: string,
  opaque: string,
  identity: VerifiedFeishuIdentity,
  requestId: string,
  now = new Date(),
  hooks: IdentityWriteHooks = {},
): FeishuBinding {
  return sqlite
    .transaction(() => {
      const code = compactChallengeCode(opaque);
      const challenge =
        code &&
        db
          .select()
          .from(feishuChallenge)
          .where(eq(feishuChallenge.hash, digest(code)))
          .get();
      const slot = challenge && slotFor(challenge.humanId, projectId);
      if (
        !challenge ||
        challenge.projectId !== projectId ||
        !slot ||
        challenge.consumedAtMs !== null ||
        challenge.expiresAtMs <= now.getTime() ||
        challenge.revision !== slot.revision ||
        !identity.appId ||
        !identity.tenantKey ||
        !identity.openId
      )
        throw new FeishuBindingError("invalid_challenge");
      if (slot.appId) throw new FeishuBindingError("already_bound");
      const conflict = db
        .select()
        .from(feishuIdentitySlot)
        .where(
          and(
            eq(feishuIdentitySlot.appId, identity.appId),
            eq(feishuIdentitySlot.tenantKey, identity.tenantKey),
            eq(feishuIdentitySlot.openId, identity.openId),
          ),
        )
        .get();
      if (conflict) throw new FeishuBindingError("identity_conflict");
      const ctx = { userId: slot.humanId, requestId };
      eligible(challenge, ctx);
      const revision = slot.revision + 1;
      db.update(feishuIdentitySlot)
        .set({
          revision,
          appId: identity.appId,
          tenantKey: identity.tenantKey,
          openId: identity.openId,
        })
        .where(
          and(
            eq(feishuIdentitySlot.humanId, slot.humanId),
            eq(feishuIdentitySlot.projectId, projectId),
          ),
        )
        .run();
      db.update(feishuChallenge)
        .set({ consumedAtMs: now.getTime() })
        .where(eq(feishuChallenge.hash, challenge.hash))
        .run();
      insertRoute(slot.humanId, revision, identity, challenge, now);
      audit(
        "identity_bound",
        requestId,
        { projectId: challenge.projectId, chatId: challenge.chatId },
        hooks,
      );
      return getFeishuBinding(projectId, ctx);
    })
    .immediate();
}

function expectedSlot(projectId: string, ctx: ProjectContext, expectedRevision: number) {
  humanOnly(ctx);
  const slot = slotFor(ctx.userId, projectId);
  if (!slot || slot.revision !== expectedRevision)
    throw new FeishuBindingError("revision_conflict");
  return slot;
}

function closeRoutes(humanId: string, projectId: string, now: Date) {
  db.update(feishuRoute)
    .set({ closedAtMs: now.getTime() })
    .where(
      and(
        eq(feishuRoute.humanId, humanId),
        eq(feishuRoute.projectId, projectId),
        isNull(feishuRoute.closedAtMs),
      ),
    )
    .run();
}

export function switchFeishuTarget(
  target: FeishuTarget,
  expectedRevision: number,
  ctx: ProjectContext,
  now = new Date(),
  hooks: IdentityWriteHooks = {},
): FeishuBinding {
  return sqlite
    .transaction(() => {
      const projectId = target.projectId;
      eligible(target, ctx);
      const slot = expectedSlot(projectId, ctx, expectedRevision);
      if (!slot.appId || !slot.tenantKey || !slot.openId) throw new FeishuBindingError("not_bound");
      closeRoutes(ctx.userId, projectId, now);
      const revision = slot.revision + 1;
      db.update(feishuIdentitySlot)
        .set({ revision })
        .where(
          and(
            eq(feishuIdentitySlot.humanId, ctx.userId),
            eq(feishuIdentitySlot.projectId, projectId),
          ),
        )
        .run();
      insertRoute(
        ctx.userId,
        revision,
        { appId: slot.appId, tenantKey: slot.tenantKey, openId: slot.openId },
        target,
        now,
      );
      audit("target_switched", ctx.requestId, target, hooks);
      return getFeishuBinding(projectId, ctx);
    })
    .immediate();
}

export function unbindFeishuIdentity(
  projectId: string,
  expectedRevision: number,
  ctx: ProjectContext,
  now = new Date(),
  hooks: IdentityWriteHooks = {},
): FeishuBinding {
  return sqlite
    .transaction(() => {
      const slot = expectedSlot(projectId, ctx, expectedRevision);
      closeRoutes(ctx.userId, projectId, now);
      db.update(feishuIdentitySlot)
        .set({
          revision: slot.revision + 1,
          appId: null,
          tenantKey: null,
          openId: null,
        })
        .where(
          and(
            eq(feishuIdentitySlot.humanId, ctx.userId),
            eq(feishuIdentitySlot.projectId, projectId),
          ),
        )
        .run();
      audit("identity_unbound", ctx.requestId, undefined, hooks);
      return getFeishuBinding(projectId, ctx);
    })
    .immediate();
}

/** 由本机连接装配持有；不得以平台事件 payload 开放 epoch。 */
export function createFeishuConnectionLifecycle(
  appId: string,
  requestId: string,
  now = new Date(),
) {
  if (!appId) throw new Error("Feishu appId required");
  const closeOpen = (at: Date) =>
    db
      .update(feishuConnectionEpoch)
      .set({ closedAtMs: at.getTime() })
      .where(and(eq(feishuConnectionEpoch.appId, appId), isNull(feishuConnectionEpoch.closedAtMs)))
      .run();
  sqlite
    .transaction(() => {
      closeOpen(now);
      audit("connection_started", requestId);
    })
    .immediate();
  const open = (openedBy: "ready" | "reconnected", at: Date): FeishuEpoch =>
    sqlite
      .transaction(() => {
        closeOpen(at);
        const id = newId(ID_PREFIXES.feishuEpoch);
        db.insert(feishuConnectionEpoch)
          .values({ id, appId, openedAtMs: at.getTime(), openedBy })
          .run();
        audit(`connection_${openedBy}`, requestId);
        return { id, appId } as FeishuEpoch;
      })
      .immediate();
  return {
    ready: (at = new Date()) => open("ready", at),
    reconnected: (at = new Date()) => open("reconnected", at),
    disconnected: (epoch: FeishuEpoch, at = new Date()) =>
      sqlite
        .transaction(() => {
          if (epoch.appId !== appId) return;
          const result = db
            .update(feishuConnectionEpoch)
            .set({ closedAtMs: at.getTime() })
            .where(
              and(
                eq(feishuConnectionEpoch.id, epoch.id),
                eq(feishuConnectionEpoch.appId, appId),
                isNull(feishuConnectionEpoch.closedAtMs),
              ),
            )
            .run();
          if (result.changes) audit("connection_disconnected", requestId);
        })
        .immediate(),
  };
}

function identitySlot(identity: VerifiedFeishuIdentity) {
  return db
    .select()
    .from(feishuIdentitySlot)
    .where(
      and(
        eq(feishuIdentitySlot.appId, identity.appId),
        eq(feishuIdentitySlot.tenantKey, identity.tenantKey),
        eq(feishuIdentitySlot.openId, identity.openId),
      ),
    )
    .get();
}

export function captureFeishuAdmissionScope(
  projectId: string,
  identity: VerifiedFeishuIdentity,
  epoch: FeishuEpoch,
): FeishuAdmissionScope | undefined {
  return sqlite
    .transaction(() => {
      const slot = identitySlot(identity);
      const route =
        slot?.projectId === projectId ? activeRoute(slot.humanId, projectId) : undefined;
      const currentEpoch = db
        .select()
        .from(feishuConnectionEpoch)
        .where(
          and(
            eq(feishuConnectionEpoch.id, epoch.id),
            eq(feishuConnectionEpoch.appId, identity.appId),
            isNull(feishuConnectionEpoch.closedAtMs),
          ),
        )
        .get();
      if (!slot || !route || !currentEpoch || epoch.appId !== identity.appId) return undefined;
      return { projectId, routeId: route.id, revision: slot.revision, epoch };
    })
    .immediate();
}

export function admitFeishuText(
  event: VerifiedFeishuEvent,
  scope: FeishuAdmissionScope,
  requestId: string,
  hooks: IdentityWriteHooks = {},
): FeishuAdmission {
  return sqlite
    .transaction((): FeishuAdmission => {
      const reject = (
        reason: Extract<FeishuAdmission, { status: "rejected" }>["reason"],
      ): FeishuAdmission => ({ status: "rejected", reason });
      if (
        event.chatType !== "p2p" ||
        event.messageType !== "text" ||
        !event.body?.trim() ||
        !event.messageId
      )
        return reject("unsupported_input");
      if (!Number.isSafeInteger(event.createdAtMs) || (event.createdAtMs ?? 0) <= 0)
        return reject("untrusted_timestamp");
      const epoch = db
        .select()
        .from(feishuConnectionEpoch)
        .where(
          and(
            eq(feishuConnectionEpoch.id, scope.epoch.id),
            eq(feishuConnectionEpoch.appId, event.identity.appId),
            isNull(feishuConnectionEpoch.closedAtMs),
          ),
        )
        .get();
      if (!epoch || scope.epoch.appId !== event.identity.appId) return reject("inactive_epoch");
      if (event.createdAtMs! < epoch.openedAtMs) return reject("pre_epoch_message");
      const slot = identitySlot(event.identity);
      if (!slot) return reject("identity_mismatch");
      const route = activeRoute(slot.humanId, scope.projectId);
      if (
        !route ||
        route.id !== scope.routeId ||
        route.revision !== scope.revision ||
        slot.revision !== scope.revision
      )
        return reject("inactive_route");
      if (
        route.appId !== event.identity.appId ||
        route.tenantKey !== event.identity.tenantKey ||
        route.openId !== event.identity.openId
      )
        return reject("identity_mismatch");
      if (event.createdAtMs! < route.openedAtMs) return reject("pre_route_message");
      const ctx = { userId: slot.humanId, requestId };
      try {
        eligible(route, ctx);
      } catch (error) {
        if (error instanceof FeishuBindingError) return reject("target_unavailable");
        throw error;
      }
      const old = db
        .select()
        .from(feishuInboundReceipt)
        .where(
          and(
            eq(feishuInboundReceipt.appId, event.identity.appId),
            eq(feishuInboundReceipt.platformMessageId, event.messageId),
          ),
        )
        .get();
      if (old) {
        if (old.routeId !== route.id || old.epochId !== epoch.id)
          return reject("receipt_scope_mismatch");
        return { status: "accepted", messageId: old.messageId, duplicate: true };
      }
      const saved = sendMessage(
        route.chatId,
        { senderKind: "human", senderId: slot.humanId, body: event.body },
        ctx,
        hooks,
      );
      db.insert(feishuInboundReceipt)
        .values({
          appId: event.identity.appId,
          platformMessageId: event.messageId,
          routeId: route.id,
          epochId: epoch.id,
          messageId: saved.id,
          createdAtMs: event.createdAtMs!,
        })
        .run();
      return { status: "accepted", messageId: saved.id, duplicate: false };
    })
    .immediate();
}
