import { parentPort, workerData } from "node:worker_threads";
import { Firewall, TaskStore, home, watchDirectory } from "@minder/cli/desktop";

if (!parentPort) throw new Error("目录监听需要独立工作线程");
const port = parentPort;
const { root, owner, stateDir, nativeNotifications } = workerData as {
  root: string; owner: string; stateDir: string; nativeNotifications:boolean
};
const db = new Firewall(stateDir);
const tasks = new TaskStore(home, root);
let stop: (() => Promise<void>) | undefined;
let pending: Promise<void> | undefined;
let closing = false;
const report = () => port.postMessage("error");

async function updateWatch() {
  if (!db.lease(owner)) {
    await stop?.();
    stop = undefined;
    return;
  }
  stop ??= await watchDirectory(db, root, report);
}

function canNotifyNow() {
  const rules=db.settings();
  if(rules.quietStart===rules.quietEnd || rules.rules.some(rule=>rule.sourceId===tasks.sourceId && rule.bypassQuiet)) return true;
  const time=new Intl.DateTimeFormat("en-GB",{timeZone:rules.timezone,hourCycle:"h23",
    hour:"2-digit",minute:"2-digit"}).format(new Date());
  const {quietStart:start,quietEnd:end}=rules;
  return start<end ? time<start || time>=end : time<start && time>=end;
}
function refresh() {
  if (closing) return;
  try {
    tasks.dispatchDue(db);
    if (db.dispatchDue().length) port.postMessage("changed");
    if (nativeNotifications && canNotifyNow()) for (const {id,title,summary} of tasks.claimNotifications(db))
      port.postMessage({type:"task-notice",id,title,summary});
  } catch { report(); }
  if (!pending) pending = updateWatch().catch(report).finally(() => { pending = undefined; });
}

const timer = setInterval(refresh, 15_000);
port.once("message", async message => {
  if (message !== "close") throw new Error("目录监听收到无效请求");
  closing = true;
  clearInterval(timer);
  try {
    await pending;
    await stop?.();
  } finally {
    db.release(owner);
    db.close();
    tasks.close();
    port.close();
  }
});
refresh();
