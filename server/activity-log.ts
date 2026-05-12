import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "activity.log");

const REDACT_KEYS = new Set([
  "password",
  "token",
  "authorization",
  "cookie",
  "session",
  "secret",
  "apiKey",
  "api_key",
]);

function truncateString(input: string, max = 800): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…[truncated:${input.length - max}]`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return "[max-depth]";
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

async function appendActivityLog(entry: Record<string, unknown>) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error("[activity-log] failed to write log:", err);
  }
}

export function activityLogger(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api")) return next();

  const startedAt = Date.now();
  const requestId = randomUUID();
  const method = req.method;
  const path = req.originalUrl || req.url;
  const query = sanitize(req.query);
  const body = method === "GET" || method === "HEAD" ? undefined : sanitize(req.body);

  res.on("finish", () => {
    const user = (req as any).user;
    void appendActivityLog({
      ts: new Date().toISOString(),
      requestId,
      method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip,
      userAgent: truncateString(req.get("user-agent") || "", 240),
      user: user
        ? {
            id: user.id,
            username: user.username,
            role: user.role,
          }
        : null,
      query,
      body,
    });
  });

  next();
}

export function getActivityLogPath() {
  return LOG_FILE;
}
