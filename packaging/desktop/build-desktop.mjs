#!/usr/bin/env node
/**
 * Assemble and build the html-anything desktop installer:
 *   node build-desktop.mjs [--publish]
 *
 * Env:
 *   DESKTOP_VERSION  e.g. 0.20260921.1 — written into package.json before
 *                    building (electron-updater compares semver).
 *   GH_TOKEN         required with --publish (GitHub release upload).
 *
 * Steps:
 *   1. Ensure the portable app payload exists (reuses the standalone tree
 *      produced by portable/build-portable.mjs — run it if missing).
 *   2. Copy it into ./server-payload (extraResources source).
 *   3. Run electron-builder → NSIS setup.exe in dist/desktop-out
 *      (optionally publishing a release to the fork).
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PORTABLE_BUILD = path.resolve(HERE, "..", "portable", "build-portable.mjs");
const PORTABLE_APP = path.join(REPO, "packaging", "dist", "html-anything-portable", "app");
const PAYLOAD = path.join(HERE, "server-payload");

const publish = process.argv.includes("--publish");

function sh(cmd, args, opts = {}) {
  console.log(`[build-desktop] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) {
    console.error(`[build-desktop] FATAL: ${cmd} exited ${r.status}`);
    process.exit(1);
  }
}

if (!fs.existsSync(PORTABLE_APP)) {
  console.log("[build-desktop] portable payload missing — building it first");
  sh(process.execPath, [PORTABLE_BUILD, "--no-zip"]);
}
if (!fs.existsSync(path.join(PORTABLE_APP, "next", "server.js"))) {
  console.error(`[build-desktop] FATAL: ${PORTABLE_APP}\\next\\server.js not found after portable build`);
  process.exit(1);
}

// Version stamping: electron-builder reads package.json; electron-updater
// compares it against latest.yml in the releases feed.
if (process.env.DESKTOP_VERSION) {
  const pkgPath = path.join(HERE, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = process.env.DESKTOP_VERSION;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`[build-desktop] version set to ${pkg.version}`);
} else {
  console.log(`[build-desktop] version stays ${JSON.parse(fs.readFileSync(path.join(HERE, "package.json"))).version}`);
}

console.log("[build-desktop] staging server payload (dereference symlinks)");
// Payload nests under srv/: electron-builder drops a node_modules that sits
// at the ROOT of an extraResources from-dir, but copies nested ones verbatim.
fs.rmSync(PAYLOAD, { recursive: true, force: true });
fs.cpSync(PORTABLE_APP, path.join(PAYLOAD, "srv"), { recursive: true, dereference: true });

const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: REPO,
  encoding: "utf8",
}).stdout.trim();
fs.writeFileSync(
  path.join(PAYLOAD, "version.txt"),
  `html-anything desktop (win-x64)\ncommit: ${commit}\nbuilt: ${new Date().toISOString()}\n`,
  "utf8",
);

console.log("[build-desktop] running electron-builder (nsis)");
const builderArgs = [path.join(HERE, "node_modules", "electron-builder", "cli.js"), "--win", "nsis"];
if (publish) {
  if (!process.env.GH_TOKEN) {
    console.error("[build-desktop] FATAL: --publish requires GH_TOKEN");
    process.exit(1);
  }
  builderArgs.push("--publish", "always");
}
// Invoke the JS entry directly — the .cmd shim misbehaves under spawnSync.
sh(process.execPath, builderArgs);
console.log("[build-desktop] done — installer in dist/desktop-out");
