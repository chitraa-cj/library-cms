import { type User, type InsertUser, type Draft, type InsertDraft, users, contentDrafts, granthaBackups, type GranthaBackup, type GranthaBackupMeta, granthaLocks, type GranthaLock, publishJobs, type PublishJobRecord, idempotencyKeys, type IdempotencyKeyRecord, publishJobTasks, type PublishJobTaskRecord } from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  createUser(user: InsertUser & { role?: string }): Promise<User>;
  deleteUser(id: string): Promise<boolean>;
  updateUserRole(id: string, role: string): Promise<User | undefined>;
  updateUserPassword(id: string, hashedPassword: string): Promise<User | undefined>;
  getDrafts(userId: string): Promise<Draft[]>;
  getDraftsByType(contentType: string, userId: string): Promise<Draft[]>;
  getDraft(id: number, userId: string): Promise<Draft | undefined>;
  getDraftByStrapiDocId(strapiDocumentId: string): Promise<Draft | undefined>;
  createDraft(draft: InsertDraft): Promise<Draft>;
  updateDraft(id: number, userId: string, data: Partial<InsertDraft>): Promise<Draft | undefined>;
  updateDraftIfVersion(id: number, userId: string, expectedUpdatedAt: Date, data: Partial<InsertDraft>): Promise<Draft | undefined>;
  deleteDraft(id: number, userId: string): Promise<boolean>;
  deleteDraftById(id: number): Promise<boolean>;
  markDraftPublished(id: number, userId: string, strapiDocumentId?: string): Promise<Draft | undefined>;
  createBackup(label: string, data: any, granthaCount: number, sectionCount: number, manthraCount: number): Promise<GranthaBackup>;
  listBackups(): Promise<GranthaBackupMeta[]>;
  getBackup(id: number): Promise<GranthaBackup | null>;
  getGranthaLocks(): Promise<GranthaLock[]>;
  getGranthaLock(granthaDocId: string): Promise<GranthaLock | null>;
  lockGrantha(granthaDocId: string, granthaName: string | undefined, userId: string, username: string, reason?: string): Promise<GranthaLock>;
  unlockGrantha(granthaDocId: string): Promise<boolean>;
  createPublishJob(job: Omit<PublishJobRecord, "createdAt" | "updatedAt">): Promise<PublishJobRecord>;
  getPublishJob(id: string): Promise<PublishJobRecord | null>;
  getRunningPublishJobForDraft(draftId: number): Promise<PublishJobRecord | null>;
  updatePublishJob(id: string, patch: Partial<PublishJobRecord>): Promise<PublishJobRecord | null>;
  upsertIdempotencyRecord(record: Omit<IdempotencyKeyRecord, "createdAt">): Promise<IdempotencyKeyRecord>;
  getIdempotencyRecord(key: string): Promise<IdempotencyKeyRecord | null>;
  enqueuePublishJobTask(task: Omit<PublishJobTaskRecord, "id" | "createdAt" | "updatedAt">): Promise<PublishJobTaskRecord>;
  listPublishJobTasks(jobId: string, statuses?: string[]): Promise<PublishJobTaskRecord[]>;
  claimNextPublishJobTask(jobId: string): Promise<PublishJobTaskRecord | null>;
  claimPublishJobTask(taskId: number): Promise<PublishJobTaskRecord | null>;
  updatePublishJobTask(taskId: number, patch: Partial<PublishJobTaskRecord>): Promise<PublishJobTaskRecord | null>;
  completePublishJobTask(taskId: number, result?: unknown): Promise<PublishJobTaskRecord | null>;
  failPublishJobTask(taskId: number, error: string): Promise<PublishJobTaskRecord | null>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return user;
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(users.createdAt);
  }

  async createUser(insertUser: InsertUser & { role?: string }): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }

  async updateUserRole(id: string, role: string): Promise<User | undefined> {
    const [updated] = await db.update(users).set({ role }).where(eq(users.id, id)).returning();
    return updated;
  }

  async updateUserPassword(id: string, hashedPassword: string): Promise<User | undefined> {
    const [updated] = await db.update(users).set({ password: hashedPassword }).where(eq(users.id, id)).returning();
    return updated;
  }

  async getDrafts(userId: string): Promise<Draft[]> {
    return db.select().from(contentDrafts)
      .where(eq(contentDrafts.createdBy, userId))
      .orderBy(desc(contentDrafts.updatedAt));
  }

  async getDraftsByType(contentType: string, userId: string): Promise<Draft[]> {
    return db
      .select()
      .from(contentDrafts)
      .where(and(eq(contentDrafts.contentType, contentType), eq(contentDrafts.createdBy, userId)))
      .orderBy(desc(contentDrafts.updatedAt));
  }

  async getDraft(id: number, userId: string): Promise<Draft | undefined> {
    const [draft] = await db.select().from(contentDrafts)
      .where(and(eq(contentDrafts.id, id), eq(contentDrafts.createdBy, userId)));
    return draft;
  }

  async createDraft(draft: InsertDraft): Promise<Draft> {
    const [created] = await db.insert(contentDrafts).values(draft).returning();
    return created;
  }

  async updateDraft(id: number, userId: string, data: Partial<InsertDraft>): Promise<Draft | undefined> {
    const [updated] = await db
      .update(contentDrafts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(contentDrafts.id, id), eq(contentDrafts.createdBy, userId)))
      .returning();
    return updated;
  }

  async updateDraftIfVersion(id: number, userId: string, expectedUpdatedAt: Date, data: Partial<InsertDraft>): Promise<Draft | undefined> {
    const [updated] = await db
      .update(contentDrafts)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(contentDrafts.id, id),
          eq(contentDrafts.createdBy, userId),
          sql`${contentDrafts.updatedAt} = ${expectedUpdatedAt}`
        )
      )
      .returning();
    return updated;
  }

  async getDraftByStrapiDocId(strapiDocumentId: string): Promise<Draft | undefined> {
    const [draft] = await db.select().from(contentDrafts)
      .where(eq(contentDrafts.strapiDocumentId, strapiDocumentId));
    return draft;
  }

  async deleteDraft(id: number, userId: string): Promise<boolean> {
    const result = await db.delete(contentDrafts)
      .where(and(eq(contentDrafts.id, id), eq(contentDrafts.createdBy, userId)))
      .returning();
    return result.length > 0;
  }

  async deleteDraftById(id: number): Promise<boolean> {
    const result = await db.delete(contentDrafts)
      .where(eq(contentDrafts.id, id))
      .returning();
    return result.length > 0;
  }

  async markDraftPublished(id: number, userId: string, strapiDocumentId?: string): Promise<Draft | undefined> {
    const [updated] = await db
      .update(contentDrafts)
      .set({
        status: "published",
        strapiDocumentId: strapiDocumentId || undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(contentDrafts.id, id), eq(contentDrafts.createdBy, userId)))
      .returning();
    return updated;
  }

  async createBackup(label: string, data: any, granthaCount: number, sectionCount: number, manthraCount: number): Promise<GranthaBackup> {
    const [backup] = await db
      .insert(granthaBackups)
      .values({ label, data, granthaCount, sectionCount, manthraCount })
      .returning();
    return backup;
  }

  async listBackups(): Promise<GranthaBackupMeta[]> {
    const rows = await db
      .select({
        id: granthaBackups.id,
        label: granthaBackups.label,
        createdAt: granthaBackups.createdAt,
        granthaCount: granthaBackups.granthaCount,
        sectionCount: granthaBackups.sectionCount,
        manthraCount: granthaBackups.manthraCount,
      })
      .from(granthaBackups)
      .orderBy(desc(granthaBackups.createdAt));
    return rows;
  }

  async getBackup(id: number): Promise<GranthaBackup | null> {
    const [backup] = await db.select().from(granthaBackups).where(eq(granthaBackups.id, id));
    return backup ?? null;
  }

  async getGranthaLocks(): Promise<GranthaLock[]> {
    return db.select().from(granthaLocks).orderBy(desc(granthaLocks.lockedAt));
  }

  async getGranthaLock(granthaDocId: string): Promise<GranthaLock | null> {
    const [lock] = await db.select().from(granthaLocks).where(eq(granthaLocks.granthaDocId, granthaDocId));
    return lock ?? null;
  }

  async lockGrantha(granthaDocId: string, granthaName: string | undefined, userId: string, username: string, reason?: string): Promise<GranthaLock> {
    const [lock] = await db
      .insert(granthaLocks)
      .values({ granthaDocId, granthaName, lockedByUserId: userId, lockedByUsername: username, reason })
      .onConflictDoUpdate({
        target: granthaLocks.granthaDocId,
        set: { granthaName, lockedByUserId: userId, lockedByUsername: username, reason, lockedAt: new Date() },
      })
      .returning();
    return lock;
  }

  async unlockGrantha(granthaDocId: string): Promise<boolean> {
    const result = await db.delete(granthaLocks).where(eq(granthaLocks.granthaDocId, granthaDocId)).returning();
    return result.length > 0;
  }

  async createPublishJob(job: Omit<PublishJobRecord, "createdAt" | "updatedAt">): Promise<PublishJobRecord> {
    const [created] = await db.insert(publishJobs).values(job).returning();
    return created;
  }

  async getPublishJob(id: string): Promise<PublishJobRecord | null> {
    const [job] = await db.select().from(publishJobs).where(eq(publishJobs.id, id));
    return job ?? null;
  }

  async getRunningPublishJobForDraft(draftId: number): Promise<PublishJobRecord | null> {
    const [job] = await db
      .select()
      .from(publishJobs)
      .where(and(eq(publishJobs.draftId, draftId), eq(publishJobs.status, "running")))
      .orderBy(desc(publishJobs.updatedAt));
    return job ?? null;
  }

  async updatePublishJob(id: string, patch: Partial<PublishJobRecord>): Promise<PublishJobRecord | null> {
    const [updated] = await db
      .update(publishJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(publishJobs.id, id))
      .returning();
    return updated ?? null;
  }

  async upsertIdempotencyRecord(record: Omit<IdempotencyKeyRecord, "createdAt">): Promise<IdempotencyKeyRecord> {
    const [saved] = await db
      .insert(idempotencyKeys)
      .values(record)
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: {
          route: record.route,
          requestHash: record.requestHash,
          responseStatus: record.responseStatus,
          responseBody: record.responseBody,
          userId: record.userId,
          draftId: record.draftId,
          expiresAt: record.expiresAt,
        },
      })
      .returning();
    return saved;
  }

  async getIdempotencyRecord(key: string): Promise<IdempotencyKeyRecord | null> {
    const [record] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (!record) return null;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;
    return record;
  }

  async enqueuePublishJobTask(task: Omit<PublishJobTaskRecord, "id" | "createdAt" | "updatedAt">): Promise<PublishJobTaskRecord> {
    const [created] = await db.insert(publishJobTasks).values(task as any).returning();
    return created;
  }

  async listPublishJobTasks(jobId: string, statuses?: string[]): Promise<PublishJobTaskRecord[]> {
    const base = db.select().from(publishJobTasks).where(eq(publishJobTasks.jobId, jobId)).orderBy(publishJobTasks.id);
    if (!statuses || statuses.length === 0) return base;
    return db
      .select()
      .from(publishJobTasks)
      .where(and(eq(publishJobTasks.jobId, jobId), inArray(publishJobTasks.status, statuses as any)))
      .orderBy(publishJobTasks.id);
  }

  async claimPublishJobTask(taskId: number): Promise<PublishJobTaskRecord | null> {
    const [claimed] = await db
      .update(publishJobTasks)
      .set({
        status: "running",
        attemptCount: sql`${publishJobTasks.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(publishJobTasks.id, taskId), eq(publishJobTasks.status, "queued")))
      .returning();
    return claimed ?? null;
  }

  async claimNextPublishJobTask(jobId: string): Promise<PublishJobTaskRecord | null> {
    const result = await db.execute(sql`
      with next_task as (
        select id
        from ${publishJobTasks}
        where job_id = ${jobId}
          and status = 'queued'
        order by id
        limit 1
        for update skip locked
      )
      update ${publishJobTasks} t
      set status = 'running',
          attempt_count = t.attempt_count + 1,
          updated_at = now()
      from next_task
      where t.id = next_task.id
      returning t.*;
    `);
    const rows = (result as any)?.rows as PublishJobTaskRecord[] | undefined;
    return rows?.[0] ?? null;
  }

  async updatePublishJobTask(taskId: number, patch: Partial<PublishJobTaskRecord>): Promise<PublishJobTaskRecord | null> {
    const [updated] = await db
      .update(publishJobTasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(publishJobTasks.id, taskId))
      .returning();
    return updated ?? null;
  }

  async completePublishJobTask(taskId: number, result?: unknown): Promise<PublishJobTaskRecord | null> {
    const [done] = await db
      .update(publishJobTasks)
      .set({ status: "done", result: (result ?? null) as any, error: null, updatedAt: new Date() })
      .where(eq(publishJobTasks.id, taskId))
      .returning();
    return done ?? null;
  }

  async failPublishJobTask(taskId: number, error: string): Promise<PublishJobTaskRecord | null> {
    const [failed] = await db
      .update(publishJobTasks)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(eq(publishJobTasks.id, taskId))
      .returning();
    return failed ?? null;
  }
}

export const storage = new DatabaseStorage();
