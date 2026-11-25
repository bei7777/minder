#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { confirm, input, select } from "@inquirer/prompts";
import { openSnapshot } from "@minder/core-snapshot";
import { MemoryStore } from "@minder/core-memory";
import { Firewall, type Score } from "@minder/core-firewall";
import { atomicJSON, configuration, home, installed, setup, type Config } from "./config.js";
import { chat, openSession, verify } from "./session.js";
import { watch } from "./watch.js";

const help = `Minder · 个人助手

minder                        终端工作台
minder init                   配置模型、资料目录并验证工具调用
  --root DIR --provider ollama|deepseek --model ID [--no-verify]
minder chat | ask TEXT        打开会话或提交一条请求
minder files [ID] | undo ID   查看文件差异、撤销事务
minder memory pending | search TEXT | diff SESSION | commit SESSION [KEY] | discard SESSION [KEY] | revert ID | history
minder inbox | accept ID REV  查看行动卡，接受草稿并记录回执
minder rules [quiet START END ZONE | source SOURCE SCORE]
minder watch [--once] [--feed URL ...] [--score-model OLLAMA_MODEL]
minder doctor [--json] | verify

MINDER_HOME 指定私有数据目录。DEEPSEEK_API_KEY 可由环境传入。`;
const safe=(s:string)=>stripVTControlCharacters(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,"");
function output(value:unknown) {
  console.log(typeof value==="string"?safe(value):JSON.stringify(value,null,2));
}
function required(value:string|undefined,name:string) {
  if(!value?.trim()) throw new Error("需要参数 "+name);
  return value;
}
async function files(config:Config,id?:string,undo=false) {
  const manager=await openSnapshot({stateDir:join(home,"snapshot"),roots:[config.root]});
  try {
    if(undo) return await manager.undo(required(id,"事务 ID"));
    return id ? await manager.diff(id) : await manager.list();
  } finally { manager.close(); }
}
async function workbench(config:Config) {
  for(;;) {
    const action=await select({message:"Minder",choices:[
      {value:"chat",name:"对话"},{value:"files",name:"文件差异与撤销"},{value:"memory",name:"审阅记忆"},
      {value:"inbox",name:"行动收件箱"},{value:"rules",name:"提醒规则"},{value:"quit",name:"退出"}
    ]});
    if(action==="quit") return;
    if(action==="chat") { await chat(config); continue; }
    if(action==="files") {
      const store=await openSnapshot({stateDir:join(home,"snapshot"),roots:[config.root]});
      try {
        const rows=await store.list();
        if(!rows.length) { output("尚无文件事务"); continue; }
        const id=await select({message:"选择事务",choices:rows.map(r=>({name:safe(r.label)+" · "+r.status+" · "+r.id,value:r.id}))});
        const diff=await store.diff(id);
        for(const file of diff.files) output(file.patch || file.kind+" "+file.path);
        if(diff.status==="committed" && await confirm({message:"撤销这次文件修改？",default:false})) output(await store.undo(id));
      } finally { store.close(); }
      continue;
    }
    if(action==="memory") {
      const db=new MemoryStore(join(home,"memory"));
      try {
        const sessions=db.pendingSessions();
        if(!sessions.length) { output("没有待审阅的记忆"); continue; }
        const sessionId=await select({message:"选择待审阅会话",choices:sessions.map(s=>({
          name:safe(s.id)+" · "+s.count+" 项",value:s.id
        }))});
        const changes=db.diff(sessionId);
        const keys=[...new Set(changes.map(c=>c.key))];
        const key=await select({message:"选择记忆条目",choices:keys.map(value=>({value,name:safe(value)}))});
        for(const change of changes.filter(c=>c.key===key)) {
          output(change.path+"\n\n原文\n"+(change.before ?? "（新增）")+"\n\n提议\n"+(change.after ?? "（归档）"));
        }
        const review=await select({message:"处理提议",choices:["保留待审","接受修改","拒绝修改"]});
        if(review==="接受修改") output(db.commit(sessionId,[key]));
        if(review==="拒绝修改") output(db.discard(sessionId,key));
      } finally { db.close(); }
      continue;
    }
    const db=new Firewall(join(home,"firewall"));
    try {
      if(action==="rules") {
        output(db.settings());
        const sourceId=await input({message:"来源标识（订阅 URL 或 dir:绝对路径）"});
        const score=await select<Score>({message:"优先级",choices:[1,2,3,4,5].map(n=>({value:n as Score,name:String(n)}))});
        output(db.configure({rules:[...db.settings().rules.filter(r=>r.sourceId!==sourceId),{sourceId,score}]}));
      } else {
        db.dispatchDue();
        const groups=db.inbox();
        if(!groups.length) { output("目前没有需要处理的提醒"); continue; }
        const group=await select({message:"选择提醒",choices:groups.map(g=>({value:g,name:safe(g.title)+" · "+g.events.length}))});
        const item=group.events.length===1?group.events[0]:await select({message:"选择汇总事项",choices:group.events.map(e=>({name:safe(e.title),value:e}))});
        output(item.title+"\n"+item.summary);
        if(await confirm({message:safe(item.action?.label ?? "接受本地草稿")+"？",default:false})) output(db.accept(item.id,item.revision));
      }
    } finally { db.close(); }
  }
}
async function main() {
  const {positionals:args,values}=parseArgs({allowPositionals:true,options:{
    help:{type:"boolean",short:"h"},json:{type:"boolean"},root:{type:"string"},model:{type:"string"},
    provider:{type:"string"},"no-verify":{type:"boolean"},once:{type:"boolean"},feed:{type:"string",multiple:true},
    "score-model":{type:"string"}
  }});
  const command=args[0];
  const tty=Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if(values.help || command==="help" || (!command && !tty)) { output(help); return; }
  if(command==="init" || (!command && !await installed())) {
    const cfg=await setup(values,tty);
    if(!values["no-verify"]) {await verify(cfg); cfg.verified=true;}
    await atomicJSON("config.json",cfg);
    output({home,...cfg});
    if(command==="init") return;
  }
  const cfg=await configuration();
  switch(command) {
    case undefined: return workbench(cfg);
    case "chat": return chat(cfg);
    case "ask": return chat(cfg,required(args.slice(1).join(" "),"请求"));
    case "verify":
      await verify(cfg); await atomicJSON("config.json",{...cfg,verified:true}); output("模型工具调用已验证"); return;
    case "doctor": {
      const host=await openSession(cfg);
      try {
        await host.session.bindExtensions({});
        output({version:"0.1.0",node:process.version,home,root:cfg.root,model:cfg.model,
          verified:cfg.verified,tools:host.session.getActiveToolNames(),diagnostics:host.diagnostics});
      } finally { await host.dispose(); }
      return;
    }
    case "files": output(await files(cfg,args[1])); return;
    case "undo": output(await files(cfg,args[1],true)); return;
    case "watch": return watch(cfg,values.feed ?? [],Boolean(values.once),values["score-model"]);
    case "memory": {
      const db=new MemoryStore(join(home,"memory"));
      try {
        switch(args[1]) {
          case "history": output(db.history()); break;
          case "diff": output(db.diff(required(args[2],"会话标识"))); break;
          case "pending": output(db.pendingSessions()); break;
          case "commit": output(db.commit(required(args[2],"会话标识"),args[3]?[args[3]]:undefined)); break;
          case "discard": output(db.discard(required(args[2],"会话标识"),args[3])); break;
          case "revert": output(db.revert(required(args[2],"修订标识"))); break;
          case "search": output(db.search(required(args.slice(2).join(" "),"检索词"))); break;
          default: throw new Error("未知的记忆命令");
        }
      } finally { db.close(); }
      return;
    }
    case "rules": case "inbox": case "accept": {
      const db=new Firewall(join(home,"firewall"));
      try {
        if(command==="inbox") {db.dispatchDue();output(db.inbox());}
        else if(command==="accept") output(db.accept(required(args[1],"卡片标识"),required(args[2],"修订标识")));
        else if(args[1]==="quiet") output(db.configure({quietStart:required(args[2],"开始时间"),quietEnd:required(args[3],"结束时间"),timezone:required(args[4],"时区")}));
        else if(args[1]==="source") {
          const sourceId=required(args[2],"来源");
          output(db.configure({rules:[...db.settings().rules.filter(r=>r.sourceId!==sourceId),{sourceId,score:Number(args[3]) as Score}]}));
        } else if(args[1]) throw new Error("未知的规则命令");
        else output(db.settings());
      } finally { db.close(); }
      return;
    }
    default: throw new Error("未知命令，请运行 minder --help");
  }
}
main().catch(error=>{console.error(safe(error instanceof Error?error.message:String(error)));process.exitCode=1;});
