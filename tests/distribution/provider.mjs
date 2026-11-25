import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../../",import.meta.url));
const lab = join(project,".minder-dev","distribution");
const read = path=>JSON.parse(readFileSync(path,"utf8"));
const options = process.argv.slice(2);
const wantMemory = options.includes("--memory");
const [installed,...extra] = options.filter(option=>option!=="--memory");
const {MINDER_TEST_PROVIDER_FILE:file,MINDER_TEST_PROVIDER:provider,MINDER_TEST_MODEL:model} = process.env;
let stage = "configuration";

function installedConsumer() {
  if (installed) return resolve(installed);
  const inventory = read(join(lab,"release.json"));
  const runs = join(lab,"runs");
  const candidates = readdirSync(runs).map(name=>join(runs,name,"locked-copy"))
    .filter(dir=>existsSync(join(dir,"node_modules","@minder","cli","package.json")))
    .sort((left,right)=>statSync(right).mtimeMs-statSync(left).mtimeMs);
  const match = candidates.find(dir=>read(join(dir,"release.json")).digest===inventory.digest);
  assert.ok(match,"Run pnpm lab test-kit first");
  return match;
}

async function live() {
  if (!file && !provider && !model) {
    throw new Error("Provider configuration required");
  }
  assert.ok(file && provider && model && extra.length===0);
  const providerFile = realpathSync(file);
  const service = read(providerFile).providers[provider];
  const selected = service.models.find(entry=>entry.id===model);
  const origin = new URL(selected.baseUrl ?? service.baseUrl).origin;
  stage = "installed package";
  const consumer = realpathSync(installedConsumer());
  const pkg = join(consumer,"node_modules","@minder","cli");
  assert.equal(realpathSync(pkg),pkg);
  const {version} = read(join(pkg,"package.json"));
  const lock = read(join(consumer,"package-lock.json")).packages["node_modules/@minder/cli"];
  assert.ok(lock.integrity && lock.version===version && !lock.link);
  const cli = join(pkg,"lib","bin.js");
  const guard = fileURLToPath(new URL("./provider-guard.mjs",import.meta.url));
  const parent = join(project,".minder-dev","provider-check");
  mkdirSync(parent,{mode:0o700,recursive:true});
  const run = mkdtempSync(join(parent,"run-"));
  const area = join(run,"work");
  const root = join(area,"documents");
  const home = join(area,"state");
  const countFile = join(area,"requests");
  mkdirSync(root,{recursive:true,mode:0o700});
  writeFileSync(countFile,"",{mode:0o600});
  const count = ()=>readFileSync(countFile,"utf8").split("\n").filter(Boolean).length;
  const env = {...process.env,MINDER_HOME:home,MINDER_TEST_PROVIDER_FILE:providerFile,MINDER_TEST_ORIGIN:origin,MINDER_TEST_COUNTER:countFile};
  const invoke = async (name,...args)=>{
    stage = name;
    const result = await execute(process.execPath,["--import",guard,cli,name,...args],{
      env,cwd:root,encoding:"utf8",timeout:180000,killSignal:"SIGKILL",maxBuffer:4*1024*1024
    });
    return result.stdout;
  };
  const json = async (...args)=>JSON.parse(await invoke(...args));
  try {
    const config = await json("init","--provider-file",providerFile,"--provider",provider,"--model",model,"--root",root);
    assert.ok(config.verified && count()>0);
    const duringInit = count();
    await invoke("verify");
    assert.ok(count()>duringInit);
    assert.equal((await json("doctor","--json")).verified,true);

    const document = "sample.txt";
    const oldLine = "Minder sample "+randomUUID();
    const newLine = "Minder revision "+randomUUID();
    const original = Buffer.from(oldLine+"\n");
    writeFileSync(join(root,document),original);
    const request = [
      "Use the write tool to overwrite sample.txt with the following single line, ending in one newline.",
      newLine,
      ...(wantMemory ? ["Also use minder_memory_propose once to draft a core fact with key demo.color, text 'Demo color is violet', and source 'user request'. Leave it pending."] : [])
    ].join("\n");
    const beforeAsk = count();
    await invoke("ask",request);
    assert.ok(count()>beforeAsk);
    assert.deepEqual(readFileSync(join(root,document)),Buffer.from(newLine+"\n"));
    const transactions = (await json("files")).filter(item=>item.status==="committed");
    assert.equal(transactions.length,1);
    const diff = await json("files",transactions[0].id);
    assert.equal(diff.files.length,1);
    const [change] = diff.files;
    assert.equal(change.path,join(realpathSync(root),document));
    assert.equal(change.kind,"modify");
    const lines = change.patch.split(/\r?\n/);
    assert.ok(lines.includes("-"+oldLine) && lines.includes("+"+newLine));

    // 通过本地会话中的成功执行记录验证工具名称。只保存工具名称和断言。
    stage = "session tool results";
    const sessions = join(home,"sessions");
    const tools = new Set();
    for (const path of readdirSync(sessions,{recursive:true}).filter(name=>name.endsWith(".jsonl"))) {
      const entries = readFileSync(join(sessions,path),"utf8").split("\n").filter(Boolean);
      for (const line of entries) {
        const message = JSON.parse(line).message;
        if (message?.role==="toolResult" && !message.isError) tools.add(message.toolName);
      }
    }
    assert.ok(tools.has("write"));
    if (wantMemory) {
      assert.ok(tools.has("minder_memory_propose"));
      const pending = await json("memory","pending");
      const changes = (await Promise.all(pending.map(item=>json("memory","diff",item.id)))).flat();
      assert.ok(changes.some(item=>item.key==="demo.color" && item.after?.includes("violet")));
    }
    assert.equal((await json("undo",diff.id)).status,"undone");
    assert.deepEqual(readFileSync(join(root,document)),original);
    const evidence = {version,node:process.version,platform:process.platform,tools:[...tools].sort(),
      initVerified:true,verifyReadNonce:true,managedWrite:true,fileDiff:true,undoByteIdentical:true,
      ...(wantMemory ? {pendingMemory:true} : {}),realModelRequests:count()};
    writeFileSync(join(run,"evidence.json"),JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
    console.log(JSON.stringify(evidence));
  } finally {
    rmSync(area,{recursive:true,force:true});
  }
}

live().catch(()=>{
  console.error("Live provider test failed during "+stage+".");
  process.exitCode=1;
});
