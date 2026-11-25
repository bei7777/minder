import { contextBridge, ipcRenderer } from "electron";
import type { DesktopEvent, MinderDesktop } from "./contracts.js";

const invoke = (name:string, ...args:unknown[]) => ipcRenderer.invoke("minder:" + name, ...args);
const api: MinderDesktop = {
  status: () => invoke("status"),
  chooseWorkspace: () => invoke("chooseWorkspace"),
  chooseProvider: () => invoke("chooseProvider"),
  configure: settings => invoke("configure",settings),
  openWebLink: url => invoke("openWebLink",url),
  verify: () => invoke("verify"),
  send: text => invoke("send",text),
  cancel: () => invoke("cancel"),
  newChat: () => invoke("newChat"),
  tasks: () => invoke("tasks"),
  homeTasks: () => invoke("homeTasks"),
  createTask: input => invoke("createTask",input),
  updateTask: (id,update,revision) => invoke("updateTask",id,update,revision),
  completeTask: (id,revision) => invoke("completeTask",id,revision),
  files: () => invoke("files"),
  diff: id => invoke("diff",id),
  undo: id => invoke("undo",id),
  pending: () => invoke("pending"),
  memoryDiff: session => invoke("memoryDiff",session),
  review: (session,key,accept) => invoke("review",session,key,accept),
  inbox: () => invoke("inbox"),
  accept: (id,revision) => invoke("accept",id,revision),
  rules: () => invoke("rules"),
  saveRules: rules => invoke("saveRules",rules),
  onEvent(handler) {
    const listener = (_event: unknown, payload: DesktopEvent) => handler(payload);
    ipcRenderer.on("minder:event",listener);
    return () => { ipcRenderer.removeListener("minder:event",listener); };
  },
};
contextBridge.exposeInMainWorld("minder",api);
