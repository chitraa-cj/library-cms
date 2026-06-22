/**
 * Durable, versioned grantha draft backups on AWS S3.
 *
 * Mirrors the local-disk snapshot in `data-safety.ts` but targets S3 so a backup survives
 * the server's disk being wiped, and exposes list/get/delete so the editor can browse and
 * restore point-in-time versions. Every Save writes a NEW object (full history per draft);
 * objects are kept until explicitly deleted.
 *
 * Disabled (every call is a no-op / empty) unless `S3_BACKUP_BUCKET` is set, so local dev
 * without AWS credentials keeps working and Save never fails because of a backup error.
 */
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const KEY_ROOT = "grantha-backups";

export type GranthaBackupPayload = {
  draftId: number;
  userId?: string | null;
  title?: string | null;
  status?: string | null;
  strapiDocumentId?: string | null;
  data: unknown;
};

export type GranthaBackupListEntry = {
  key: string;
  ts: string;
  size: number;
};

let cachedClient: S3Client | null = null;

export function isS3BackupEnabled(): boolean {
  return !!process.env.S3_BACKUP_BUCKET;
}

function bucket(): string {
  const b = process.env.S3_BACKUP_BUCKET;
  if (!b) throw new Error("S3_BACKUP_BUCKET is not set");
  return b;
}

function client(): S3Client {
  if (!cachedClient) {
    // Region from AWS_REGION; credentials resolved by the SDK's default provider chain
    // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars, shared config, IAM role, …).
    cachedClient = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return cachedClient;
}

function draftPrefix(draftId: number): string {
  return `${KEY_ROOT}/draft-${draftId}/`;
}

/** Guard: a client-supplied key must belong to this draft (blocks traversal / cross-draft reads). */
export function assertKeyForDraft(draftId: number, key: string): void {
  if (typeof key !== "string" || !key.startsWith(draftPrefix(draftId)) || key.includes("..")) {
    throw new Error("Backup key does not belong to this draft");
  }
}

/** S3 object metadata must be ASCII; strip anything else and bound the length. */
function safeMeta(input: string | null | undefined): string {
  return (input ?? "").replace(/[^\x20-\x7E]/g, "_").slice(0, 256);
}

/**
 * Write a new versioned backup. Best-effort: returns null on any failure (the caller treats
 * the backup as advisory and never fails the Save because of it).
 */
export async function putGranthaBackup(
  payload: GranthaBackupPayload,
): Promise<{ key: string; size: number; ts: string } | null> {
  if (!isS3BackupEnabled()) return null;
  try {
    const ts = new Date().toISOString();
    const tsSafe = ts.replace(/[:.]/g, "-");
    const key = `${draftPrefix(payload.draftId)}${tsSafe}.json.gz`;

    const record = { ts, ...payload };
    const gz = await gzipAsync(Buffer.from(JSON.stringify(record), "utf8"), { level: 6 });

    await client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: gz,
        ContentType: "application/gzip",
        Metadata: {
          ts,
          draftid: String(payload.draftId),
          userid: safeMeta(payload.userId),
          title: safeMeta(payload.title),
          status: safeMeta(payload.status),
        },
      }),
    );
    return { key, size: gz.byteLength, ts };
  } catch (err) {
    console.error("[s3-backup] put failed:", err);
    return null;
  }
}

/** List a draft's backups, newest first. Returns [] when disabled or on error. */
export async function listGranthaBackups(draftId: number): Promise<GranthaBackupListEntry[]> {
  if (!isS3BackupEnabled()) return [];
  try {
    const entries: GranthaBackupListEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await client().send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          Prefix: draftPrefix(draftId),
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        entries.push({
          key: obj.Key,
          ts: tsFromKey(obj.Key) ?? obj.LastModified?.toISOString() ?? "",
          size: obj.Size ?? 0,
        });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return entries;
  } catch (err) {
    console.error("[s3-backup] list failed:", err);
    return [];
  }
}

/** Recover the ISO timestamp encoded in the object key (`…/2026-06-17T12-00-00-000Z.json.gz`). */
function tsFromKey(key: string): string | null {
  const base = key.split("/").pop() ?? "";
  const m = base.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json\.gz$/);
  if (!m) return null;
  // Reverse the `:`/`.` → `-` substitution done at write time.
  return m[1].replace(/-(\d{2})-(\d{2})-(\d{3}Z)$/, ":$1:$2.$3");
}

/** Fetch and decompress a single backup's stored record. */
export async function getGranthaBackup(key: string): Promise<any> {
  if (!isS3BackupEnabled()) throw new Error("S3 backups are not enabled");
  const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error("Empty backup body");
  const bytes = Buffer.from(await body.transformToByteArray());
  const raw = await gunzipAsync(bytes);
  return JSON.parse(raw.toString("utf8"));
}

/** Delete a single backup version. */
export async function deleteGranthaBackup(key: string): Promise<void> {
  if (!isS3BackupEnabled()) throw new Error("S3 backups are not enabled");
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
