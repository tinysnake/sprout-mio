import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { feishuConnectionEpoch, feishuIdentitySlot, feishuRoute, message } from "../db/schema";
import type { ChannelEmissionPort, ChannelRoute, ChannelRouteBoundary } from "../contracts/channel";
import type { FeishuAdmissionScope, VerifiedFeishuIdentity } from "../contracts/feishu";
import {
  captureChannelMessage,
  consumeChannelAction,
  emitNextChannelDelivery,
} from "./channel-delivery";
import { channelSourceAccess, ChannelIneligible } from "./channel-native";

function routeFence(route: ChannelRoute) {
  const slot = db
    .select()
    .from(feishuIdentitySlot)
    .where(
      and(
        eq(feishuIdentitySlot.humanId, route.humanId),
        eq(feishuIdentitySlot.projectId, route.projectId),
      ),
    )
    .get();
  const current = db
    .select()
    .from(feishuRoute)
    .where(and(eq(feishuRoute.id, route.routeId), isNull(feishuRoute.closedAtMs)))
    .get();
  if (
    !slot ||
    !current ||
    route.adapter !== "feishu" ||
    slot.revision !== route.revision ||
    current.revision !== route.revision ||
    current.humanId !== route.humanId ||
    current.projectId !== route.projectId ||
    current.chatId !== route.chatId ||
    slot.appId !== route.destination.appId ||
    slot.tenantKey !== route.destination.tenantKey ||
    slot.openId !== route.destination.openId
  )
    throw new ChannelIneligible("inactive_route");
  channelSourceAccess(route);
  return slot;
}

export const feishuDeliveryBoundary: ChannelRouteBoundary = {
  adapter: "feishu",
  assertCurrent(route) {
    const slot = routeFence(route);
    const epoch = db
      .select()
      .from(feishuConnectionEpoch)
      .where(
        and(eq(feishuConnectionEpoch.id, route.epochId), isNull(feishuConnectionEpoch.closedAtMs)),
      )
      .get();
    if (!epoch || epoch.appId !== slot.appId) throw new ChannelIneligible("inactive_epoch");
  },
  assertActionCurrent(route) {
    routeFence(route);
  },
};

const deliveryWakes = new Map<string, () => void>();

/**
 * 服务端装配时注册的「有新投递」唤醒。领域层不能 import server，
 * 所以用这个单向钩子；没有装配时（例如纯领域测试）就退化为空闲轮询。
 */
export function setFeishuDeliveryWake(projectId: string, wake: (() => void) | null) {
  if (wake) deliveryWakes.set(projectId, wake);
  else deliveryWakes.delete(projectId);
}

function wakeDelivery(): void {
  try {
    for (const wake of deliveryWakes.values()) wake();
  } catch {
    // 唤醒失败不影响已经提交的投递，空闲轮询会兜住。
  }
}

export function captureFeishuMessage(messageId: string, now: Date) {
  const source = db.select().from(message).where(eq(message.id, messageId)).get();
  if (!source || !["agent", "assistant_event"].includes(source.senderKind)) return;
  const routes = db
    .select()
    .from(feishuRoute)
    .where(and(eq(feishuRoute.chatId, source.chatId), isNull(feishuRoute.closedAtMs)))
    .all();
  for (const route of routes) {
    const slot = db
      .select()
      .from(feishuIdentitySlot)
      .where(
        and(
          eq(feishuIdentitySlot.humanId, route.humanId),
          eq(feishuIdentitySlot.projectId, route.projectId),
        ),
      )
      .get();
    if (!slot?.appId || !slot.tenantKey || !slot.openId) continue;
    const epoch = db
      .select()
      .from(feishuConnectionEpoch)
      .where(
        and(eq(feishuConnectionEpoch.appId, slot.appId), isNull(feishuConnectionEpoch.closedAtMs)),
      )
      .get();
    if (!epoch) continue;
    captureChannelMessage(
      messageId,
      {
        adapter: "feishu",
        routeId: route.id,
        revision: route.revision,
        epochId: epoch.id,
        humanId: route.humanId,
        projectId: route.projectId,
        chatId: route.chatId,
        destination: { appId: slot.appId, tenantKey: slot.tenantKey, openId: slot.openId },
      },
      feishuDeliveryBoundary,
      now,
    );
  }
  if (routes.length > 0) wakeDelivery();
}

export function emitNextFeishuDelivery<Prepared>(
  port: ChannelEmissionPort<Prepared>,
  options?: { projectId?: string; now?: () => Date; timeoutMs?: number },
) {
  return emitNextChannelDelivery(feishuDeliveryBoundary, port, options);
}

// Only a verified adapter identity and its current F1 admission scope authorize this entry.
export function consumeFeishuAction(
  identity: VerifiedFeishuIdentity,
  scope: FeishuAdmissionScope,
  token: string,
  now = new Date(),
) {
  return consumeChannelAction(
    token,
    feishuDeliveryBoundary,
    (route: ChannelRoute) => {
      if (
        identity.appId !== route.destination.appId ||
        identity.tenantKey !== route.destination.tenantKey ||
        identity.openId !== route.destination.openId ||
        scope.projectId !== route.projectId ||
        scope.routeId !== route.routeId ||
        scope.revision !== route.revision ||
        scope.epoch.appId !== identity.appId
      )
        throw new ChannelIneligible("identity_mismatch");
    },
    now,
  );
}
