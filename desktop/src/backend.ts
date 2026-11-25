import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  Firewall, MemoryStore, atomicJSON, configuration, home, installed, openSession,
  openSnapshot, setup, verify as verifyProvider, watchDirectory, type Config,
} from "@minder/cli/desktop";
import type { DesktopEvent, DesktopSettings, DesktopStatus, MinderDesktop, ProviderChoice, Rules } from "./contracts.js";

export interface DesktopHost {
  workspace(): Promise<string | null>;
  providerFile(): Promise<string | null>;
  confirm(title:string, message:string): Promise<boolean>;
  emit(event:DesktopEvent): void;
  report(message:string): void;
}

const emptyStatus: DesktopStatus = {configured:false,root:"",provider:"",model:"",verified:false,external:false,busy:false};
function text(value:unknown, title:string, limit=4096): string {
  if(typeof value!=="string" || !value.trim() || value.length>limit || value.includes("\0"))
    throw new Error(title+"无效");
  return value;
}
function object(value:unknown): Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("需要设置对象");
  return value as Record<string,unknown>;
}
function flag(value:unknown): boolean {
  if(typeof value!=="boolean") throw new Error("需要明确的选择");
  return value;
}
function number(value:unknown): number {
  if(typeof value!=="number" || !Number.isSafeInteger(value)) throw new Error("需要整数");
  return value;
}
function validateSettings(value:unknown): DesktopSettings {
  const input=object(value);
  return {root:text(input.root,"资料目录"),provider:text(input.provider,"服务名称",256),
    model:text(input.model,"模型名称",512),external:flag(input.external)};
}
function validateRules(value:unknown): Rules {
  const input=object(value);
  if(!Array.isArray(input.rules) || input.rules.length>1000) throw new Error("来源规则列表无效");
  return {
    quietStart:text(input.quietStart,"开始时间",5),quietEnd:text(input.quietEnd,"结束时间",5),
    timezone:text(input.timezone,"时区",128),cooldownMinutes:number(input.cooldownMinutes),digestMinutes:number(input.digestMinutes),
    rules:input.rules.map(item=>{
      const entry=object(item), score=number(entry.score);
      if(score<1 || score>5) throw new Error("优先级必须在 1 到 5 之间");
      return {sourceId:text(entry.sourceId,"来源"),score:score as 1|2|3|4|5,
        ...(entry.bypassQuiet===undefined ? {} : {bypassQuiet:flag(entry.bypassQuiet)})};
    })
  };
}

type Session = Awaited<ReturnType<typeof openSession>>;

export class DesktopBackend implements Omit<MinderDesktop,"onEvent"> {
  private selectedRoot?:string;
  private selectedFile?:string;
  private session?:Session;
  private sessionKey?:string;
  private task?:Promise<void>;
  private changing?:Promise<unknown>;
  private cancelled=false;
  private closed=false;
  private monitor?:{root:string; close:()=>Promise<void>};
  private monitoring:Promise<void>=Promise.resolve();
  constructor(private readonly host: DesktopHost) {}

