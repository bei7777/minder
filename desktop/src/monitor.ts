import { parentPort, workerData } from "node:worker_threads";
import { Firewall, watchDirectory } from "@minder/cli/desktop";

if (!parentPort) throw new Error("目录监听需要独立工作线程");
const port = parentPort;
const { root, owner, stateDir } = workerData as { root: string; owner: string; stateDir: string };
const db = new Firewall(stateDir);
let stop: (() => Promise<void>) | undefined;
let pending: Promise<void> | undefined;
let closing = false;
const report = () => port.postMessage("error");

async function tick() {
  if (!db.lease(owner)) {
    await stop?.();
    stop = undefined;
    return;
  }
  stop ??= await watchDirectory(db, root, report);
  if (db.dispatchDue().length) port.postMessage("changed");
}

function refresh() {
  if (closing || pending) return;
  pending = tick().catch(report).finally(() => { pending = undefined; });
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
    port.close();
  }
});
refresh();
