import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
  channelActionGrant,
  channelActionReceipt,
  channelAttempt,
  channelDelivery,
} from "../db/schema";
import type {
  ChannelEmissionPort,
  ChannelEnvelope,
  ChannelNativeAction,
  ChannelOutcome,
  ChannelRequest,
  ChannelRoute,
  ChannelRouteBoundary,
} from "../contracts/channel";
import { AssistantError } from "./assistant";
import { ChatError } from "./chat";
import { ProjectAccessError } from "./access";
import {
  assertChannelAction,
  boundedChannelText,
  channelHash,
  ChannelIneligible,
  executeChannelAction,
  projectChannelMessage,
} from "./channel-native";

const RETRY_WINDOW_MS = 10 * 60_000;
const GRANT_LIFETIME_MS = 10 * 60_000;
export function isChannelIneligible(error: unknown) {
  return (
    error instanceof ChannelIneligible ||
    error instanceof AssistantError ||
    error instanceof ChatError ||
    error instanceof ProjectAccessError
  );
}

/** Called only from the source message's transaction; never scans history. */
export function captureChannelMessage(
  messageId: string,
  route: ChannelRoute,
  boundary: ChannelRouteBoundary,
  now: Date,
) {
  if (!sqlite.inTransaction) throw new Error("channel_capture_requires_source_transaction");
  let projection;
  try {
    boundary.assertCurrent(route);
    projection = projectChannelMessage(messageId, route, now);
  } catch (error) {
    if (isChannelIneligible(error)) return;
    throw error;
  }
  if (!projection) return;
  const id = randomUUID();
  const bounded = boundedChannelText(projection.text);
  const grants: { token: string; action: ChannelNativeAction }[] =
    bounded.kind === "text" && bounded.completeness !== "oversized"
      ? (projection.actions ?? []).map((action) => ({
          token: randomBytes(32).toString("base64url"),
          action,
        }))
      : [];
  const envelope: ChannelEnvelope = grants.length
    ? {
        kind: "card",
        text: projection.text,
        actions: grants.map(({ token, action }) => ({
          label: action.action === "confirm" ? "确认" : "拒绝",
          token,
        })),
      }
    : bounded;
  db.insert(channelDelivery)
    .values({
      id,
      adapter: route.adapter,
      messageId,
      route,
      envelope,
      state: "ready",
      uuid: randomUUID(),
      createdAtMs: now.getTime(),
      dueAtMs: now.getTime(),
      deadlineMs: now.getTime() + RETRY_WINDOW_MS,
    })
    .run();
  for (const { token, action } of grants)
    db.insert(channelActionGrant)
      .values({
        tokenHash: channelHash(token),
        deliveryId: id,
        action,
        expiresAtMs: now.getTime() + GRANT_LIFETIME_MS,
      })
      .run();
}

export function markChannelReplyIncomplete(messageId: string) {
  if (!sqlite.inTransaction) throw new Error("channel_capture_requires_source_transaction");
  for (const row of db
    .select()
    .from(channelDelivery)
    .where(and(eq(channelDelivery.messageId, messageId), eq(channelDelivery.state, "ready")))
    .all()) {
    if (row.envelope.kind === "text" && row.envelope.completeness === "complete")
      db.update(channelDelivery)
        .set({ envelope: boundedChannelText(row.envelope.text, true) })
        .where(eq(channelDelivery.id, row.id))
        .run();
  }
}

type Delivery = typeof channelDelivery.$inferSelect;
function assertDelivery(row: Delivery, boundary: ChannelRouteBoundary, now: Date) {
  if (row.adapter !== boundary.adapter) throw new ChannelIneligible("wrong_adapter");
  // The adapter prepared the request before the asynchronous phase. If the source
  // settlement changed the envelope meanwhile, that prepared payload is obsolete.
  const latest = db.select().from(channelDelivery).where(eq(channelDelivery.id, row.id)).get();
  if (!latest || JSON.stringify(latest.envelope) !== JSON.stringify(row.envelope))
    throw new ChannelIneligible("envelope_changed");
  boundary.assertCurrent(row.route);
  const projection = projectChannelMessage(row.messageId, row.route, now);
  if (!projection) throw new ChannelIneligible("projection_unavailable");
  const expected = boundedChannelText(
    projection.text,
    row.envelope.kind === "text" && row.envelope.completeness === "incomplete",
  );
  if (expected.text !== row.envelope.text) throw new ChannelIneligible("projection_changed");
  if (row.envelope.kind === "card") {
    const grants = db
      .select()
      .from(channelActionGrant)
      .where(eq(channelActionGrant.deliveryId, row.id))
      .all();
    if (!projection.actions || grants.length !== projection.actions.length)
      throw new ChannelIneligible("action_changed");
    for (const grant of grants) {
      if (
        grant.expiresAtMs <= now.getTime() ||
        !projection.actions.some(
          (action) => JSON.stringify(action) === JSON.stringify(grant.action),
        )
      )
        throw new ChannelIneligible("action_changed");
      assertChannelAction(grant.action, row.route, now);
    }
  }
}
function suppress(id: string, error: string) {
  db.update(channelDelivery)
    .set({ state: "suppressed", error })
    .where(eq(channelDelivery.id, id))
    .run();
}

