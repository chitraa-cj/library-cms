import {
  type User,
  type InsertUser,
  type Draft,
  type InsertDraft,
  users,
  contentDrafts,
  granthaBackups,
  type GranthaBackup,
  type GranthaBackupMeta,
  granthaLocks,
  type GranthaLock,
  publishJobs,
  type PublishJobRecord,
  idempotencyKeys,
  type IdempotencyKeyRecord,
  publishJobTasks,
  type PublishJobTaskRecord,
  publishManthraResolutions,
  cmsPortalVocabulary,
  type PortalVocabularyCustom,
  type PortalVocabularyKey,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, sql, inArray, gte, lte, lt } from "drizzle-orm";
import { discardDraftWithDependencies, getDraftDiscardPlan, type DraftDiscardPlan, type DraftDiscardResult } from "./draft-discard";

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
  getDraftsSlim(userId: string, contentType?: string): Promise<Draft[]>;
  getStructureConfigForStrapiDoc(strapiDocumentId: string, userId: string): Promise<unknown | null>;
  getDraft(id: number, userId: string): Promise<Draft | undefined>;
  getDraftByStrapiDocId(strapiDocumentId: string): Promise<Draft | undefined>;
  createDraft(draft: InsertDraft): Promise<Draft>;
  updateDraft(id: number, userId: string, data: Partial<InsertDraft>): Promise<Draft | undefined>;
  updateDraftIfVersion(id: number, userId: string, expectedUpdatedAt: Date, data: Partial<InsertDraft>): Promise<Draft | undefined>;
  deleteDraft(id: number, userId: string): Promise<boolean>;
  deleteDraftById(id: number): Promise<boolean>;
  getDraftDiscardPlan(draftId: number, userId?: string): Promise<DraftDiscardPlan>;
  discardDraftWithDependencies(draftId: number, opts?: { userId?: string; dryRun?: boolean }): Promise<DraftDiscardResult>;
  purgeExpiredIdempotencyKeys(): Promise<number>;
  markDraftPublished(id: number, userId: string, strapiDocumentId?: string): Promise<Draft | undefined>;
  createBackup(label: string, data: any, granthaCount: number, sectionCount: number, manthraCount: number, summary?: any): Promise<GranthaBackup>;
  listBackups(): Promise<GranthaBackupMeta[]>;
  getBackup(id: number): Promise<GranthaBackup | null>;
  getBackupSummaryRow(id: number): Promise<{ id: number; label: string; createdAt: Date; granthaCount: number; sectionCount: number; manthraCount: number; summary: any } | null>;
  setBackupSummary(id: number, summary: any): Promise<void>;
  getGranthaLocks(): Promise<GranthaLock[]>;
  getGranthaLock(granthaDocId: string): Promise<GranthaLock | null>;
  lockGrantha(granthaDocId: string, granthaName: string | undefined, userId: string, username: string, reason?: string): Promise<GranthaLock>;
  unlockGrantha(granthaDocId: string): Promise<boolean>;
  createPublishJob(job: Omit<PublishJobRecord, "createdAt" | "updatedAt">): Promise<PublishJobRecord>;
  getPublishJob(id: string): Promise<PublishJobRecord | null>;
  getRunningPublishJobForDraft(draftId: number): Promise<PublishJobRecord | null>;
  getRunningPublishJobForGrantha(granthaDocId: string): Promise<PublishJobRecord | null>;
  updatePublishJob(id: string, patch: Partial<PublishJobRecord>): Promise<PublishJobRecord | null>;
  markStalePublishJobsAsRecoverable(olderThanMs: number): Promise<number>;
  // D5: per-job manthra resolution checkpoint
  recordManthraResolution(jobId: string, portalManthraId: string, strapiDocumentId: string): Promise<void>;
  recordManthraResolutionsBulk(jobId: string, entries: Array<{ portalManthraId: string; strapiDocumentId: string }>): Promise<void>;
  loadManthraResolutions(jobId: string): Promise<Map<string, string>>;
  deleteManthraResolutions(jobId: string): Promise<number>;
  upsertIdempotencyRecord(record: Omit<IdempotencyKeyRecord, "createdAt">): Promise<IdempotencyKeyRecord>;
  getIdempotencyRecord(key: string): Promise<IdempotencyKeyRecord | null>;
  deleteIdempotencyRecord(key: string): Promise<boolean>;
  enqueuePublishJobTask(task: Omit<PublishJobTaskRecord, "id" | "createdAt" | "updatedAt">): Promise<PublishJobTaskRecord>;
  listPublishJobTasks(jobId: string, statuses?: string[]): Promise<PublishJobTaskRecord[]>;
  claimNextPublishJobTask(jobId: string): Promise<PublishJobTaskRecord | null>;
  claimPublishJobTask(taskId: number): Promise<PublishJobTaskRecord | null>;
  updatePublishJobTask(taskId: number, patch: Partial<PublishJobTaskRecord>): Promise<PublishJobTaskRecord | null>;
  completePublishJobTask(taskId: number, result?: unknown): Promise<PublishJobTaskRecord | null>;
  failPublishJobTask(taskId: number, error: string): Promise<PublishJobTaskRecord | null>;
  getPortalVocabularyCustom(): Promise<PortalVocabularyCustom>;
  addPortalVocabularyEntry(key: PortalVocabularyKey, value: string, userId: string): Promise<PortalVocabularyCustom>;
  removePortalVocabularyEntry(key: PortalVocabularyKey, value: string, userId: string): Promise<PortalVocabularyCustom>;
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

  /**
   * Drafts for the list views, with grantha `data` blobs left behind in Postgres.
   *
   * A grantha draft is one JSON document holding the whole text, so the full list is enormous:
   * on prod one editor's 172 grantha drafts total ~198MB (165 published snapshots at 150MB plus a
   * 48MB Chandogya draft). Shipping that through `select *` cost 16-94s per request — and because
   * Node parses and re-serializes it on the single event loop, it stalled every *other* request
   * too, which is why "publish one mantra" felt like minutes. The publish write itself is ~1s.
   *
   * So grantha rows get only what the cards and the shadow/overlay logic actually read, computed
   * in Postgres so the blob never crosses the wire:
   *   • `status = 'draft'` rows (10 on prod) → card fields, `structureConfig`, `_hasLocalEdits`
   *   • published snapshot rows (187 on prod, 167MB) → no `data` at all; the list only ever uses
   *     their metadata (id / strapiDocumentId / status / createdBy / updatedAt)
   * Every other content type keeps its full `data` — those drafts are all together under 40KB, and
   * their pages read the blob straight off the list.
   * `_hasLocalEdits` mirrors the client's `overlayDraftHasLocalEdits` walk as a jsonb path test.
   * The CASE is what keeps this fast: its `else` branch never mentions `data`, so Postgres skips
   * detoasting the 167MB of published blobs entirely (252,284 buffers -> 17).
   *
   * Anything needing the real hierarchy fetches the single row it opens via `getDraft`.
   */
  async getDraftsSlim(userId: string, contentType?: string): Promise<Draft[]> {
    const verseEdited = (versePath: string) => {
      const jsonPath = `$.${versePath} ? (@._isNewLocal == true || @._shlokaEdited == true || @._bhashyamEdited == true)`;
      return sql`jsonb_path_exists(data, ${jsonPath}::jsonpath)`;
    };
    const typeFilter = contentType ? sql` and content_type = ${contentType}` : sql``;
    const result = await db.execute(sql`
      select id, content_type, title, strapi_document_id, status, created_by, created_at, updated_at,
        case
        when content_type <> 'granthas' then data
        when status = 'draft' then jsonb_build_object(
          'GranthaName', data->'GranthaName',
          'GranthaType', data->'GranthaType',
          'BhashyamName', data->'BhashyamName',
          'BhashyamAuthor', data->'BhashyamAuthor',
          'structureConfig', data->'structureConfig',
          '_slim', true,
          '_hasLocalEdits',
            coalesce(jsonb_array_length(data->'deletedStrapiSectionDocIds'), 0) > 0
            or coalesce(jsonb_array_length(data->'deletedStrapiManthraDocIds'), 0) > 0
            or coalesce(jsonb_array_length(data->'deletedStrapiTeekaDocIds'), 0) > 0
            or ${verseEdited("hierarchy[*].khandas[*].manthras[*]")}
            or ${verseEdited("hierarchy[*].khandas[*].padas[*].manthras[*]")}
        ) else jsonb_build_object('_slim', true) end as data
      from ${contentDrafts}
      where created_by = ${userId}${typeFilter}
      order by updated_at desc
    `);
    const rows = ((result as any)?.rows ?? []) as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id,
      contentType: r.content_type,
      strapiDocumentId: r.strapi_document_id,
      title: r.title,
      data: r.data,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })) as Draft[];
  }

  /**
   * Newest `structureConfig` saved for a Strapi grantha, from any of this user's drafts.
   * The slim list omits `data` for published snapshots, so the editor recovers the portal-only
   * structure (never stored in Strapi) through this one-grantha lookup instead.
   */
  async getStructureConfigForStrapiDoc(strapiDocumentId: string, userId: string): Promise<unknown | null> {
    const result = await db.execute(sql`
      select data->'structureConfig' as structure_config
      from ${contentDrafts}
      where content_type = 'granthas'
        and strapi_document_id = ${strapiDocumentId}
        and created_by = ${userId}
        and jsonb_exists(data, 'structureConfig')
      order by updated_at desc
      limit 1
    `);
    const rows = ((result as any)?.rows ?? []) as { structure_config?: unknown }[];
    return rows[0]?.structure_config ?? null;
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
    // Avoid exact `updated_at = $1` (JSON ISO vs driver/DB precision). Require `updated_at`
    // to lie within a narrow window around the client's token so concurrent stale saves
    // (seconds/minutes behind) still fail, while normal round-trips succeed.
    const tolMs = 750;
    const t = expectedUpdatedAt.getTime();
    if (Number.isNaN(t)) return undefined;
    const low = new Date(t - tolMs);
    const high = new Date(t + tolMs);
    const [updated] = await db
      .update(contentDrafts)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(contentDrafts.id, id),
          eq(contentDrafts.createdBy, userId),
          gte(contentDrafts.updatedAt, low),
          lte(contentDrafts.updatedAt, high)
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

  async getDraftDiscardPlan(draftId: number, userId?: string): Promise<DraftDiscardPlan> {
    return getDraftDiscardPlan(draftId, userId);
  }

  async discardDraftWithDependencies(
    draftId: number,
    opts?: { userId?: string; dryRun?: boolean },
  ): Promise<DraftDiscardResult> {
    return discardDraftWithDependencies({ draftId, ...opts });
  }

  async purgeExpiredIdempotencyKeys(): Promise<number> {
    const removed = await db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, new Date()))
      .returning({ key: idempotencyKeys.key });
    if (removed.length > 0) {
      console.log(`[idempotency.ttl] purged ${removed.length} expired key(s)`);
    }
    return removed.length;
  }

  async deleteDraft(id: number, userId: string): Promise<boolean> {
    const { deleted } = await discardDraftWithDependencies({ draftId: id, userId });
    return deleted;
  }

  async deleteDraftById(id: number): Promise<boolean> {
    const { deleted } = await discardDraftWithDependencies({ draftId: id });
    return deleted;
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

  async createBackup(label: string, data: any, granthaCount: number, sectionCount: number, manthraCount: number, summary?: any): Promise<GranthaBackup> {
    const [backup] = await db
      .insert(granthaBackups)
      .values({ label, data, granthaCount, sectionCount, manthraCount, summary })
      .returning();
    return backup;
  }

  async getBackupSummaryRow(id: number) {
    const [row] = await db
      .select({
        id: granthaBackups.id,
        label: granthaBackups.label,
        createdAt: granthaBackups.createdAt,
        granthaCount: granthaBackups.granthaCount,
        sectionCount: granthaBackups.sectionCount,
        manthraCount: granthaBackups.manthraCount,
        summary: granthaBackups.summary,
      })
      .from(granthaBackups)
      .where(eq(granthaBackups.id, id));
    return row ?? null;
  }

  async setBackupSummary(id: number, summary: any): Promise<void> {
    await db.update(granthaBackups).set({ summary }).where(eq(granthaBackups.id, id));
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

  async getRunningPublishJobForGrantha(granthaDocId: string): Promise<PublishJobRecord | null> {
    // Cross-process / cross-restart guard: even after this process loses its in-memory
    // map, another draft pointing at the same Strapi grantha can find the in-flight job
    // here. Filters on the indexed (grantha_doc_id, status) pair.
    const [job] = await db
      .select()
      .from(publishJobs)
      .where(and(eq(publishJobs.granthaDocId, granthaDocId), eq(publishJobs.status, "running")))
      .orderBy(desc(publishJobs.updatedAt));
    return job ?? null;
  }

  async recordManthraResolution(
    jobId: string,
    portalManthraId: string,
    strapiDocumentId: string,
  ): Promise<void> {
    await db
      .insert(publishManthraResolutions)
      .values({ jobId, portalManthraId, strapiDocumentId })
      .onConflictDoUpdate({
        target: [publishManthraResolutions.jobId, publishManthraResolutions.portalManthraId],
        set: { strapiDocumentId },
      });
  }

  async recordManthraResolutionsBulk(
    jobId: string,
    entries: Array<{ portalManthraId: string; strapiDocumentId: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    // Chunk to keep INSERT under typical statement-size limits (~1000 rows is comfy).
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK).map((e) => ({
        jobId,
        portalManthraId: e.portalManthraId,
        strapiDocumentId: e.strapiDocumentId,
      }));
      await db
        .insert(publishManthraResolutions)
        .values(slice)
        .onConflictDoUpdate({
          target: [publishManthraResolutions.jobId, publishManthraResolutions.portalManthraId],
          set: { strapiDocumentId: sql`EXCLUDED.strapi_document_id` },
        });
    }
  }

  async loadManthraResolutions(jobId: string): Promise<Map<string, string>> {
    const rows = await db
      .select({
        portalManthraId: publishManthraResolutions.portalManthraId,
        strapiDocumentId: publishManthraResolutions.strapiDocumentId,
      })
      .from(publishManthraResolutions)
      .where(eq(publishManthraResolutions.jobId, jobId));
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.portalManthraId, r.strapiDocumentId);
    return map;
  }

  async deleteManthraResolutions(jobId: string): Promise<number> {
    const removed = await db
      .delete(publishManthraResolutions)
      .where(eq(publishManthraResolutions.jobId, jobId))
      .returning({ portalManthraId: publishManthraResolutions.portalManthraId });
    return removed.length;
  }

  async markStalePublishJobsAsRecoverable(olderThanMs: number): Promise<number> {
    // Called on server startup. In-memory worker state is lost across restarts; any
    // publish_jobs row still marked "running" with no recent heartbeat is orphaned and
    // will never complete. Mark them failed_recoverable so the client can re-trigger.
    const cutoff = new Date(Date.now() - olderThanMs);
    const updated = await db
      .update(publishJobs)
      .set({
        status: "failed_recoverable",
        error: "Server restarted while publish was in progress",
        updatedAt: new Date(),
      })
      .where(and(eq(publishJobs.status, "running"), lt(publishJobs.updatedAt, cutoff)))
      .returning();
    return updated.length;
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

  async deleteIdempotencyRecord(key: string): Promise<boolean> {
    const removed = await db
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .returning({ key: idempotencyKeys.key });
    return removed.length > 0;
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

  private async ensurePortalVocabularyRow(): Promise<PortalVocabularyCustom> {
    const [row] = await db.select().from(cmsPortalVocabulary).where(eq(cmsPortalVocabulary.id, 1));
    if (row) return (row.custom as PortalVocabularyCustom) ?? {};
    const [created] = await db
      .insert(cmsPortalVocabulary)
      .values({ id: 1, custom: {} })
      .onConflictDoNothing()
      .returning();
    if (created) return (created.custom as PortalVocabularyCustom) ?? {};
    const [again] = await db.select().from(cmsPortalVocabulary).where(eq(cmsPortalVocabulary.id, 1));
    return (again?.custom as PortalVocabularyCustom) ?? {};
  }

  async getPortalVocabularyCustom(): Promise<PortalVocabularyCustom> {
    return this.ensurePortalVocabularyRow();
  }

  /**
   * Atomically read-modify-write the single shared vocabulary row (`id:1`).
   * All portal lists live in one JSONB blob, so two admins adding names at the
   * same time — even to different lists — would clobber each other under a plain
   * read-then-write. We serialize writers with `SELECT … FOR UPDATE` inside a
   * transaction so every concurrent add/remove is applied on top of the latest
   * committed state instead of a stale snapshot.
   */
  private async mutatePortalVocabulary(
    userId: string,
    mutate: (current: PortalVocabularyCustom) => PortalVocabularyCustom,
  ): Promise<PortalVocabularyCustom> {
    return db.transaction(async (tx) => {
      await tx
        .insert(cmsPortalVocabulary)
        .values({ id: 1, custom: {} })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(cmsPortalVocabulary)
        .where(eq(cmsPortalVocabulary.id, 1))
        .for("update");
      const current = (row?.custom as PortalVocabularyCustom) ?? {};
      const custom = mutate(current);
      await tx
        .update(cmsPortalVocabulary)
        .set({ custom, updatedBy: userId, updatedAt: new Date() })
        .where(eq(cmsPortalVocabulary.id, 1));
      return custom;
    });
  }

  async addPortalVocabularyEntry(
    key: PortalVocabularyKey,
    value: string,
    userId: string,
  ): Promise<PortalVocabularyCustom> {
    return this.mutatePortalVocabulary(userId, (current) => {
      const list = [...(current[key] ?? [])];
      const exists = list.some((v) => v.toLowerCase() === value.toLowerCase());
      if (!exists) list.push(value);
      return { ...current, [key]: list };
    });
  }

  async removePortalVocabularyEntry(
    key: PortalVocabularyKey,
    value: string,
    userId: string,
  ): Promise<PortalVocabularyCustom> {
    return this.mutatePortalVocabulary(userId, (current) => {
      const list = (current[key] ?? []).filter((v) => v.toLowerCase() !== value.toLowerCase());
      return { ...current, [key]: list };
    });
  }
}

export const storage = new DatabaseStorage();
