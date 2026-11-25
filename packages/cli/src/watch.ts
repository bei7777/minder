import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Firewall, scoreWithOllama, syncFeed, watchDirectory, type SourceEvent } from "@minder/core-firewall";
import { home, type Config } from "./config.js";

export async function watch(config: Config, feeds: string[], once: boolean, model?: string) {
  const db=new Firewall(join(home,"firewall"));
  const owner=randomUUID();
  const abort=new AbortController();
  let failure: Error | undefined;
  let stopDirectory: (()=>Promise<void>) | undefined;
  const stop=()=>abort.abort();
  const fail=(e:Error)=>{failure=e;stop();};
  const scorer=model ? (e:SourceEvent)=>scoreWithOllama(model,e) : undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if(!db.lease(owner)) throw new Error("已有监听进程正在运行");
    timer=setInterval(()=>{
      try { if(!db.lease(owner)) throw new Error("监听租约已失效"); }
      catch(error) { fail(error instanceof Error ? error : new Error(String(error))); }
    },20000);
    process.once("SIGINT",stop);
    process.once("SIGTERM",stop);
    stopDirectory=await watchDirectory(db,config.root,fail,scorer);
    do {
      if(abort.signal.aborted) break;
      for(const feed of feeds) await syncFeed(db,feed,scorer);
      const ready=db.dispatchDue();
      if(ready.length) console.log(JSON.stringify({inbox:ready.map(e=>e.id)}));
      if(!once) await wait(30000,undefined,{signal:abort.signal}).catch(error=>{
        if(error.name!=="AbortError") throw error;
      });
    } while(!once && !abort.signal.aborted);
    if(failure) throw failure;
  } finally {
    clearInterval(timer);
    process.off("SIGINT",stop); process.off("SIGTERM",stop);
    try { await stopDirectory?.(); } finally { db.release(owner); db.close(); }
  }
}
