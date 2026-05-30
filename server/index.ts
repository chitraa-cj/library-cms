import "./env";

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { registerApiCacheMiddleware } from "./http-cache";
import { serveStatic } from "./static";
import { createServer } from "http";
import { db } from "./db";
import { publishJobs, publishJobTasks, users } from "@shared/schema";
import { storage } from "./storage";
import { eq, sql } from "drizzle-orm";

const app = express();
app.set("trust proxy", 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "50mb" }));

registerApiCacheMiddleware(app);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse !== undefined) {
        // Avoid logging multi‑MB bodies or leaking full draft payloads to stdout (accountability + I/O).
        const snippet = JSON.stringify(capturedJsonResponse);
        const max = 1200;
        logLine +=
          snippet.length > max
            ? ` :: ${snippet.slice(0, max)}…[truncated:${snippet.length - max}]`
            : ` :: ${snippet}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Ensure at least one admin exists; if none, promote designated admin usernames
  const ADMIN_USERNAMES = ["admin", "chitra.jain"];
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, "admin"));
    if (count === 0) {
      for (const username of ADMIN_USERNAMES) {
        await db.update(users).set({ role: "admin" }).where(eq(users.username, username));
      }
      console.log("[startup] No admins found — promoted designated users to admin:", ADMIN_USERNAMES.join(", "));
    }
  } catch (e) {
    console.error("[startup] Admin seed error:", e);
  }

  // Reconcile orphaned publish jobs from previous crashes/restarts.
  try {
    await db
      .update(publishJobs)
      .set({
        status: "failed_recoverable",
        error: "Server restarted during publish; safe to retry.",
        updatedAt: new Date(),
      })
      .where(eq(publishJobs.status, "running"));
    await db
      .update(publishJobTasks)
      .set({
        status: "queued",
        error: "Requeued after server restart.",
        updatedAt: new Date(),
      })
      .where(eq(publishJobTasks.status, "running"));
  } catch (e) {
    console.error("[startup] Publish job reconcile error:", e);
  }

  // Physical TTL for idempotency replay rows (logical expiry ignored them until now).
  try {
    const purged = await storage.purgeExpiredIdempotencyKeys();
    if (purged > 0) console.log(`[startup] Purged ${purged} expired idempotency key(s)`);
  } catch (e) {
    console.error("[startup] Idempotency TTL purge error:", e);
  }
  const idempotencyTtlMs = 60 * 60 * 1000;
  setInterval(() => {
    void storage.purgeExpiredIdempotencyKeys().catch((e) => {
      console.error("[idempotency.ttl] periodic purge error:", e);
    });
  }, idempotencyTtlMs).unref?.();

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[express] Port ${port} is already in use. Stop the other dev server (e.g. find the process: lsof -i :${port}) or set PORT in .env to a free port.`,
      );
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
