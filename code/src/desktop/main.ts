import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { authenticateDesktop } from "./auth.js";
import { importDesktopData } from "./import-data.js";
import { DesktopServiceHost } from "./service-host.js";
import { ensureDesktopConfig } from "./user-data.js";
import { resolveWorkspace } from "../ui/workspace-registry.js";
import { zhCN } from "../i18n/catalog.js";
import { chooseDesktopWorkspace } from "./workspace-choice.js";
import { readDesktopModelSetup, saveDesktopModelSetup } from "./model-setup.js";
import { WorkspaceRegistry } from "../ui/workspace-registry.js";

let window: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let service: DesktopServiceHost | undefined;
let allowQuit = false;
let quitting = false;
const copy = zhCN.desktop;
const smokeMode = process.argv.includes("--desktop-smoke");
const e2eMode = process.argv.includes("--desktop-e2e") && Boolean(process.env.FIGO_DESKTOP_SMOKE_CONFIG_ROOT);
const testConfigRoot = (smokeMode || e2eMode) ? process.env.FIGO_DESKTOP_SMOKE_CONFIG_ROOT : undefined;
if (testConfigRoot) {
  const testUserData = join(testConfigRoot, ".electron-user-data");
  mkdirSync(testUserData, { recursive: true });
  app.setPath("userData", testUserData);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { const target = window ?? setupWindow; target?.show(); target?.focus(); });
  app.whenReady().then(() => { void startDesktop().catch(async () => {
    await service?.stop(true);
    await dialog.showMessageBox({ type: "error", title: "Figo Agent", message: copy.startupFailed });
    allowQuit = true;
    app.quit();
  }); });
}

async function startDesktop(): Promise<void> {
  const smoke = smokeMode;
  const configRoot = (smoke || e2eMode) && process.env.FIGO_DESKTOP_SMOKE_CONFIG_ROOT
    ? process.env.FIGO_DESKTOP_SMOKE_CONFIG_ROOT : join(app.getPath("userData"), "data");
  const configFile = await ensureDesktopConfig(configRoot);
  const workspaceRoot = (smoke || e2eMode) && process.env.FIGO_DESKTOP_SMOKE_WORKSPACE
    ? await resolveWorkspace(process.env.FIGO_DESKTOP_SMOKE_WORKSPACE)
    : await chooseDesktopWorkspace(configRoot);
  if (!workspaceRoot && smokeMode) throw new Error("桌面烟测缺少工作区。");
  if (!workspaceRoot || (!smokeMode && !(await readDesktopModelSetup(configRoot)).configured)) {
    await showSetupWindow(configRoot, configFile);
    return;
  }
  await openWorkbenchWindow(configRoot, configFile, workspaceRoot);
}

async function recentWorkspaces(configRoot: string): Promise<string[]> {
  const registry = await WorkspaceRegistry.open(configRoot);
  try { return registry.recent(); }
  finally { registry.close(); }
}

