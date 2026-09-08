const { app, dialog, Menu, nativeImage, shell, Tray } = require("electron");
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const url = "http://127.0.0.1:37421";
let tray;

function service(action) {
  if (process.platform !== "linux") return;
  const child = spawn("systemctl", ["--user", action, "pronoteconnect.service"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function open() {
  service("start");
  setTimeout(() => void shell.openExternal(url), 600);
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
  if (result.response !== 1 || process.platform !== "linux") return;
  const args = [join(root, "install.sh"), "--uninstall"];
  if (result.checkboxChecked) args.push("--delete-data");
  const child = spawn("bash", args, { detached: true, stdio: "ignore", cwd: root });
  child.unref();
  app.quit();
}

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on("second-instance", open);
  app.whenReady().then(() => {
    app.setName("PronoteConnect");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#4f46e5"/><path d="M18 17h19c7 0 12 5 12 12s-5 12-12 12H28v8H18V17Zm10 9v7h9c2 0 3-1 3-4 0-2-1-3-3-3h-9Z" fill="white"/></svg>`;
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize({ width: 24, height: 24 });
    tray = new Tray(icon);
    tray.setToolTip("PronoteConnect");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Ouvrir PronoteConnect", click: open },
      { type: "separator" },
      { label: "Démarrer le service", click: () => service("start") },
      { label: "Redémarrer le service", click: () => service("restart") },
      { label: "Arrêter le service", click: () => service("stop") },
      { type: "separator" },
      { label: "Désinstaller", click: () => void uninstall() },
      { label: "Quitter l'icône", click: () => app.quit() },
    ]));
    tray.on("double-click", open);
    if (process.argv.includes("--open")) open();
  });
}

app.on("window-all-closed", () => undefined);
