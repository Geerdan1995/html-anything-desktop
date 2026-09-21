#!/usr/bin/env node
/**
 * html-anything portable launcher.
 *
 * Invoked with no args (hidden, via start.vbs / start.bat):
 *   1. If our server is already running (pid file + alive + port answers),
 *      just open the browser — double-launch is a no-op.
 *   2. Otherwise pick a free port (3000, then 3001..3025), spawn
 *      runtime/node.exe app/server.js detached on 127.0.0.1, wait until it
 *      answers, then open the default browser.
 *
 * Invoked with `--stop`: read run/server.pid and kill the server tree.
 *
 * Everything the user sees is the browser; this process exits right after.
 * A log is appended to run/launch.log so failures under wscript are still
 * diagnosable.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
// monorepo standalone layout: app/next/server.js (workspace dir reproduced)
const APP_DIR = path.join(ROOT, "app", "next");
const SERVER_JS = path.join(APP_DIR, "server.js");
const RUNTIME_NODE = path.join(ROOT, "runtime", "node.exe");
const RUN_DIR = path.join(ROOT, "run");
const PID_FILE = path.join(RUN_DIR, "server.pid");
const PORT_FILE = path.join(RUN_DIR, "server.port");
const LOG_FILE = path.join(RUN_DIR, "launch.log");

const BASE_PORT = 3000;
const MAX_PORT_OFFSET = 25;
const READY_TIMEOUT_MS = 60_000;

function log(msg) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {}
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // alive but not ours
  }
}

function readInt(file) {
  try {
    return parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  } catch {
    return NaN;
  }
}

function httpGet(host, port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: urlPath, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
  });
}

/** True when something already listens on the port and answers like our app. */
async function isOurApp(port) {
  const code = await httpGet("127.0.0.1", port, "/api/agents", 2500);
  return code === 200;
}

function findFreePort(preferredCheck) {
  return new Promise((resolve) => {
    const tryPort = (port, offset) => {
      if (offset > MAX_PORT_OFFSET) {
        resolve({ port: 0, reason: "no-free-port" });
        return;
      }
      const srv = net.createServer();
      srv.once("error", () => tryPort(port + 1, offset + 1));
      srv.once("listening", () => srv.close(() => resolve({ port, reason: "ok" })));
      srv.listen(port, "127.0.0.1");
    };
    if (preferredCheck) {
      // Caller already knows `preferredCheck` is occupied by our app.
      tryPort(preferredCheck + 1, 1);
    } else {
      tryPort(BASE_PORT, 0);
    }
  });
}

function openBrowser(url) {
  // `start` is a cmd builtin; windowsHide hides the cmd flash, not the browser.
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err) => log(`open browser failed: ${err.message}`));
  child.unref();
}

async function waitForReady(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isOurApp(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function start() {
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const prevPid = readInt(PID_FILE);
  const prevPort = readInt(PORT_FILE);
  if (Number.isInteger(prevPort) && prevPort > 0 && (await isOurApp(prevPort))) {
    if (Number.isInteger(prevPid) && !pidAlive(prevPid)) {
      log(`port ${prevPort} answers but pid ${prevPid} is gone — adopting existing instance`);
    }
    log(`already running on :${prevPort} — opening browser`);
    openBrowser(`http://127.0.0.1:${prevPort}`);
    return;
  }

  for (const f of [SERVER_JS, RUNTIME_NODE]) {
    if (!fs.existsSync(f)) {
      log(`FATAL: missing ${f}`);
      throw new Error(`missing ${f}`);
    }
  }

  // Port 3000 might be served by something else entirely (another dev server,
  // another app). Only reuse it when it answers like html-anything.
  let port = BASE_PORT;
  const baseIsOurs = await isOurApp(BASE_PORT);
  if (!baseIsOurs) {
    const { port: free, reason } = await findFreePort();
    if (reason !== "ok") {
      log("FATAL: no free port in 3000-3025");
      throw new Error("no free port");
    }
    port = free;
  }

  if (baseIsOurs) {
    log(`html-anything already serving on :${BASE_PORT} (foreign instance) — opening browser`);
    fs.writeFileSync(PORT_FILE, String(BASE_PORT), "utf8");
    openBrowser(`http://127.0.0.1:${BASE_PORT}`);
    return;
  }

  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
  };
  // Capture server output so boot crashes are diagnosable (wscript hides all).
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const serverLog = fs.openSync(path.join(RUN_DIR, "server.log"), "a");
  const child = spawn(RUNTIME_NODE, [SERVER_JS], {
    cwd: APP_DIR,
    env,
    detached: true,
    stdio: ["ignore", serverLog, serverLog],
    windowsHide: true,
  });
  child.on("error", (err) => log(`spawn server failed: ${err.message}`));
  child.unref();

  fs.writeFileSync(PID_FILE, String(child.pid), "utf8");
  fs.writeFileSync(PORT_FILE, String(port), "utf8");
  log(`spawned server pid=${child.pid} port=${port}, waiting for ready`);

  if (await waitForReady(port)) {
    log(`server ready on :${port} — opening browser`);
    openBrowser(`http://127.0.0.1:${port}`);
  } else {
    log(`FATAL: server on :${port} did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
  }
}

function stop() {
  const pid = readInt(PID_FILE);
  const port = readInt(PORT_FILE);
  if (!pidAlive(pid)) {
    log("stop: server not running");
    return;
  }
  try {
    // server was spawned detached in its own group; kill the tree
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    log(`stop: killed pid=${pid} (port ${port})`);
  } catch (err) {
    log(`stop failed: ${err.message}`);
  }
  try {
    fs.unlinkSync(PID_FILE);
    fs.unlinkSync(PORT_FILE);
  } catch {}
}

async function main() {
  try {
    if (process.argv.includes("--stop")) stop();
    else await start();
  } catch (err) {
    log(`FATAL: ${err && err.stack ? err.stack : String(err)}`);
    process.exitCode = 1;
  }
}

main();
