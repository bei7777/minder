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
  const runDir = await mkdtemp(join(parent,"run-"));
  const area = join(runDir,"data");
  await mkdir(area,{mode:0o700});
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
    page.setDefaultTimeout(90_000);
    const click=name=>page.getByRole("button",{name,exact:true}).click();
    const prompt=page.getByRole("textbox",{name:"任务"});
    const saved=async()=>{
      await click("保存设置");
      await prompt.waitFor();
      assert.ok(await prompt.evaluate(element=>document.activeElement===element));
    };
    const status = await page.evaluate(()=>window.minder.status());
    assert.ok(status.configured && status.external && status.model===model);
    assert.ok(!("apiKey" in status) && !("providerFile" in status));
    stage = "模型验证";
    await click("设置"); await click("验证模型连接");
    await page.getByText("工具调用已验证",{exact:true}).waitFor();
    await saved();
    assert.equal((await page.evaluate(()=>window.minder.status())).verified,true);
    // 会话挑战值只在第一轮出现，第二轮必须从同一份对话上下文取回。
    stage = "第一轮模型请求";
    await page.evaluate(()=>{
      window.modelResults={chunks:0,write:false,createdTasks:0};
      window.minder.onEvent(event=>{
        if(event.type==="delta" && event.text) window.modelResults.chunks++;
        if(event.type==="tool" && event.phase==="end" && !event.failed && event.name==="write") window.modelResults.write=true;
        if(event.type==="tool" && event.phase==="end" && !event.failed && event.name==="minder_task_create") window.modelResults.createdTasks++;
      });
    });
    await prompt.fill([
      "Use the write tool to replace sample.txt with exactly one line and a final newline.",
      "The exact line is: "+revised,
      "Remember this challenge token in our conversation only: "+nonce,
      "Do not write the token to disk. Reply with a Markdown heading '## Saved' and a brief confirmation.",
    ].join("\n"));
    await prompt.press("Enter");
    await page.getByRole("button",{name:"停止生成",exact:true}).waitFor();
    await page.getByRole("button",{name:"发送",exact:true}).waitFor();
    await page.locator(".message.assistant .markdown-body h2").first().waitFor();
    const observed=await page.evaluate(()=>window.modelResults);
    assert.ok(observed.chunks>0 && observed.write);
    assert.equal(await readFile(sample,"utf8"),revised+"\n");
    stage = "同一会话的第二轮请求";
    const followup="Without using any tools, return only the challenge token I gave you in my previous message.";
    await prompt.fill(followup); await click("设置"); await saved();
    assert.equal(await prompt.inputValue(),followup);
    assert.equal(await page.locator(".message.user").count(),1);
    await click("发送");
    await page.getByRole("button",{name:"停止生成",exact:true}).waitFor();
    await page.getByRole("button",{name:"发送",exact:true}).waitFor();
    const retained = await page.locator(".message.assistant").last().innerText();
    assert.ok(retained.includes(nonce));
    stage = "文件差异和撤销";
    await click("文件记录"); await page.locator(".addition").filter({hasText:revised}).first().waitFor();
    await click("撤销整项修改"); await page.getByRole("dialog").getByRole("button",{name:"撤销修改"}).click();
    await page.getByText("文件修改已撤销",{exact:true}).waitFor();
    assert.equal(await readFile(sample,"utf8"),original);
    stage = "中止活动请求";
    await click("对话"); await prompt.fill("Write a long essay of at least 1000 words about the history of libraries.");
    await click("发送");await click("停止生成");
    await page.getByRole("button",{name:"发送",exact:true}).waitFor();
    assert.equal((await page.evaluate(()=>window.minder.status())).busy,false);
    await click("新对话");await prompt.waitFor();
    stage="询问委托的跟进时间";
    const title="跟进图书预约 "+randomUUID().slice(0,8);
    async function sendTurn(text) {
      await prompt.fill(text);
      await click("发送");
      await page.getByRole("button",{name:"停止生成",exact:true}).waitFor();
      await page.getByRole("button",{name:"发送",exact:true}).waitFor();
    }
    await sendTurn("请帮我登记一项名为「"+title+"」的委托。请先问我希望何时跟进，等我回复具体时间后再登记。");
    assert.match(await page.locator(".message.assistant").last().innerText(),/何时|什么时候|时间|几点|哪天/);
    assert.deepEqual(await page.evaluate(()=>window.minder.tasks()),[]);
    stage="根据用户补充的时间登记原委托";
    const followUpAt=new Date(Math.floor(Date.now()/60_000)*60_000+7*86400000).toISOString();
    await sendTurn(followUpAt);
    const [task]=await page.evaluate(()=>window.minder.tasks());
    assert.equal(task.title,title);
    assert.equal(task.followUpAt,followUpAt);
    assert.equal(await page.evaluate(()=>window.modelResults.createdTasks),1);
    const result={provider,model,platform:process.platform,verified:true,
      streamedChunks:observed.chunks,multiTurn:true,managedWrite:true,fileDiff:true,undoByteIdentical:true,cancel:true,
      saveReturnsToChat:true,composerFocused:true,preservedDraft:true,preservedVerification:true,markdown:true,
      askedForFollowUp:true,createdAfterUserReply:true};
    await writeFile(join(runDir,"evidence.json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});
    console.log(JSON.stringify(result));
  } finally {
    try {await app?.close();} finally {await rm(area,{recursive:true,force:true});}
  }
}

run().catch(()=>{console.error("桌面真实模型验收失败，检查步骤["+stage+"]");process.exitCode=1;});
