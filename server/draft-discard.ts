import {
  contentDrafts,
  idempotencyKeys,
  publishJobs,
  publishJobTasks,
  type Draft,
} from "@shared/schema";
import { db } from "./db";
import { and, eq, sql } from "drizzle-orm";

export type DraftDiscardPlan = {
  draftId: number;
  draft: Pick<Draft, "id" | "title" | "status" | "strapiDocumentId" | "contentType" | "createdBy"> | null;
  idempotencyKeys: number;
  publishJobs: number;
  publishJobTasks: number;
};

export type DraftDiscardResult = {
  dryRun: boolean;
  deleted: boolean;
  plan: DraftDiscardPlan;
};

function logDiscard(event: string, payload: Record<string, unknown>) {
  console.log(`[draft.discard] ${event} ${JSON.stringify(payload)}`);
}

export async function getDraftDiscardPlan(draftId: number, userId?: string): Promise<DraftDiscardPlan> {
  const draftWhere = userId
    ? and(eq(contentDrafts.id, draftId), eq(contentDrafts.createdBy, userId))
    : eq(contentDrafts.id, draftId);
  const [draft] = await db
    .select({
      id: contentDrafts.id,
      title: contentDrafts.title,
      status: contentDrafts.status,
      strapiDocumentId: contentDrafts.strapiDocumentId,
      contentType: contentDrafts.contentType,
      createdBy: contentDrafts.createdBy,
    })
    .from(contentDrafts)
    .where(draftWhere);

  const [[idem], [jobs], [tasks]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.draftId, draftId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(publishJobs)
      .where(eq(publishJobs.draftId, draftId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(publishJobTasks)
      .where(eq(publishJobTasks.draftId, draftId)),
  ]);

  return {
    draftId,
    draft: draft ?? null,
    idempotencyKeys: idem?.count ?? 0,
    publishJobs: jobs?.count ?? 0,
    publishJobTasks: tasks?.count ?? 0,
  };
}

async function assertNoDraftReferences(tx: Pick<typeof db, "select">, draftId: number) {
  const [[idem], [jobs], [tasks]] = await Promise.all([
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.draftId, draftId)),
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(publishJobs)
      .where(eq(publishJobs.draftId, draftId)),
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(publishJobTasks)
      .where(eq(publishJobTasks.draftId, draftId)),
  ]);
  const remaining =
    (idem?.count ?? 0) + (jobs?.count ?? 0) + (tasks?.count ?? 0);
  if (remaining > 0) {
    throw new Error(
      `Draft discard integrity check failed: draft ${draftId} still has ${remaining} dependent row(s)`,
    );
  }
}

/**
 * Idempotent discard: validate → remove publish tasks/jobs + idempotency keys → delete draft.
 * Safe to retry after partial failure (transaction rolls back).
 */
export async function discardDraftWithDependencies(opts: {
  draftId: number;
  userId?: string;
  dryRun?: boolean;
}): Promise<DraftDiscardResult> {
  const { draftId, userId, dryRun = false } = opts;
  const plan = await getDraftDiscardPlan(draftId, userId);

  logDiscard(dryRun ? "plan" : "start", {
    draftId,
    userId: userId ?? null,
    dryRun,
    title: plan.draft?.title ?? null,
    idempotencyKeys: plan.idempotencyKeys,
    publishJobs: plan.publishJobs,
    publishJobTasks: plan.publishJobTasks,
  });

  if (!plan.draft) {
    return { dryRun, deleted: false, plan };
  }

  if (dryRun) {
    return { dryRun: true, deleted: false, plan };
  }

  const deleted = await db.transaction(async (tx) => {
    const draftWhere = userId
      ? and(eq(contentDrafts.id, draftId), eq(contentDrafts.createdBy, userId))
      : eq(contentDrafts.id, draftId);

    const tasksRemoved = await tx
      .delete(publishJobTasks)
      .where(eq(publishJobTasks.draftId, draftId))
      .returning({ id: publishJobTasks.id });
    const jobsRemoved = await tx
      .delete(publishJobs)
      .where(eq(publishJobs.draftId, draftId))
      .returning({ id: publishJobs.id });
    const idemRemoved = await tx
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.draftId, draftId))
      .returning({ key: idempotencyKeys.key });
    const draftsRemoved = await tx.delete(contentDrafts).where(draftWhere).returning({ id: contentDrafts.id });

    await assertNoDraftReferences(tx, draftId);

    logDiscard("done", {
      draftId,
      publishJobTasksRemoved: tasksRemoved.length,
      publishJobsRemoved: jobsRemoved.length,
      idempotencyKeysRemoved: idemRemoved.length,
      draftsRemoved: draftsRemoved.length,
    });

    return draftsRemoved.length > 0;
  });

  return { dryRun: false, deleted, plan };
}
