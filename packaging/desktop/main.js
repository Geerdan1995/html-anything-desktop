"use strict";

/**
 * html-anything desktop shell (Electron main).
 *
 * Architecture (mirrors open-design's sidecar pattern, simplified):
 *   - The Next.js standalone server runs as a child of this process, launched
 *     via Electron itself in Node mode (`ELECTRON_RUN_AS_NODE=1`), so no
 *     separate node.exe ships with the app.
 *   - The BrowserWindow points at http://127.0.0.1:<port>, showing a local
 *     loader page until the server answers.
 *   - Server payload lives in extraResources (`resources/server-payload`),
 *     not inside asar — a plain Node child cannot read asar archives.
 *   - Auto-update via electron-updater against the fork's GitHub Releases:
 *     banner dialog → download with progress → silent install → relaunch.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execSync } = require("node:child_process");
const { autoUpdater } = require("electron-updater");

const BASE_PORT = 3000;
const MAX_PORT_OFFSET = 25;
const READY_TIMEOUT_MS = 60_000;
const SERVER_RESTART_LIMIT = 3;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let serverChild = null;
let serverPort = 0;
let serverRestarts = 0;
let quitting = false;
let updateProgressWindow = null;
let checkingForUpdate = false;

function payloadRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "server-payload")
    : path.join(__dirname, "server-payload");
}

function payloadCommit() {
  try {
    const txt = fs.readFileSync(path.join(payloadRoot(), "version.txt"), "utf8");
    const m = txt.match(/commit:\s*(\S+)/);
    return m ? m[1] : "unknown";
  } catch {
    return "unknown";
  }
}

function log(line) {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "main.log"), `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {}
}

function httpGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
  });
}

function isUp(port) {
  return httpGet(port, "/api/agents").then((code) => code === 200);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const tryPort = (port, offset) => {
      if (offset > MAX_PORT_OFFSET) {
        reject(new Error("no free port in 3000-3025"));
        return;
      }
      const srv = net.createServer();
      srv.once("error", () => tryPort(port + 1, offset + 1));
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryPort(BASE_PORT, 0);
  });
}

function openServerLog() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(path.join(dir, "server.log"), "a");
}

function startServer() {
  return new Promise((resolve, reject) => {
    // srv/ nesting: electron-builder strips a root-level node_modules from
    // extraResources — see build-desktop.mjs.
    const serverJs = path.join(payloadRoot(), "srv", "next", "server.js");
    if (!fs.existsSync(serverJs)) {
      dialog.showErrorBox(
        "HTML Anything",
        `Server payload not found:\n${serverJs}\n\nThe installation is incomplete — please reinstall.`,
      );
      app.quit();
      reject(new Error("payload missing"));
      return;
    }
    findFreePort()
      .then((port) => {
        serverPort = port;
        const fd = openServerLog();
        serverChild = spawn(process.execPath, [serverJs], {
          cwd: path.dirname(serverJs),
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            PORT: String(port),
            HOSTNAME: "127.0.0.1",
            NODE_ENV: "production",
          },
          stdio: ["ignore", fd, fd],
          windowsHide: true,
        });
        log(`spawned server pid=${serverChild.pid} port=${port}`);

        serverChild.on("exit", (code) => {
          log(`server exited code=${code} quitting=${quitting}`);
          if (quitting || code === 0 || code === null) return;
          if (serverRestarts++ < SERVER_RESTART_LIMIT) {
            log(`restarting server (attempt ${serverRestarts}/${SERVER_RESTART_LIMIT})`);
            setTimeout(() => startServer().then(() => loadApp()).catch((e) => log(`restart failed: ${e}`)), 1000);
          } else {
            dialog.showErrorBox(
              "HTML Anything",
              `The local server keeps exiting (code ${code}).\nLogs: ${path.join(app.getPath("userData"), "logs")}`,
            );
            app.quit();
          }
        });

        const deadline = Date.now() + READY_TIMEOUT_MS;
        const poll = () => {
          isUp(port).then((up) => {
            if (up) {
              log(`server ready on :${port}`);
              resolve(port);
            } else if (Date.now() > deadline) {
              reject(new Error(`server did not become ready on :${port}`));
            } else {
              setTimeout(poll, 300);
            }
          });
        };
        poll();
      })
      .catch(reject);
  });
}

function killServerTree() {
  if (!serverChild || serverChild.exitCode !== null) return;
  const pid = serverChild.pid;
  try {
    // Tree-kill: Next may have spawned agent CLIs / workers.
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    log(`killed server tree pid=${pid}`);
  } catch {
    try {
      serverChild.kill("SIGKILL");
    } catch {}
  }
}

/* ---------------------------------------------------------------- updates */

