/**
 * Load `.env` from the repository root (parent of `server/`), regardless of `process.cwd()`.
 * This avoids "DATABASE_URL must be set" when the IDE or a script starts the process from another directory.
 */
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, "..");
config({ path: path.join(rootDir, ".env") });