/** At process startup only, before drain starts. Armed means a request may already exist. */
export function recoverChannelDeliveries(adapter: string) {
  return sqlite
    .transaction(() => {
      const armed = db
        .select()
        .from(channelDelivery)
        .where(and(eq(channelDelivery.adapter, adapter), eq(channelDelivery.state, "armed")))
        .all();
      for (const row of armed) {
        db.update(channelDelivery)
          .set({ state: "uncertain", error: "restart_after_armed" })
          .where(eq(channelDelivery.id, row.id))
          .run();
        db.update(channelAttempt)
          .set({ outcome: "uncertain", code: "restart_after_armed" })
          .where(and(eq(channelAttempt.deliveryId, row.id), eq(channelAttempt.outcome, "armed")))
          .run();
      }
      return armed.length;
    })
    .immediate();
}

function recordOutcome(row: Delivery, attemptId: string, outcome: ChannelOutcome, now: Date) {
  sqlite
    .transaction(() => {
      const current = db
        .select()
        .from(channelDelivery)
        .where(eq(channelDelivery.id, row.id))
        .get()!;
      // Late receipts belong to the frozen attempt, even after disconnect/recovery.
      if (outcome.kind === "accepted" && outcome.messageId.trim()) {
        db.update(channelAttempt)
          .set({ outcome: "accepted", platformMessageId: outcome.messageId })
          .where(eq(channelAttempt.id, attemptId))
          .run();
        db.update(channelDelivery)
          .set({ state: "accepted", platformMessageId: outcome.messageId, error: null })
          .where(eq(channelDelivery.id, row.id))
          .run();
        return;
      }
      if (outcome.kind === "not_accepted") {
        const retry =
          current.state === "armed" &&
          outcome.code !== "invalid_payload" &&
          current.attempts < 3 &&
          now.getTime() + 1_000 < row.deadlineMs;
        db.update(channelAttempt)
          .set({ outcome: "not_accepted", code: outcome.code })
          .where(eq(channelAttempt.id, attemptId))
          .run();
        db.update(channelDelivery)
          .set({
            state: retry ? "ready" : "failed",
            dueAtMs: now.getTime() + 1_000 * current.attempts,
            error: outcome.code,
          })
          .where(eq(channelDelivery.id, row.id))
          .run();
        return;
      }
      const code = outcome.kind === "uncertain" ? outcome.code : "missing_receipt";
      db.update(channelAttempt)
        .set({ outcome: "uncertain", code })
        .where(eq(channelAttempt.id, attemptId))
        .run();
      db.update(channelDelivery)
        .set({ state: "uncertain", error: code })
        .where(eq(channelDelivery.id, row.id))
        .run();
    })
    .immediate();
}

function deadlineCompletion(
  completion: Promise<ChannelOutcome>,
  timeoutMs: number,
): Promise<ChannelOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "uncertain", code: "timeout" }), timeoutMs);
    completion.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "uncertain", code: "ack_lost" });
      },
    );
  });
}

