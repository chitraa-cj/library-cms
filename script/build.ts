import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile, copyFile } from "fs/promises";
import path from "path";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  const buildId = new Date().toISOString();
  await writeFile(path.join("dist", "public", ".build-id"), buildId, "utf8");
  console.log(`wrote build id ${buildId}`);

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    // Minify whitespace and syntax but NOT identifiers:
    // Renaming variables to single letters causes esbuild TDZ bugs in complex
    // async code and makes runtime error messages unreadable (e.g. "Cannot access
    // 'F' before initialization" instead of the actual variable name).
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    external: externals,
    logLevel: "info",
  });

  // connect-pg-simple reads its session-table DDL from a non-JS asset at runtime:
  //   fs.readFile(path.resolve(__dirname, './table.sql'))
  // esbuild bundles the JS but not the .sql file, and at runtime __dirname is dist/.
  // Without this copy, the first session write (login) when the "session" table is
  // missing throws ENOENT: .../dist/table.sql. Copy it next to the bundle so deploys
  // self-heal. connect-pg-simple is in the bundle allowlist, so __dirname === dist/.
  await copyFile(
    path.join("node_modules", "connect-pg-simple", "table.sql"),
    path.join("dist", "table.sql"),
  );
  console.log("copied connect-pg-simple/table.sql -> dist/table.sql");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
