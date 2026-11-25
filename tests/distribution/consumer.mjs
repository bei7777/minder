import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode,cwd,root,home,inventory] = process.argv.slice(2);
const cli = join(cwd,"node_modules","@minder","cli","lib","bin.js");
const read = p=>JSON.parse(readFileSync(p,"utf8"));
const write = (p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+"\n");
const events = [];
const recordingStarted = performance.now();
const recording = [{version:2,width:112,height:32,timestamp:Math.floor(Date.now()/1000),title:"Minder local distribution"}];
function terminal(text) {
  recording.push([(performance.now()-recordingStarted)/1000,"o",text.replace(/\r?\n/g,"\r\n")]);
}
const model = process.env.MINDER_TEST_OLLAMA_MODEL || "qwen3:8b";
const manifest = read(inventory);
const actualVersion = read(join(cwd,"node_modules","@minder","cli","package.json")).version;
async function invoke(...args) {
  terminal("$ minder "+args.map(a=>a.includes(" ")?JSON.stringify(a):a).join(" ")+"\n");
  const output = await new Promise((ok,fail)=>{
    const child = spawn(process.execPath,[cli,...args],{cwd:root,env:process.env,stdio:["ignore","pipe","inherit"]});
    let data="";
    child.stdout.setEncoding("utf8").on("data",s=>{data+=s;terminal(s);});
    child.once("error",fail);
    child.once("exit",code=>code===0?ok(data):fail(new Error("minder "+args[0]+" exited with "+code)));
  });
  events.push({at:new Date().toISOString(),args,output});
  return output;
}
const json = async (...args)=>JSON.parse(await invoke(...args));
const init = ()=>json("init","--root",root,"--provider","ollama","--model",model,"--no-verify");
const digest = data=>createHash("sha256").update(data).digest("hex");
const stateFile = join(home,"test-evidence.json");
const fixture = join(root,"development.md");
const content = readFileSync(new URL("../../DEVELOPMENT.md",import.meta.url),"utf8");
async function seed() {
  const installedModule = name => {
    const pkg = join(cwd,"node_modules",name);
    return import(pathToFileURL(join(pkg,read(join(pkg,"package.json")).exports["."].import)));
  };
  const {openSnapshot} = await installedModule("@minder/core-snapshot");
  const {MemoryStore} = await installedModule("@minder/core-memory");
  writeFileSync(fixture,content);
  const snapshots = await openSnapshot({stateDir:join(home,"snapshot"),roots:[root]});
  const memory = new MemoryStore(join(home,"memory"));
  try {
    const tx = await snapshots.begin("Record the installed Minder package");
    await tx.write(fixture,content+"\nInstalled Minder CLI "+actualVersion+"\n");
    await tx.commit();
    const session = memory.begin("distribution-review");
    memory.propose(session,{layer:"core",key:"release.cli",source:inventory,intent:"user",text:"Minder 发行版使用 "+actualVersion+"。"});
    write(stateFile,{transaction:tx.id,session,contentHash:digest(content),version:actualVersion});
  } finally { snapshots.close(); memory.close(); }
}
async function exercise() {
  const {transaction,session,contentHash} = read(stateFile);
  assert.equal((await json("files",transaction)).files.length,1);
  assert.equal((await json("undo",transaction)).status,"undone");
  assert.equal(digest(readFileSync(fixture)),contentHash);
  assert.ok((await json("memory","diff",session)).length);
  assert.equal((await json("memory","commit",session)).sessionId,session);
  assert.ok((await json("memory","search","Minder")).length);
}
async function recordFeed() {
  const xml = readFileSync(new URL("../../demo/release.atom",import.meta.url));
  const server = createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/atom+xml"});res.end(xml);});
  await new Promise((ok,fail)=>server.once("error",fail).listen(0,"127.0.0.1",ok));
  try {
    const feed = "http://127.0.0.1:"+server.address().port+"/release.atom";
    await json("rules","quiet","00:00","00:00","UTC");
    await json("rules","source",feed,"5");
    await invoke("watch","--once","--feed",feed);
    const inbox = await json("inbox");
    assert.ok(inbox.flatMap(g=>g.events).some(e=>e.title==="Minder development plan"),"Release did not arrive in the inbox");
  } finally { await new Promise(ok=>server.close(ok)); }
}
if (mode==="test-install") {
  assert.match(await invoke("--help"),/minder undo|undo ID/);
  assert.equal(actualVersion,manifest.packages.find(p=>p.name==="@minder/cli").version);
  const lock = read(join(cwd,"package-lock.json"));
  for (const pkg of manifest.packages.filter(p=>p.repo!=="dsh-plugin-minder")) {
    const installed = lock.packages["node_modules/"+pkg.name];
    assert.equal(installed.integrity,pkg.integrity,pkg.name+" did not come from the local release tarball");
    assert.equal(installed.version,pkg.version);
    assert.ok(!installed.link);
  }
} else if (mode==="test-init") {
  const settings = await init();
  assert.equal(settings.root,realpathSync(root));
  assert.equal(settings.verified,false);
  const doctor = await json("doctor","--json");
  assert.ok(doctor.tools.includes("minder_memory_search") && doctor.tools.includes("minder_delete") && doctor.tools.includes("minder_firewall_list"));
  assert.equal(doctor.verified,false);
  assert.equal(doctor.model,model);
} else if (mode==="prepare-upgrade") {
  await init(); await seed();
} else if (mode==="verify-upgrade") {
  assert.notEqual(actualVersion,read(stateFile).version);
  assert.equal(read(join(home,"config.json")).root,realpathSync(root));
  await exercise();
} else if (mode==="demo") {
  await init(); await seed(); await exercise(); await recordFeed();
  assert.ok(existsSync(fixture));
} else throw new Error("Unknown distribution test "+mode);
write(join(home,mode+".json"),{mode,node:process.version,platform:process.platform,release:manifest.digest,events});
if (mode==="demo") writeFileSync(join(home,"minder.cast"),recording.map(row=>JSON.stringify(row)).join("\n")+"\n");
