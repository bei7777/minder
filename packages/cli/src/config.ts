import { input, password, select } from "@inquirer/prompts";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const home = resolve(process.env.MINDER_HOME || join(homedir(), ".minder"));
export type Config = { version: 1; root: string; provider: "ollama" | "deepseek"; model: string; inbox: "local"; verified: boolean };
export function inside(parent: string, child: string) {
  const path = relative(parent,child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(".."+sep);
}
export async function atomicJSON(name: string, value: unknown) {
  await mkdir(home,{mode:0o700,recursive:true});
  const tmp = join(home, name+"."+randomUUID());
  await writeFile(tmp,JSON.stringify(value,null,2)+"\n",{mode:0o600,flag:"wx",flush:true});
  await rename(tmp,join(home,name));
}
export async function configuration(): Promise<Config> {
  const config = JSON.parse(await readFile(join(home,"config.json"),"utf8"));
  if (config.version !== 1 || !["ollama","deepseek"].includes(config.provider) || !config.model?.trim()
      || typeof config.root !== "string" || !isAbsolute(config.root)) throw new Error("Minder 配置无效");
  return config;
}
export async function installed(): Promise<boolean> {
  const files = await readdir(home).catch(error => {
    if (error.code === "ENOENT") return [] as string[]; throw error;
  });
  return files.includes("config.json");
}
export async function setup(options: {root?:string; provider?:string; model?:string}, tty: boolean): Promise<Config> {
  await mkdir(home,{mode:0o700,recursive:true});
  const chosenRoot = options.root ?? (tty ? await input({message:"允许助手访问哪个资料目录？",default:process.cwd()}) : "");
  if (!chosenRoot) throw new Error("非交互初始化需要 --root、--provider 和 --model");
  const root = await realpath(chosenRoot);
  const state = await realpath(home);
  if (!(await stat(root)).isDirectory() || inside(root,state) || inside(state,root))
    throw new Error("请选择与 Minder 数据目录分开的资料目录");
  let local: string[] = [];
  if (tty && (!options.provider || options.provider === "ollama")) {
    const response = await fetch("http://127.0.0.1:11434/api/tags",{signal:AbortSignal.timeout(1500)}).catch(()=>undefined);
    if (response?.ok) {
      const body = await response.json() as {models:{name:string}[]};
      local = body.models.map(entry=>entry.name);
    }
  }
  const provider = options.provider ?? (tty ? await select({message:"选择模型服务", choices:[
    {name:"本机 Ollama"+(local.length ? " · "+local.length+" 个模型" : ""),value:"ollama"},
    {name:"DeepSeek API",value:"deepseek"}
  ]}) : "");
  if (provider !== "ollama" && provider !== "deepseek") throw new Error("模型服务支持 ollama 或 deepseek");
  const model = options.model ?? (tty ? provider === "ollama" && local.length
    ? await select({message:"选择模型",choices:local})
    : await input({message:"模型标识",default:provider==="deepseek"?"deepseek-chat":undefined}) : "");
  if (!model || !model.trim()) throw new Error("请输入 --model 模型标识");
  if (provider === "deepseek" && tty && !process.env.DEEPSEEK_API_KEY) {
    const key = await password({message:"DeepSeek API Key（保存于 Minder 私有 credentials.json）",mask:"*"});
    if (!key.trim()) throw new Error("密钥为空");
    await atomicJSON("credentials.json",{deepseek:key.trim()});
  }
  return {version:1,root,provider,model:model.trim(),verified:false,inbox:"local"};
}
export async function apiKey(config: Config): Promise<string> {
  if(config.provider==="ollama") return "ollama";
  if(process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const path = join(home,"credentials.json");
  const raw = await readFile(path,"utf8").catch(error=>{
    if(error.code==="ENOENT") throw new Error("需要设置 DEEPSEEK_API_KEY 或运行 minder init");
    throw error;
  });
  const key = JSON.parse(raw).deepseek;
  if(typeof key!=="string" || !key.trim()) throw new Error("未找到有效 DeepSeek 密钥");
  return key;
}
