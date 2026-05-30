import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { applySpaShellNoCache } from "./http-cache";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(
    express.static(distPath, {
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === "index.html" || base === ".build-id") {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", applySpaShellNoCache, (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
