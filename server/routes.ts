import type { Express } from "express";
import { type Server } from "http";
import { setupAuth } from "./auth";
import { createStrapiRouter } from "./strapi";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);

  const strapiRouter = createStrapiRouter();
  app.use("/api/strapi", strapiRouter);

  return httpServer;
}
