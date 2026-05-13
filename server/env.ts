/**
 * Load `.env` from the project root (where you run `npm run dev` — normally the repo root).
 */
import { config } from "dotenv";
import path from "node:path";

const rootDir = process.cwd();
config({ path: path.join(rootDir, ".env") });
