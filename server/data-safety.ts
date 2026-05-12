import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { gunzipSync } from "node:zlib";

type SnapshotPayload = {
  event: string;
  draftId?: number | null;
  userId?: string | null;
  title?: string | null;
  status?: string | null;
  strapiDocumentId?: string | null;
  data?: unknown;
  metadata?: Record<string, unknown>;
};

const SNAPSHOT_ROOT = join(process.cwd(), "logs", "draft-snapshots");

function safeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function writeDraftSnapshot(payload: SnapshotPayload): Promise<void> {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const time = now.toISOString().replace(/[:.]/g, "-");
    const dir = join(SNAPSHOT_ROOT, day);
    await mkdir(dir, { recursive: true });

    const draftPart = payload.draftId != null ? `draft-${payload.draftId}` : "draft-unknown";
    const userPart = payload.userId ? `user-${safeFilePart(payload.userId)}` : "user-anon";
    const eventPart = safeFilePart(payload.event || "event");
    const fileName = `${time}__${eventPart}__${draftPart}__${userPart}.json.gz`;
    const fullPath = join(dir, fileName);

    const record = {
      ts: now.toISOString(),
      ...payload,
    };
    const raw = Buffer.from(JSON.stringify(record), "utf8");
    const gz = gzipSync(raw, { level: 6 });
    await writeFile(fullPath, gz);
  } catch (err) {
    console.error("[data-safety] snapshot write failed:", err);
  }
}

export async function readLatestDraftSnapshot(draftId: number, userId?: string | null): Promise<any | null> {
  try {
    const dayDirs = await readdir(SNAPSHOT_ROOT, { withFileTypes: true });
    const sortedDays = dayDirs
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();

    const draftNeedle = `draft-${draftId}`;
    const userNeedle = userId ? `user-${safeFilePart(userId)}` : null;

    for (const day of sortedDays) {
      const dir = join(SNAPSHOT_ROOT, day);
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".json.gz") && f.includes(draftNeedle))
        .sort()
        .reverse();
      for (const file of files) {
        if (userNeedle && !file.includes(userNeedle)) continue;
        const raw = await readFile(join(dir, file));
        const json = JSON.parse(gunzipSync(raw).toString("utf8"));
        return json;
      }
    }
    return null;
  } catch {
    return null;
  }
}