  private demandIdle() {
    if(this.closed || this.changing || this.task) throw new Error("请等待当前操作结束");
  }
  private async change<T>(work:()=>Promise<T>): Promise<T> {
    this.demandIdle();
    const result=work();
    this.changing=result;
    try {return await result;}
    finally {this.changing=undefined;this.host.emit({type:"changed"});}
  }
  private statusFor(cfg:Config): DesktopStatus {
    return {configured:true,root:cfg.root,provider:cfg.provider,model:cfg.model,verified:cfg.verified,
      external:!!cfg.providerFile,busy:!!this.task};
  }
  async status():Promise<DesktopStatus> {
    if(!await installed()) return {...emptyStatus};
    const cfg=await configuration();
    if(!this.closed && this.monitor?.root!==cfg.root) {
      this.updateMonitor(cfg.root);
    }
    return this.statusFor(cfg);
  }
  async chooseWorkspace() {
    this.demandIdle();
    const selected=await this.host.workspace();
    if(selected) this.selectedRoot=await realpath(selected);
    return selected ? this.selectedRoot! : null;
  }
  async chooseProvider(): Promise<ProviderChoice|null> {
    this.demandIdle();
    const selected=await this.host.providerFile();
    if(!selected) return null;
    const path=await realpath(selected), metadata=await stat(path);
    if(!metadata.isFile() || metadata.nlink!==1 || metadata.size>4_000_000) throw new Error("请选择独立的模型配置 JSON 文件");
    let value:unknown;
    try {value=JSON.parse(await readFile(path,"utf8"));} catch {throw new Error("无法读取模型配置 JSON");}
    const providers=Object.entries(object(object(value).providers)).map(([id,raw])=>{
      const models=object(raw).models;
      if(!Array.isArray(models)) throw new Error("模型配置缺少 models 数组");
      return {id:text(id,"服务名称",256),models:models.map(model=>text(object(model).id,"模型名称",512))};
    }).filter(provider=>provider.models.length);
    if(!providers.length) throw new Error("配置中没有可选择的模型");
    this.selectedFile=path;
    return {name:basename(path),providers};
  }
  async configure(value:DesktopSettings) {
    return this.change(async()=>{
      const input=validateSettings(value);
      let prior:Config|undefined;
      if(await installed() && (input.root!==this.selectedRoot || (input.external && !this.selectedFile)))
        prior=await configuration();
      if(input.root!==this.selectedRoot && input.root!==prior?.root) throw new Error("请在系统对话框中选择资料目录");
      const file=input.external ? this.selectedFile ?? prior?.providerFile : undefined;
      if(input.external && !file) throw new Error("请在系统对话框中选择模型配置");
      if(!input.external && input.provider!=="ollama" && input.provider!=="deepseek") throw new Error("请选择已支持的模型服务");
      const cfg=await setup({...input,providerFile:file ?? null},false);
      await this.disposeSession();
      await atomicJSON("config.json",cfg);
      this.selectedRoot=cfg.root;this.selectedFile=cfg.providerFile;
      this.updateMonitor(cfg.root);
      return this.statusFor(cfg);
    });
  }
  async verify() {
    return this.change(async()=>{
      const cfg=await configuration();
      await verifyProvider(cfg);
      const current=await configuration();
      if(JSON.stringify(cfg)!==JSON.stringify(current)) throw new Error("配置已改变，请重新验证");
      cfg.verified=true;await atomicJSON("config.json",cfg);
      return this.statusFor(cfg);
    });
  }
  private async disposeSession() {
    const session=this.session;this.session=undefined;this.sessionKey=undefined;
    await session?.dispose();
  }
  private async getSession(cfg:Config) {
    const key=JSON.stringify([cfg.root,cfg.provider,cfg.model,cfg.providerFile]);
    if(this.session && this.sessionKey===key) return this.session;
    await this.disposeSession();
    const runtime=await openSession(cfg);
    try {
      const previous=runtime.session.extensionRunner.getUIContext();
      await runtime.session.bindExtensions({uiContext:{
        ...previous,confirm:(title,message)=>this.host.confirm(title,message)
      }});
      runtime.session.subscribe(event=>{
        if(event.type==="message_update" && event.assistantMessageEvent.type==="text_delta")
          this.host.emit({type:"delta",text:event.assistantMessageEvent.delta});
        if(event.type==="tool_execution_start") this.host.emit({type:"tool",phase:"start",name:event.toolName});
        if(event.type==="tool_execution_end") this.host.emit({type:"tool",phase:"end",name:event.toolName,failed:event.isError});
      });
      this.session=runtime;this.sessionKey=key;
      return runtime;
    } catch(error) {await runtime.dispose();throw error;}
  }
  async send(input:string) {
    this.demandIdle();
    const prompt=text(input,"消息",128_000);
    this.cancelled=false;
    this.task=(async()=>{
      const session=(await this.getSession(await configuration())).session;
      if(this.cancelled) return;
      await session.prompt(prompt,{expandPromptTemplates:false});
      const last=session.messages.findLast(entry=>entry.role==="assistant");
      if(!this.cancelled && (!last || last.stopReason==="error" || last.stopReason==="aborted"))
        throw new Error("模型未完成回答，请检查模型服务与授权");
    })();
    try {await this.task;}
    finally {this.task=undefined;this.host.emit({type:"changed"});}
  }
  async cancel() {
    if(!this.task) return;
    this.cancelled=true;
    await this.session?.session.abort();
    await this.task;
  }
  async newChat(){await this.change(()=>this.disposeSession());}

