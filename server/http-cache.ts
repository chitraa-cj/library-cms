import type { Express, Request, Response, NextFunction } from "express";

/** Prevent browsers and proxies from caching authenticated CMS API responses. */
export function applyApiNoCacheHeaders(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
}

/** SPA shell must never be cached long-term (stale JS bundles hide new features). */
export function applySpaShellNoCache(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
}

export function registerApiCacheMiddleware(app: Express): void {
  app.use(applyApiNoCacheHeaders);
}
