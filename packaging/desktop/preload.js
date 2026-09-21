"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Exposed to the web app (optional convenience; the app works without it).
contextBridge.exposeInMainWorld("htmlAnythingDesktop", {
  getVersion: () => ipcRenderer.invoke("app:get-version"),
});