  private async withFiles<T>(work:(manager:Awaited<ReturnType<typeof openSnapshot>>)=>Promise<T>) {
    const cfg=await configuration();
    const manager=await openSnapshot({stateDir:join(home,"snapshot"),roots:[cfg.root]});
    try{return await work(manager);}finally{manager.close();}
  }
  files(){return this.withFiles(manager=>manager.list());}
  diff(id:string){return this.withFiles(manager=>manager.diff(text(id,"事务标识",256)));}
  undo(id:string){return this.change(()=>this.withFiles(manager=>manager.undo(text(id,"事务标识",256))));}
  private async withMemory<T>(work:(db:MemoryStore)=>T) {
    await configuration();
    const db=new MemoryStore(join(home,"memory"));
    try{return work(db);}finally{db.close();}
  }
  pending(){return this.withMemory(db=>{db.expire();return db.pendingSessions();});}
  memoryDiff(id:string){return this.withMemory(db=>db.diff(text(id,"会话标识")));}
  async review(id:string,key:string,accept:boolean) {
    const session=text(id,"会话标识"), item=text(key,"条目标识",256);
    await this.change(()=>this.withMemory(db=>{if(flag(accept)) db.commit(session,[item]);else db.discard(session,item);}));
  }
  private async withFirewall<T>(work:(db:Firewall)=>T) {
    await configuration();
    const db=new Firewall(join(home,"firewall"));
    try{return work(db);}finally{db.close();}
  }
  inbox(){return this.withFirewall(db=>{db.dispatchDue();return db.inbox();});}
  accept(id:string,revision:string){return this.change(()=>this.withFirewall(db=>db.accept(text(id,"提醒标识"),text(revision,"修订标识"))));}
  rules(){return this.withFirewall(db=>db.settings());}
  saveRules(value:Rules){return this.change(()=>this.withFirewall(db=>db.configure(validateRules(value))));}

  private updateMonitor(root:string) {
    this.monitoring=this.monitoring.then(async()=>{
      if(this.closed || this.monitor?.root===root) return;
      const previous=this.monitor;
      this.monitor=undefined;
      await previous?.close();
      const db=new Firewall(join(home,"firewall")), owner=randomUUID();
      let stop:(()=>Promise<void>)|undefined, closing=false;
      const tick=async()=>{
        if(closing) return;
        if(!db.lease(owner)) {if(stop) {await stop();stop=undefined;}return;}
        stop??=await watchDirectory(db,root,()=>this.host.report("目录监听失败，请检查资料目录"));
        if(db.dispatchDue().length) this.host.emit({type:"changed"});
      };
      let running:Promise<void>|undefined;
      const refresh=()=>{
        if(!running) running=tick().catch(()=>this.host.report("无法更新本机提醒")).finally(()=>{running=undefined;});
      };
      const timer=setInterval(refresh,15_000);timer.unref();
      this.monitor={root,close:async()=>{
        closing=true;clearInterval(timer);await running;
        try{await stop?.();}finally{db.release(owner);db.close();}
      }};
      refresh();
    }).catch(()=>this.host.report("无法启动资料目录监听"));
  }
  async close(){
    this.closed=true;
    try{await Promise.allSettled([this.cancel(),this.changing]);}finally{
      await this.disposeSession();await this.monitoring;await this.monitor?.close();this.monitor=undefined;
    }
  }
}
