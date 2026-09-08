const { app, dialog, Menu, nativeImage, shell, Tray } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const http = require("node:http");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const url = "http://127.0.0.1:37421";
const logDir = join(root, ".data", "logs");
const errorFile = join(logDir, "last-service-error.txt");
let tray;
let serviceOperation;

function nodeCommand() {
  const portable = join(root, ".runtime", "node", "node.exe");
  if (existsSync(portable)) return portable;
  try {
    const config = JSON.parse(readFileSync(join(root, ".runtime", "install.json"), "utf8").replace(/^\uFEFF/u, ""));
    if (typeof config.nodePath === "string" && existsSync(config.nodePath)) return config.nodePath;
  } catch {
  }
  return "node.exe";
}

function serviceError(fallback) {
  try {
    return readFileSync(errorFile, "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
}

async function showServiceError(message) {
  tray?.setToolTip("PronoteConnect · service arrêté");
  const result = await dialog.showMessageBox({
    type: "error",
    title: "PronoteConnect ne démarre pas",
    message: "Le service PronoteConnect n'a pas pu démarrer.",
    detail: serviceError(message),
    buttons: ["fermer", "ouvrir les journaux"],
    defaultId: 1,
    cancelId: 0,
  });
  if (result.response === 1) await shell.openPath(logDir);
}

function runService(action) {
  return new Promise((resolveService) => {
    const command = process.platform === "win32" ? nodeCommand() : "systemctl";
    const args = process.platform === "win32"
      ? [join(root, "scripts", "windows-service.cjs"), action]
      : ["--user", action, "pronoteconnect.service"];
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
    });
    let output = "";
    const collect = (chunk) => {
      if (output.length < 8_000) output += chunk.toString("utf8").slice(0, 8_000 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => resolveService({ ok: false, message: error.message }));
    child.once("close", (code) => resolveService({
      ok: code === 0,
      message: output.trim() || `Le gestionnaire s'est arrêté avec le code ${code ?? 1}.`,
    }));
  });
}

function service(action, notify = false) {
  if (serviceOperation) return serviceOperation;
  serviceOperation = runService(action).then(async (result) => {
    if (!result.ok && notify) await showServiceError(result.message);
    return result;
  }).finally(() => {
    serviceOperation = undefined;
  });
  return serviceOperation;
}

function healthy() {
  return new Promise((resolveHealth) => {
    const request = http.get(`${url}/health`, (response) => {
      response.resume();
      resolveHealth(response.statusCode === 200);
    });
    request.setTimeout(1_000, () => request.destroy());
    request.once("error", () => resolveHealth(false));
  });
}

async function open() {
  const result = await service("start", true);
  if (!result.ok) return;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await healthy()) {
      tray?.setToolTip("PronoteConnect · actif");
      await shell.openExternal(url);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  await showServiceError("L'interface locale ne répond pas après 30 secondes.");
}

async function uninstall() {
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Désinstaller PronoteConnect",
    message: "Désinstaller PronoteConnect de cet ordinateur ?",
    detail: "Le dépôt reste dans son dossier. Vous pourrez choisir de supprimer aussi les données locales.",
    buttons: ["Annuler", "Désinstaller"],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: "Supprimer le jeton PRONOTE et la configuration du tunnel",
  });
  if (result.response !== 1) return;
  const command = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "install.ps1"), "-Uninstall", ...(result.checkboxChecked ? ["-DeleteData"] : [])]
    : [join(root, "install.sh"), "--uninstall", ...(result.checkboxChecked ? ["--delete-data"] : [])];
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore", cwd: root });
  child.unref();
  app.quit();
}

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on("second-instance", () => void open());
  app.whenReady().then(() => {
    app.setName("PronoteConnect");
    if (process.platform === "win32") app.setAppUserModelId("PronoteConnect");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#4f46e5"/><path d="M18 17h19c7 0 12 5 12 12s-5 12-12 12H28v8H18V17Zm10 9v7h9c2 0 3-1 3-4 0-2-1-3-3-3h-9Z" fill="white"/></svg>`;
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize({ width: 24, height: 24 });
    tray = new Tray(icon);
    tray.setToolTip("PronoteConnect");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Ouvrir PronoteConnect", click: () => void open() },
      { type: "separator" },
      { label: "Démarrer le service", click: () => void service("start", true) },
      { label: "Redémarrer le service", click: () => void service("restart", true) },
      { label: "Arrêter le service", click: () => void service("stop", true) },
      { type: "separator" },
      { label: "Désinstaller", click: () => void uninstall() },
      { label: "Quitter l'icône", click: () => app.quit() },
    ]));
    tray.on("double-click", () => void open());
    if (process.argv.includes("--startup")) void service("start");
    if (process.argv.includes("--open")) void open();
    setInterval(() => {
      void healthy().then((active) => {
        tray?.setToolTip(active ? "PronoteConnect · actif" : "PronoteConnect · redémarrage");
        if (!active) void service("start");
      });
    }, 15_000).unref();
  });
}

app.on("window-all-closed", () => undefined);