async function showSetupWindow(configRoot: string, configFile: string): Promise<void> {
  const appRoot = app.getAppPath();
  const setupPath = join(appRoot, "web/dist/setup.html");
  const setupUrl = pathToFileURL(setupPath).href;
  setupWindow = new BrowserWindow({
    width: 900, height: 780, minWidth: 640, minHeight: 600,
    title: "Figo Agent", show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: join(appRoot, "setup-preload.cjs") }
  });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== setupUrl) event.preventDefault();
  });
  const ownRequest = (sender: Electron.WebContents, frameUrl: string) => {
    if (!setupWindow || sender !== setupWindow.webContents || frameUrl !== setupUrl) throw new Error("设置页面未授权。");
  };
  let opening = false;
  ipcMain.handle("figo-setup:read", async (event) => {
    ownRequest(event.sender, event.senderFrame?.url ?? "");
    return { model: await readDesktopModelSetup(configRoot), recent: await recentWorkspaces(configRoot) };
  });
  ipcMain.handle("figo-setup:save-model", async (event, input: unknown) => {
    ownRequest(event.sender, event.senderFrame?.url ?? "");
    return saveDesktopModelSetup(configRoot, input as Parameters<typeof saveDesktopModelSetup>[1]);
  });
  ipcMain.handle("figo-setup:pick-workspace", async (event) => {
    ownRequest(event.sender, event.senderFrame?.url ?? "");
    const result = await dialog.showOpenDialog(setupWindow!, { title: copy.chooseWorkspace, properties: ["openDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : resolveWorkspace(result.filePaths[0]);
  });
  ipcMain.handle("figo-setup:open-workspace", async (event, path: unknown) => {
    ownRequest(event.sender, event.senderFrame?.url ?? "");
    if (opening) throw new Error("工作区正在打开。");
    if (!(await readDesktopModelSetup(configRoot)).configured) throw new Error("请先配置模型。");
    if (typeof path !== "string") throw new Error("工作区路径无效。");
    opening = true;
    try {
      await openWorkbenchWindow(configRoot, configFile, await resolveWorkspace(path));
      setupWindow?.close();
    } finally { opening = false; }
  });
  setupWindow.on("closed", () => {
    setupWindow = undefined;
    for (const channel of ["read", "save-model", "pick-workspace", "open-workspace"]) ipcMain.removeHandler(`figo-setup:${channel}`);
  });
  setupWindow.once("ready-to-show", () => setupWindow?.show());
  await setupWindow.loadFile(setupPath);
}

async function openWorkbenchWindow(configRoot: string, configFile: string, workspaceRoot: string): Promise<void> {

  const appRoot = app.getAppPath();
  const { host, ready } = await DesktopServiceHost.start(
    join(appRoot, "dist/desktop/service.js"),
    { configRoot, workspaceRoot, staticRoot: join(appRoot, "web/dist") },
    async () => {
      const result = await dialog.showOpenDialog({ title: copy.chooseWorkspace, properties: ["openDirectory"] });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    () => {
      if (!quitting) void dialog.showMessageBox({ type: "error", title: "Figo Agent", message: copy.serviceExited });
    }
  );
  service = host;
  const cookie = await authenticateDesktop(ready.url, ready.accessCode);
  if (smokeMode) {
    const bootstrap = await fetch(`${ready.url}/api/v1/bootstrap`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
    const body = await bootstrap.json() as { workspacePath?: string; modelConfigured?: boolean };
    const page = await fetch(ready.url);
    const html = await page.text();
    const asset = /src="(\.?\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
    const script = asset ? await fetch(new URL(asset, ready.url)) : undefined;
    const staticAsset = page.ok && Boolean(script?.ok && (await script.text()).length > 1000);
    process.stdout.write(`FIGO_DESKTOP_SMOKE=${JSON.stringify({
      authenticated: bootstrap.ok, workspace: body.workspacePath === workspaceRoot,
      blankModelKeyBlocked: body.modelConfigured === false,
      sqlite: Boolean(ready.sqlite), sqliteVersion: ready.sqlite, staticAsset,
      electron: process.versions.electron, node: ready.node
    })}\n`);
    await host.stop();
    allowQuit = true;
    app.quit();
    return;
  }

  const webSession = session.fromPartition("persist:figo-workbench");
  await webSession.cookies.remove(ready.url, cookie.name);
  await webSession.cookies.set({ url: ready.url, name: cookie.name, value: cookie.value,
    path: "/", httpOnly: true, sameSite: "strict" });
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: "Figo Agent", show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:figo-workbench" }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).protocol === "https:") void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== ready.url) event.preventDefault();
  });
  window.on("close", (event) => { if (!allowQuit) { event.preventDefault(); app.quit(); } });
  window.once("ready-to-show", () => window?.show());
  await window.loadURL(ready.url);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Figo Agent", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
    { label: copy.fileMenu, submenu: [
      { label: copy.openModelConfig, click: () => { void shell.openPath(configFile); } },
      { label: copy.importOldConfig, click: () => { void importLegacyConfig(configRoot); } }
    ] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }
  ]));
}

async function importLegacyConfig(configRoot: string): Promise<void> {
  const chosen = await dialog.showOpenDialog({ title: copy.chooseLegacyConfig,
    properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (chosen.canceled || !chosen.filePaths[0]) return;
  try {
    await importDesktopData(chosen.filePaths[0], configRoot);
    await dialog.showMessageBox({ type: "info", title: copy.importCompleteTitle, message: copy.importCompleteMessage });
  } catch {
    await dialog.showMessageBox({ type: "error", title: copy.importFailedTitle, message: copy.importFailedMessage });
  }
}

app.on("before-quit", (event) => {
  if (allowQuit) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    const busy = await service?.isBusy() ?? false;
    if (busy) {
      const choice = dialog.showMessageBoxSync({ type: "warning", title: copy.busyExitTitle,
        message: copy.busyExitMessage, buttons: [copy.waitButton, copy.forceQuitButton], defaultId: 0, cancelId: 0 });
      if (choice === 0) { quitting = false; return; }
    }
    await service?.stop(busy);
    allowQuit = true;
    app.quit();
  })();
});

app.on("window-all-closed", () => app.quit());
