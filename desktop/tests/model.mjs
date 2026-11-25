import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const execute = promisify(execFile);
const parent = fileURLToPath(new URL("../../.minder-dev/mac-model/",import.meta.url));
const { MINDER_TEST_PROVIDER_FILE: providerFile, MINDER_TEST_PROVIDER: provider,
  MINDER_TEST_MODEL: model } = process.env;
let stage = "安装包和模型设置";

async function run() {
  const [bundle] = process.argv.slice(2);
  assert.ok(bundle && providerFile && provider && model);
  const contents = resolve(bundle,"Contents");
  const executablePath = join(contents,"MacOS","Minder");
  const cli = join(contents,"Resources","app","node_modules","@minder","cli","lib","bin.js");
  await Promise.all([access(cli), access(executablePath), access(providerFile)]);
  await mkdir(parent,{recursive:true,mode:0o700});
  const area = await mkdtemp(join(parent,"run-"));
  const root = join(area,"work"), state = join(area,"state");
  const tmp = join(area,"temp"), profile = join(area,"profile");
  await Promise.all([root,tmp,profile].map(dir=>mkdir(dir,{mode:0o700})));
  const env = {...process.env, TMPDIR:tmp, TMP:tmp, TEMP:tmp, MINDER_HOME:state};
  delete env.ELECTRON_RUN_AS_NODE;
  const nonce = randomUUID(), original = randomUUID()+"\n", revised = randomUUID();
  const sample = join(root,"sample.txt");
  await writeFile(sample,original);
  let app;
  try {
    stage = "隔离配置";
    await execute(process.execPath,[cli,"init","--root",root,"--provider-file",await realpath(providerFile),
      "--provider",provider,"--model",model,"--no-verify"],{env,cwd:root});
    stage = "启动桌面窗口";
    app = await electron.launch({executablePath,args:["--user-data-dir="+profile],env,cwd:root,timeout:60_000});
    const page = await app.firstWindow();
    await page.waitForFunction(()=>!!window.minder);
    const status = await page.evaluate(()=>window.minder.status());
    assert.ok(status.configured && status.external && status.model===model);
    assert.ok(!("apiKey" in status) && !("providerFile" in status));
    stage = "模型验证";
    assert.equal((await page.evaluate(()=>window.minder.verify())).verified,true);
    // 会话挑战值只在第一轮出现，第二轮必须从同一份对话上下文取回。
    stage = "第一轮模型请求";
    const observed = await page.evaluate(async ({nonce,revised})=>{
      const events = [];
      const remove = window.minder.onEvent(event=>events.push(event));
      try {
        await window.minder.send([
          "Use the write tool to replace sample.txt with exactly one line and a final newline.",
          "The exact line is: "+revised,
          "Remember the following challenge token in this conversation only: "+nonce,
          "Do not write the token to disk. Reply with a brief confirmation after writing.",
        ].join("\n"));
        return {chunks:events.filter(e=>e.type==="delta" && e.text).length,
          write:events.some(e=>e.type==="tool" && e.phase==="end" && !e.failed && e.name==="write")};
      } finally { remove(); }
    },{nonce,revised});
    assert.ok(observed.chunks>0 && observed.write);
    assert.equal(await readFile(sample,"utf8"),revised+"\n");
    stage = "同一会话的第二轮请求";
    const retained = await page.evaluate(async ()=>{
      let response="";
      const remove=window.minder.onEvent(event=>{if(event.type==="delta") response+=event.text;});
      try {
        await window.minder.send("Without using any tools, return only the challenge token I gave you in my previous message.");
        return response;
      } finally {remove();}
    });
    assert.ok(retained.includes(nonce));
    stage = "文件差异和撤销";
    const undid = await page.evaluate(async()=>{
      const entry=(await window.minder.files()).find(item=>item.status==="committed");
      if(!entry) throw new Error("缺少文件事务");
      const diff=await window.minder.diff(entry.id);
      const undo=await window.minder.undo(entry.id);
      return {patch:diff.files[0].patch,status:undo.status};
    });
    assert.ok(undid.patch.includes(revised));
    assert.equal(undid.status,"undone");
    assert.equal(await readFile(sample,"utf8"),original);
    stage = "中止活动请求";
    const aborted = await page.evaluate(async ()=>{
      const request=window.minder.send("Write a long essay of at least 1000 words about the history of libraries.");
      const active=await window.minder.status();
      await window.minder.cancel();
      await request;
      const idle=await window.minder.status();
      await window.minder.newChat();
      return active.busy && !idle.busy;
    });
    assert.ok(aborted);
    console.log(JSON.stringify({provider,model,platform:process.platform,verified:true,
      streamedChunks:observed.chunks,multiTurn:true,managedWrite:true,fileDiff:true,undoByteIdentical:true,cancel:true}));
  } finally {
    try {await app?.close();} finally {await rm(area,{recursive:true,force:true});}
  }
}

run().catch(()=>{console.error("桌面真实模型验收失败，检查步骤["+stage+"]");process.exitCode=1;});
