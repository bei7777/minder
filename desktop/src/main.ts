import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopBackend } from "./backend.js";
import type { MinderAPI } from "./contracts.js";

const entry = fileURLToPath(new URL("../ui/index.html", import.meta.url));
const pageUrl = pathToFileURL(entry).href;
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
type Method = Exclude<keyof MinderAPI, "onEvent">;
const endpoints: Record<Method, number> = {
  status: 0, chooseWorkspace: 0, chooseProvider: 0, configure: 1, verify: 0,
  send: 1, cancel: 0, newChat: 0, files: 0, diff: 1, undo: 1, pending: 0,
  memoryDiff: 1, review: 3, inbox: 0, accept: 2, rules: 0, saveRules: 1,
};

let win: BrowserWindow | undefined;
let backend: DesktopBackend | undefined;
let closing: Promise<void> | undefined;
function currentWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) throw new Error("请打开 Minder 窗口");
  return win;
}

function errorMessage(method: Method, value: unknown): string {
  // Model clients can put provider response bodies and request information in errors.
  if (method === "send" || method === "verify") return method === "verify"
    ? "模型未完成文件读取验证，请检查服务配置、授权和网络连接"
    : "模型未完成回答，请检查服务配置、授权和网络连接";
  if (value && typeof value === "object" && "code" in value) {
    switch (value.code) {
      case "BUSY": return "当前文件事务正在执行，请稍后重试";
      case "CONFLICT": return "文件已发生变化，请检查文件内容后再撤销";
      case "STATE": return "请选择已经提交的文件事务";
      case "NOT_FOUND": return "文件事务已过期或已删除";
      case "OUTSIDE_ROOT": return "这项操作涉及当前资料目录以外的文件";
    }
  }
  if (value instanceof Error && /^[\p{Script=Han}a-zA-Z0-9 ，、。与]{1,100}$/u.test(value.message)
      && /^([\p{Script=Han}])/u.test(value.message)) return value.message;
  return "操作未完成，请刷新并检查本机配置和记录状态";
}

async function start() {
  session.defaultSession.setPermissionRequestHandler((_contents, _name, reply) => reply(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BrowserWindow({
    title: "Minder", width: 1080, height: 740, minWidth: 760, minHeight: 520,
    backgroundColor: "#f7f7f2", show: false, titleBarStyle: "hiddenInset",
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  const window = win;
  window.webContents.setWindowOpenHandler(() => ({action: "deny"}));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { win = undefined; });
  const service = new DesktopBackend({
    async workspace() {
      const result = await dialog.showOpenDialog(currentWindow(), {
        title: "选择 Minder 可以访问的资料目录", properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async providerFile() {
      const result = await dialog.showOpenDialog(currentWindow(), {
        title: "选择 Pi 模型配置", properties: ["openFile"], filters: [{name: "JSON", extensions: ["json"]}],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async confirm(title, message) {
      if (!win) return false;
      const result = await dialog.showMessageBox(win, {
        title: "Minder", message: title, detail: message, type: "warning",
        buttons: ["取消", "确认操作"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1;
    },
    emit(event) {
      if (win && !win.webContents.isDestroyed()) win.webContents.send("minder:event", event);
    },
    report(message) { console.error(message); },
  });
  backend = service;
  for (const method of Object.keys(endpoints) as Method[]) {
    ipcMain.handle("minder:" + method, async (event, ...args: unknown[]) => {
      const sender = event.senderFrame;
      if (win !== window || event.sender !== window.webContents || !sender ||
          sender !== window.webContents.mainFrame || sender.url !== pageUrl || args.length !== endpoints[method])
        throw new Error("这项操作需要在 Minder 主窗口中执行");
      try { return await Reflect.apply(service[method], service, args); }
      catch (error) { throw new Error(errorMessage(method, error)); }
    });
  }
  await window.loadFile(entry);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    if (!backend) return;
    event.preventDefault();
    closing ??= backend.close().finally(() => { backend = undefined; app.quit(); });
  });
  void app.whenReady().then(start).catch(() => {
    dialog.showErrorBox("Minder", "无法打开本地窗口，请检查安装包。");
    app.quit();
  });
}
