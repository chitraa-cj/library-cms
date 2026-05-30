import fs from "node:fs";
import path from "node:path";

const DEV_BUILD_ID = "dev";

function distPublicDir(): string {
  return path.resolve(__dirname, "public");
}

/** Written by `npm run build` — used to prompt users to refresh after deploy. */
export function readClientBuildId(): string {
  if (process.env.APP_BUILD_ID?.trim()) {
    return process.env.APP_BUILD_ID.trim();
  }
  try {
    const file = path.join(distPublicDir(), ".build-id");
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8").trim() || DEV_BUILD_ID;
    }
  } catch {
    /* ignore */
  }
  return DEV_BUILD_ID;
}
