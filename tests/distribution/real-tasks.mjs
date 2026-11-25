import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run=promisify(execFile), repo=fileURLToPath(new URL("../../",import.meta.url));
const [packageDir]=process.argv.slice(2);
const cli=resolve(packageDir??join(repo,"packages","cli"),"lib","bin.js");
const {MINDER_TEST_PROVIDER_FILE:file,MINDER_TEST_PROVIDER:provider,MINDER_TEST_MODEL:model}=process.env;
assert.ok(file && provider && model,"Supply the authorized model settings");
const parent=join(repo,".minder-dev","real-tasks");
await mkdir(parent,{recursive:true});
const work=await mkdtemp(join(parent,"run-")),state=join(work,"state"),root=join(work,"documents");
await mkdir(root);
const env={...process.env,MINDER_HOME:state};
const command=async(...args)=>(await run(process.execPath,[cli,...args],{cwd:root,env,timeout:180000,maxBuffer:1600000})).stdout;
const json=async(...args)=>JSON.parse(await command(...args));
const evidence={provider,model};
let step="初始化";
try {
  await json("init","--root",root,"--provider-file",await realpath(file),"--provider",provider,"--model",model,"--no-verify");
  const unknown="材料-"+randomUUID()+".md",title="论文提交 "+randomUUID().slice(0,8);
  await writeFile(join(root,unknown),"投稿资料\n");
  async function ask(text,expected) {
    const sessions=join(state,"sessions");
    await mkdir(sessions,{recursive:true});
    const before=new Set(await readdir(sessions));
    const answer=await command("ask",text);
    const created=(await readdir(sessions)).filter(p=>!before.has(p) && p.endsWith(".jsonl"));
    assert.equal(created.length,1);
    const entries=(await readFile(join(sessions,created[0]),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    const calls=entries.map(entry=>entry.message).filter(message=>message?.role==="toolResult" && !message.isError)
      .map(message=>message.toolName);
    for(const name of expected) assert.ok(calls.includes(name),name);
    return {answer,calls};
  }
  step="通过目录工具找到真实文件";
  const listing=await ask("请看看当前工作区有哪些文件，把所有文件名原样列给我。",["minder_list_files"]);
  assert.ok(listing.answer.includes(unknown));evidence.directoryListing=true;
  step="自然语言创建委托";
  const minute=Math.floor(Date.now()/60_000)*60_000;
  const time=new Date(minute-60_000).toISOString(), future=new Date(minute+72*3600_000).toISOString();
  await json("rules","quiet","00:00","00:00","UTC");
  const creation=await ask("请为我创建一项长期跟进的委托，标题为「"+title+"」，下一步是核对投稿附件。截止时间是 "+future+
    "。请把下次跟进时间登记为 "+time+"，我现在需要在收件箱里看到提醒。",["minder_task_create"]);
  const [task]=await json("tasks","list");assert.equal(task.title,title);assert.equal(task.status,"open");
  const cards=(await json("inbox")).flatMap(group=>group.events);
  assert.equal(cards.length,1);assert.equal(cards[0].externalId,task.id);
  evidence.created=creation.calls.includes("minder_task_create");evidence.inbox=true;
  step="跨会话查找和改期";
  await ask("把我之前保存的「"+title+"」下一步改为检查作者信息，跟进时间改到 "+future+"。",["minder_task_list","minder_task_update"]);
  const updated=await json("tasks","show",task.id);assert.ok(updated.revision>task.revision);
  assert.match(updated.nextStep,/作者/);assert.equal(updated.followUpAt,future);
  assert.deepEqual(await json("inbox"),[]);evidence.rescheduled=true;
  step="跨会话完成委托";
  await ask("请把之前登记的「"+title+"」标记为完成。",["minder_task_list","minder_task_complete"]);
  assert.equal((await json("tasks","show",task.id)).status,"completed");evidence.completed=true;
  evidence.version=JSON.parse(await readFile(resolve(cli,"../../package.json"),"utf8")).version;
  await writeFile(join(work,"evidence.json"),JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify(evidence));
} catch {
  console.error("真实委托验收未通过，当前步骤["+step+"]");
  process.exitCode=1;
}
