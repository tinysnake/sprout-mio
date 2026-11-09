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

export const feishuDeliveryBoundary: ChannelRouteBoundary = {
  adapter: "feishu",
  assertCurrent(route) {
    const slot = db
      .select()
      .from(feishuIdentitySlot)
      .where(eq(feishuIdentitySlot.humanId, route.humanId))
      .get();
    const current = db
      .select()
      .from(feishuRoute)
      .where(and(eq(feishuRoute.id, route.routeId), isNull(feishuRoute.closedAtMs)))
      .get();
    const epoch = db
      .select()
      .from(feishuConnectionEpoch)
      .where(
        and(eq(feishuConnectionEpoch.id, route.epochId), isNull(feishuConnectionEpoch.closedAtMs)),
      )
      .get();
    if (
      !slot ||
      !current ||
      !epoch ||
      route.adapter !== "feishu" ||
      slot.revision !== route.revision ||
      current.revision !== route.revision ||
      current.humanId !== route.humanId ||
      current.projectId !== route.projectId ||
      current.chatId !== route.chatId ||
      slot.appId !== route.destination.appId ||
      slot.tenantKey !== route.destination.tenantKey ||
      slot.openId !== route.destination.openId ||
      epoch.appId !== slot.appId
    )
      throw new ChannelIneligible("inactive_route");
    channelSourceAccess(route);
  },
};

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
      .where(eq(feishuIdentitySlot.humanId, route.humanId))
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
}

export function emitNextFeishuDelivery<Prepared>(
  port: ChannelEmissionPort<Prepared>,
  options?: { now?: () => Date; timeoutMs?: number },
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
        scope.routeId !== route.routeId ||
        scope.revision !== route.revision ||
        scope.epoch.id !== route.epochId ||
        scope.epoch.appId !== identity.appId
      )
        throw new ChannelIneligible("identity_mismatch");
    },
    now,
  );
}
