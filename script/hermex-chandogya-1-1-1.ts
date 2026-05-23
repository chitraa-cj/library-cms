/**
 * @deprecated Use: npm run hermex:grantha -- "Chandogya Upanishad" --mantra "1.1.1"
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extra = process.argv.slice(2).filter((a) => a !== "--dry-run");
const args = ["run", "hermex:grantha", "--", "Chandogya Upanishad", "--mantra", "1.1.1", ...extra];

const child = spawn("npm", args, { cwd: root, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