function setupAutoUpdate() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log(`[updater] ${m}`),
    warn: (m) => log(`[updater] WARN ${m}`),
    error: (m) => log(`[updater] ERROR ${m}`),
    debug: (m) => log(`[updater] ${m}`),
  };

  autoUpdater.on("update-available", (info) => {
    log(`update available: ${info.version} (current ${app.getVersion()})`);
    if (process.env.HTML_ANYTHING_AUTOUPDATE === "1") {
      startUpdateDownload(info.version);
      return;
    }
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "发现新版本",
        message: `发现新版本 ${info.version}`,
        detail: `当前版本 ${app.getVersion()}\n\n点击“立即更新”后会自动下载并安装，完成后应用会自动重启。你的数据不受影响。`,
        buttons: ["立即更新", "稍后再说"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) startUpdateDownload(info.version);
      })
      .catch(() => {});
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent || 0);
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
      updateProgressWindow.setProgressBar(progress.percent ? progress.percent / 100 : -1);
      const mb = (n) => (n ? (n / 1048576).toFixed(1) : "0");
      updateProgressWindow.webContents
        .executeJavaScript(
          `document.getElementById('p').textContent = '${pct}%（${mb(progress.transferred)} / ${mb(progress.total)} MB）'`,
        )
        .catch(() => {});
    }
  });

  autoUpdater.on("update-downloaded", () => {
    log("update downloaded — installing and restarting");
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
      updateProgressWindow.webContents
        .executeJavaScript(`document.getElementById('t').textContent='安装中，即将重启…'`)
        .catch(() => {});
    }
    // isSilent + isForceRunAfter: install without any wizard, relaunch app.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 500);
  });

  autoUpdater.on("error", (err) => {
    log(`[updater] error: ${err && err.message}`);
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) updateProgressWindow.close();
    if (process.env.HTML_ANYTHING_AUTOUPDATE === "1") return;
    dialog.showErrorBox("更新失败", `${err && err.message}\n\n可稍后在 帮助 → 检查更新 重试。`);
  });

  checkForUpdates(true);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

function checkForUpdates(silent) {
  if (checkingForUpdate) return;
  if (!app.isPackaged) {
    if (!silent) dialog.showMessageBox({ message: "开发模式不支持更新检查" });
    return;
  }
  checkingForUpdate = true;
  autoUpdater
    .checkForUpdates()
    .then((r) => {
      checkingForUpdate = false;
      if (silent) return;
      // No "update-available" event means we're on the latest version.
      if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "检查更新",
          message: "已是最新版本",
          detail: `当前版本 ${app.getVersion()}（上游 ${payloadCommit()}）`,
        });
      }
    })
    .catch((err) => {
      checkingForUpdate = false;
      if (!silent) dialog.showErrorBox("检查更新失败", String(err && err.message));
    });
}

function startUpdateDownload(version) {
  log(`starting update download to ${version}`);
  updateProgressWindow = new BrowserWindow({
    width: 420,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: "正在更新 HTML Anything",
    backgroundColor: "#0b0b0f",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  updateProgressWindow.setMenuBarVisibility(false);
  updateProgressWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{margin:0;height:100vh;background:#0b0b0f;color:#e7e7ea;font-family:"Segoe UI","Microsoft YaHei",sans-serif;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
        h2{font-size:15px;font-weight:600;margin:0}p{font-size:12px;color:#9a9aa3;margin:0}
        .bar{width:300px;height:6px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden}
        .bar>i{display:block;height:100%;width:30%;background:#6d5cff;border-radius:3px;animation:move 1.2s ease-in-out infinite}
        @keyframes move{0%{margin-left:-40%}100%{margin-left:100%}}
        </style></head><body>
        <h2 id="t">正在下载新版本 ${version}</h2>
        <div class="bar"><i></i></div>
        <p id="p">准备中…</p>
        </body></html>`,
      ),
  );
  autoUpdater.downloadUpdate().catch(() => {});
}

ipcMain.handle("app:get-version", () => ({ version: app.getVersion(), commit: payloadCommit() }));

/* ------------------------------------------------------------------- app */

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [{ role: "quit", label: "退出" }],
    },
    {
      label: "查看",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "检查更新…", click: () => checkForUpdates(false) },
        {
          label: "关于 HTML Anything",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: "HTML Anything 桌面版",
              detail: `版本 ${app.getVersion()}\n上游 commit ${payloadCommit()}\n基于 nexu-io/html-anything（Apache-2.0）\n更新通过 GitHub Releases 自动推送`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0f",
    title: "HTML Anything",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Links that would open a new window (docs, exports help…) go to the
  // system browser instead of a bare Electron popup without chrome.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "loader.html"));
}

function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();
    setupAutoUpdate();
    try {
      await startServer();
      loadApp();
    } catch (err) {
      log(`FATAL ${err && err.stack ? err.stack : String(err)}`);
      dialog.showErrorBox(
        "HTML Anything",
        `Failed to start the local server:\n${err && err.message}\n\nLogs: ${path.join(app.getPath("userData"), "logs")}`,
      );
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("will-quit", () => {
    killServerTree();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
