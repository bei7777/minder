import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../",import.meta.url));
const core = fileURLToPath(new URL("../../../pi-minder/packages/core-firewall/",import.meta.url));
const artifacts = await realpath(join(core,"lib"));
const {Firewall,watchDirectory,syncFeed} = await import(pathToFileURL(join(artifacts,"index.js")));
const parent = join(repo,".minder-dev","quiet-rate");
await mkdir(parent,{recursive:true});
const evidence = await mkdtemp(join(parent,"run-"));
const store = new Firewall(join(evidence,"firewall"));
const xml = await readFile(new URL("../../demo/release.atom",import.meta.url));
const server = createServer((_req,res)=>{
  res.writeHead(200,{"content-type":"application/atom+xml"});
  res.end(xml);
});
const pnpm = process.env.npm_execpath;
const command = pnpm && /pnpm/i.test(pnpm)
  ? (/\.[cm]?js$/i.test(pnpm) ? [process.execPath,pnpm] : [pnpm])
  : ["pnpm"];
const rounds = 3;
let stop;
let watcherError;
try {
  await new Promise((ok,fail)=>server.once("error",fail).listen(0,"127.0.0.1",ok));
  const feed = "http://127.0.0.1:"+server.address().port+"/release.atom";
  store.configure({quietStart:"00:00",quietEnd:"00:00",timezone:"UTC",rules:[{sourceId:feed,score:5}]});
  stop = await watchDirectory(store,artifacts,error=>{watcherError=error;});
  if (watcherError) throw watcherError;
  const initial = new Set(store.list().map(event=>event.id));
  const names = (await readdir(artifacts)).filter(name=>name.endsWith(".js") || name.endsWith(".d.ts"));
  assert.ok(names.length>0,"Build the real firewall package first");
  const dirId = "dir:"+artifacts;
  for (let round=0;round<rounds;round++) {
    const before = new Set(store.list().map(event=>event.id));
    await new Promise((ok,fail)=>{
      const build = spawn(command[0],[...command.slice(1),"run","build"],{cwd:core,stdio:"inherit"});
      build.once("error",fail);
      build.once("exit",code=>code===0 ? ok() : fail(new Error("Firewall build failed: "+code)));
    });
    const deadline = Date.now()+75000;
    while (true) {
      if (watcherError) throw watcherError;
      const observed = new Set(store.list().filter(event=>
        event.sourceId===dirId && !before.has(event.id) && event.kind==="modified"
      ).map(event=>event.externalId));
      if (names.every(name=>observed.has(name))) break;
      assert.ok(Date.now()<deadline,"Live watcher missed a compiler output in round "+(round+1));
      await delay(100);
    }
  }
  await syncFeed(store,feed);
  store.dispatchDue();
  const rows = store.list().filter(event=>!initial.has(event.id));
  const low = rows.filter(event=>event.sourceId===dirId && names.includes(event.externalId));
  const high = rows.filter(event=>event.sourceId===feed && event.externalId==="urn:minder:development-plan");
  assert.equal(rows.length,low.length+high.length,"An unlabelled source entered the sample");
  assert.ok(low.length>=rounds*names.length);
  assert.equal(high.length,1);
  const delivered = new Set(store.inbox().flatMap(group=>group.events.map(event=>event.id)));
  const silent = low.filter(event=>event.status==="archived" && event.deliveredAt===null && !delivered.has(event.id)).length;
  const notified = high.filter(event=>event.status==="ready" && delivered.has(event.id)).length;
  const score = {
    scope:"Controlled compiler outputs and an explicitly subscribed release, labelled by source and identity",
    node:process.version,platform:process.platform,rounds,excludedInitialEvents:initial.size,
    low:{total:low.length,silent,percent:100*silent/low.length},
    high:{total:high.length,notified,percent:100*notified/high.length},
    events:rows.map(({id,sourceId,externalId,revision,occurredAt,status,score})=>({id,sourceId,externalId,revision,occurredAt,status,score}))
  };
  await writeFile(join(evidence,"report.json"),JSON.stringify(score,null,2)+"\n");
  console.log(JSON.stringify({evidence,excluded:initial.size,low:score.low,high:score.high}));
  assert.ok(score.low.percent>=90);
  assert.equal(score.high.percent,100);
} finally {
  if (stop) await stop();
  if (server.listening) await new Promise(ok=>server.close(ok));
  store.close();
}