export async function emitNextChannelDelivery<Prepared>(
  boundary: ChannelRouteBoundary,
  port: ChannelEmissionPort<Prepared>,
  options: { now?: () => Date; timeoutMs?: number } = {},
) {
  if (sqlite.inTransaction) throw new Error("channel_emission_requires_no_transaction");
  const clock = options.now ?? (() => new Date());
  // Filter terminal jobs in SQL so an old failure cannot starve other DMs.
  const row = db
    .select()
    .from(channelDelivery)
    .where(
      and(
        eq(channelDelivery.adapter, boundary.adapter),
        eq(channelDelivery.state, "ready"),
        lte(channelDelivery.dueAtMs, clock().getTime()),
      ),
    )
    .orderBy(asc(channelDelivery.dueAtMs), asc(channelDelivery.id))
    .get();
  if (!row) return null;
  try {
    assertDelivery(row, boundary, clock());
  } catch (error) {
    if (!isChannelIneligible(error)) throw error;
    suppress(row.id, "ineligible_before_prepare");
    return row.id;
  }
  if (clock().getTime() >= row.deadlineMs || row.attempts >= 3) {
    db.update(channelDelivery)
      .set({ state: "failed", error: "retry_deadline" })
      .where(eq(channelDelivery.id, row.id))
      .run();
    return row.id;
  }
  const request: ChannelRequest = {
    deliveryId: row.id,
    uuid: row.uuid,
    route: structuredClone(row.route),
    envelope: structuredClone(row.envelope),
  };
  let prepared: Prepared;
  try {
    prepared = await port.prepare(request);
  } catch {
    // Preparation cannot create a platform request. Bound failures instead of spinning.
    db.update(channelDelivery)
      .set({ state: "failed", error: "prepare_failed" })
      .where(and(eq(channelDelivery.id, row.id), eq(channelDelivery.state, "ready")))
      .run();
    return row.id;
  }
  const attemptId = randomUUID();
  const armed = sqlite
    .transaction(() => {
      const current = db
        .select()
        .from(channelDelivery)
        .where(eq(channelDelivery.id, row.id))
        .get()!;
      if (current.state !== "ready" || current.attempts !== row.attempts) return false;
      db.insert(channelAttempt)
        .values({
          id: attemptId,
          deliveryId: row.id,
          number: row.attempts + 1,
          armedAtMs: clock().getTime(),
          outcome: "armed",
        })
        .run();
      db.update(channelDelivery)
        .set({ state: "armed", attempts: row.attempts + 1 })
        .where(eq(channelDelivery.id, row.id))
        .run();
      return true;
    })
    .immediate();
  if (!armed) return row.id;
  let completion: Promise<ChannelOutcome> | undefined;
  try {
    sqlite
      .transaction(() => {
        try {
          assertDelivery(row, boundary, clock());
          if (clock().getTime() >= row.deadlineMs) throw new ChannelIneligible("retry_deadline");
        } catch (error) {
          if (!isChannelIneligible(error)) throw error;
          suppress(row.id, "ineligible_before_begin");
          db.update(channelAttempt)
            .set({ outcome: "suppressed", code: "ineligible_before_begin" })
            .where(eq(channelAttempt.id, attemptId))
            .run();
          return;
        }
        const handle = port.begin(prepared);
        if (
          !handle ||
          typeof (handle as unknown as { then?: unknown }).then === "function" ||
          handle.initiated !== true ||
          !(handle.completion instanceof Promise)
        )
          throw new Error("channel_port_begin_must_initiate_synchronously");
        completion = handle.completion;
        // Observe a rejection even if the transaction's COMMIT fails after begin.
        void completion.catch(() => undefined);
      })
      .immediate();
  } catch {
    // begin can throw after request creation, and COMMIT can fail after begin.
    recordOutcome(row, attemptId, { kind: "uncertain", code: "ambiguous" }, clock());
    return row.id;
  }
  if (completion) {
    const outcome = await deadlineCompletion(completion, options.timeoutMs ?? 30_000);
    recordOutcome(row, attemptId, outcome, clock());
    if (outcome.kind === "uncertain") {
      void completion
        .then(
          (late) => {
            if (late.kind === "accepted") recordOutcome(row, attemptId, late, clock());
          },
          () => undefined,
        )
        .catch(() => {
          console.error("channel_late_receipt_persist_failed", row.id);
        });
    }
  }
  return row.id;
}

export function consumeChannelAction(
  token: string,
  boundary: ChannelRouteBoundary,
  authorizeIdentity: (route: ChannelRoute) => void,
  now = new Date(),
) {
  return sqlite
    .transaction(() => {
      const grant = db
        .select()
        .from(channelActionGrant)
        .where(eq(channelActionGrant.tokenHash, channelHash(token)))
        .get();
      if (!grant || grant.expiresAtMs <= now.getTime())
        throw new ChannelIneligible("grant_unavailable");
      const delivery = db
        .select()
        .from(channelDelivery)
        .where(eq(channelDelivery.id, grant.deliveryId))
        .get()!;
      if (delivery.adapter !== boundary.adapter) throw new ChannelIneligible("wrong_adapter");
      authorizeIdentity(delivery.route);
      boundary.assertActionCurrent(delivery.route);
      const receipt = db
        .select()
        .from(channelActionReceipt)
        .where(eq(channelActionReceipt.tokenHash, grant.tokenHash))
        .get();
      assertChannelAction(grant.action, delivery.route, now, !!receipt);
      if (receipt) return receipt.result;
      const result = executeChannelAction(grant.action, delivery.route, now);
      db.insert(channelActionReceipt)
        .values({ tokenHash: grant.tokenHash, result, consumedAtMs: now.getTime() })
        .run();
      return result;
    })
    .immediate();
}
