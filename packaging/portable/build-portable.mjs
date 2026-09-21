#!/usr/bin/env node
/**
 * Assemble the html-anything portable build:
 *   node packaging/portable/build-portable.mjs [--no-zip]
 *
 * Expects `pnpm -F @html-anything/next build` to have run with
 * `output: "standalone"` (desktop-packaging branch).
 *
 * Output: dist/html-anything-portable/  +  dist/html-anything-win-x64-portable-<ver>.zip
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const NEXT_DIR = path.join(REPO, "next");
const OUT_ROOT = path.resolve(HERE, "..", "dist");
const OUT = path.join(OUT_ROOT, "html-anything-portable");

const STANDALONE = path.join(NEXT_DIR, ".next", "standalone");
const STATIC = path.join(NEXT_DIR, ".next", "static");
const PUBLIC = path.join(NEXT_DIR, "public");

const noZip = process.argv.includes("--no-zip");

function die(msg) {
  console.error(`[build-portable] FATAL: ${msg}`);
  process.exit(1);
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return (total / 1024 / 1024).toFixed(1);
}

for (const [label, p] of [
  ["standalone output", STANDALONE],
  ["static output", STATIC],
  ["bundled node", process.execPath],
]) {
  if (!fs.existsSync(p)) die(`${label} not found at ${p} — run the build first`);
}
// pnpm monorepo: standalone reproduces the workspace layout, server.js sits
// under the workspace dir, not at the standalone root.
if (!fs.existsSync(path.join(STANDALONE, "next", "server.js"))) {
  die(`${STANDALONE}\\next\\server.js not found — standalone output incomplete`);
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO })
  .toString()
  .trim();

console.log(`[build-portable] commit ${commit}, node ${process.version}`);
console.log(`[build-portable] cleaning ${OUT}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log("[build-portable] copying standalone server -> app/");
// dereference: pnpm-style symlinks inside node_modules must become real
// files, or the copy breaks outside this repo (and through zip extraction).
fs.cpSync(STANDALONE, path.join(OUT, "app"), { recursive: true, dereference: true });

console.log("[build-portable] copying .next/static -> app/next/.next/static");
fs.cpSync(STATIC, path.join(OUT, "app", "next", ".next", "static"), { recursive: true });

if (fs.existsSync(PUBLIC)) {
  console.log("[build-portable] copying public/ -> app/next/public");
  fs.cpSync(PUBLIC, path.join(OUT, "app", "next", "public"), { recursive: true });
}

console.log(`[build-portable] bundling node runtime from ${process.execPath}`);
fs.mkdirSync(path.join(OUT, "runtime"), { recursive: true });
fs.copyFileSync(process.execPath, path.join(OUT, "runtime", "node.exe"));

console.log("[build-portable] copying launcher files");
for (const f of ["launch.js", "start.vbs", "start.bat", "stop-server.bat", "README.txt"]) {
  fs.copyFileSync(path.join(HERE, f), path.join(OUT, f));
}

fs.writeFileSync(
  path.join(OUT, "version.txt"),
  `html-anything portable (win-x64)\ncommit: ${commit}\nbuilt: ${new Date().toISOString()}\nbundled node: ${process.version}\n`,
  "utf8",
);

const sizeMB = dirSizeMB(OUT);
console.log(`[build-portable] assembled ${OUT} (${sizeMB} MB)`);

if (!noZip) {
  const zipName = `html-anything-win-x64-portable-${commit}.zip`;
  const zipPath = path.join(OUT_ROOT, zipName);
  fs.rmSync(zipPath, { force: true });
  console.log(`[build-portable] zipping -> ${zipName}`);
  // Forward slashes: backslashes in the -Command string trip PowerShell.
  const src = `${OUT.replaceAll("\\", "/")}/*`;
  const dst = zipPath.replaceAll("\\", "/");
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Compress-Archive -Path '${src}' -DestinationPath '${dst}' -CompressionLevel Optimal`],
    { stdio: "inherit" },
  );
  console.log(`[build-portable] done: ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
}
