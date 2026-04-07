import { type User, type InsertUser, type Draft, type InsertDraft, users, contentDrafts, granthaBackups, type GranthaBackup, type GranthaBackupMeta, granthaLocks, type GranthaLock } from "@shared/schema";
import { db } from "./db";
import { eq, and, desc } from "drizzle-orm";

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
}

export const storage = new DatabaseStorage();
