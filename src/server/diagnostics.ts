import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { diagnosticEvent, project } from "../db/schema";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type { DiagnosticEvent } from "../contracts/diagnostics";

export type DiagnosticInput = Omit<DiagnosticEvent, "id" | "at">;
export type DiagnosticFilter = {
  actorId: string;
  requestId?: string;
  projectId?: string;
  limit?: number;
};

export function recordDiagnostic(input: DiagnosticInput): boolean {
  try {
    db.insert(diagnosticEvent)
      .values({
        ...input,
        id: newId(ID_PREFIXES.diagnostic),
        at: new Date(),
        data: input.data === undefined ? null : JSON.stringify(input.data),
      })
      .run();
    return true;
  } catch (error) {
    console.error("[diagnostics] 写入失败", {
      event: input.event,
      requestId: input.requestId,
      error: error instanceof Error ? error.message : "未知错误",
    });
    return false;
  }
}

export function queryDiagnostics(filter: DiagnosticFilter): DiagnosticEvent[] {
  const rows: (typeof diagnosticEvent.$inferSelect)[] = db
    .select()
    .from(diagnosticEvent)
    .where(
      and(
        or(
          isNull(diagnosticEvent.projectId),
          inArray(
            diagnosticEvent.projectId,
            db
              .select({ id: project.id })
              .from(project)
              .where(eq(project.createdBy, filter.actorId)),
          ),
        ),
        filter.requestId === undefined ? isNotNull(diagnosticEvent.projectId) : undefined,
        filter.requestId === undefined
          ? undefined
          : eq(diagnosticEvent.requestId, filter.requestId),
        filter.projectId === undefined
          ? undefined
          : eq(diagnosticEvent.projectId, filter.projectId),
      ),
    )
    .orderBy(desc(diagnosticEvent.at), desc(sql`rowid`))
    .limit(filter.limit ?? 50)
    .all();
  return rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    level: row.level,
    event: row.event,
    requestId: row.requestId,
    message: row.message,
    ...(row.projectId === null ? {} : { projectId: row.projectId }),
    ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
    ...(row.instanceId === null ? {} : { instanceId: row.instanceId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.executionId === null ? {} : { executionId: row.executionId }),
    ...(row.data === null ? {} : { data: JSON.parse(row.data) }),
  }));
}
