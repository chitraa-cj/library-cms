import { type User, type InsertUser, type Draft, type InsertDraft, users, contentDrafts } from "@shared/schema";
import { db } from "./db";
import { eq, and, desc } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getDrafts(userId: string): Promise<Draft[]>;
  getDraftsByType(contentType: string, userId: string): Promise<Draft[]>;
  getDraft(id: number, userId: string): Promise<Draft | undefined>;
  createDraft(draft: InsertDraft): Promise<Draft>;
  updateDraft(id: number, userId: string, data: Partial<InsertDraft>): Promise<Draft | undefined>;
  deleteDraft(id: number, userId: string): Promise<boolean>;
  markDraftPublished(id: number, userId: string, strapiDocumentId?: string): Promise<Draft | undefined>;
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

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
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

  async deleteDraft(id: number, userId: string): Promise<boolean> {
    const result = await db.delete(contentDrafts)
      .where(and(eq(contentDrafts.id, id), eq(contentDrafts.createdBy, userId)))
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
}

export const storage = new DatabaseStorage();
