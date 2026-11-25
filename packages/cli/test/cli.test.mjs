import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, link, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "@minder/core-memory";

const run=promisify(execFile);
const bin=fileURLToPath(new URL("../lib/bin.js",import.meta.url));
await mkdir(resolve(".minder-dev"),{recursive:true});
const testDir=await mkdtemp(resolve(".minder-dev","cli-"));
const root=join(testDir,"notes");
const state=join(testDir,"state");
await mkdir(root);
const cli=(...args)=>run(process.execPath,[bin,...args],{env:{...process.env,MINDER_HOME:state},cwd:root});
const value=async(...args)=>JSON.parse((await cli(...args)).stdout);
test("CLI 首次配置、SDK 宿主装载、权限和记忆审阅",async()=>{
  assert.match((await cli("--help")).stdout,/File|files/);
  await assert.rejects(cli("init","--root",testDir,"--provider","ollama","--model","local","--no-verify"));
  const settings=await value("init","--root",root,"--provider","ollama","--model","local","--no-verify");
  assert.equal(settings.verified,false);
  assert.equal(settings.root,root);
  const diag=await value("doctor","--json");
  assert.ok(diag.tools.includes("minder_move"));
  assert.ok(!diag.tools.includes("bash"));
  assert.equal(diag.version,JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")).version);
  assert.equal((await value("permissions")).workspace,root);
  assert.deepEqual(await value("audit"),[]);
  const note=new MemoryStore(join(state,"memory"));
  try {
    note.begin("cli-review");
    note.propose("cli-review",{key:"ui.language",layer:"core",text:"当前项目界面使用中文。",intent:"user",source:"CLI 验收"});
  } finally { note.close(); }
  const pending=await value("memory","pending");
  assert.ok(pending.some(row=>row.id==="cli-review"));
  const commit=await value("memory","commit","cli-review","ui.language");
  assert.equal(commit.changes.length,1);
  assert.equal((await value("memory","search","中文")).length,1);
  await value("memory","revert",commit.id);
  assert.equal((await value("memory","search","中文")).length,0);
  assert.deepEqual(await value("inbox"),[]);
  assert.equal(JSON.parse(await readFile(join(state,"config.json"),"utf8")).inbox,"local");
});

test("Pi 外部服务配置保留文件引用并隔离模型可读取的资料目录",async()=>{
  const dir=await mkdtemp(resolve(".minder-dev","providers-"));
  const documents=join(dir,"documents"), privateDir=join(dir,"home"), file=join(dir,"providers.json");
  await mkdir(documents);
  const provider="local-ollama", model="qwen3:4b";
  await writeFile(file,JSON.stringify({providers:{[provider]:{
    baseUrl:"http://127.0.0.1:11434/v1",api:"openai-completions",apiKey:"${OLLAMA_API_KEY}",
    models:[{id:model,name:model,compat:{supportsDeveloperRole:false}}]
  }}}),{mode:0o600});
  const command=(...args)=>run(process.execPath,[bin,...args],{env:{...process.env,MINDER_HOME:privateDir},cwd:documents});
  const init=(configFile)=>command("init","--root",documents,"--provider-file",configFile,"--provider",provider,"--model",model,"--no-verify");
  await init(file);
  const configPath=join(privateDir,"config.json");
  const config=JSON.parse(await readFile(configPath,"utf8"));
  assert.equal(config.providerFile,file);
  assert.deepEqual(Object.keys(config).sort(),["inbox","model","provider","providerFile","root","verified","version"]);
  assert.equal(JSON.parse((await command("doctor","--json")).stdout).tools.length,8);
  const visibleFile=join(documents,"providers.json");
  await link(file,visibleFile);
  await assert.rejects(command("doctor","--json"),/资料目录外/);
  await unlink(visibleFile);
  await copyFile(file,visibleFile);
  await assert.rejects(init(visibleFile),/资料目录外/);
  await writeFile(configPath,JSON.stringify({...config,providerFile:visibleFile}));
  await assert.rejects(command("doctor","--json"),/资料目录外/);
});
