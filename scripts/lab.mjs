import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../",import.meta.url));
const lab = join(root,".minder-dev","distribution");
const siblings = dirname(resolve(root));
const repositories = ["pi-minder","dsh-plugin-minder","minder"];
const registryPackages = ["@minder/*","pi-minder-*","dsh-plugin-minder-*"];
const require = createRequire(import.meta.url);
const json = path => JSON.parse(readFileSync(path,"utf8"));
const makeDir = path => { mkdirSync(path,{recursive:true}); return path; };
const save = (path,value) => writeFileSync(path,JSON.stringify(value,null,2) + "\n",{mode:0o600});
const [command,...input] = process.argv.slice(2);
const args = input.filter(value=>value !== "--");
const work = () => mkdtempSync(join(makeDir(join(lab,"runs")),"run-"));

function pnpmCommand() {
  const exe = process.env.npm_execpath;
  if (exe && /pnpm/i.test(exe)) return /\.[cm]?js$/i.test(exe) ? [process.execPath,exe] : [exe];
  if (process.platform !== "win32") return ["pnpm"];
  throw new Error("Run this command with pnpm run lab on Windows.");
}
function npmCommand() {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(dir,process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm");
    if (existsSync(candidate)) {
      const script = realpathSync(candidate);
      if (/npm-cli\.js$/.test(script)) return [process.execPath,script];
    }
  }
  if (process.platform !== "win32") return ["npm"];
  throw new Error("Install npm with Node.js and make it available on PATH.");
}
const pnpm = pnpmCommand();
const npm = npmCommand();
const temp = makeDir(join(lab,"temp"));
const commonEnv = {...process.env,TMPDIR:temp,TMP:temp,TEMP:temp};
for (const key of Object.keys(commonEnv)) {
  if (/^npm_config_(cache|overrides|verify.deps.before.run|_jsr.registry)$/i.test(key)) delete commonEnv[key];
}
commonEnv.NPM_CONFIG_CACHE = makeDir(join(lab,"npm-cache"));

function run(argv,{cwd=root,env=commonEnv,capture=false,interactive=false}={}) {
  return new Promise((ok,fail)=>{
    const child = spawn(argv[0],argv.slice(1),{cwd,env,stdio:[interactive?"inherit":"ignore",capture?"pipe":"inherit","inherit"]});
    let text = "";
    child.stdout?.setEncoding("utf8").on("data",data=>{ text+=data; });
    child.once("error",fail);
    child.once("exit",(code,signal)=>code===0 ? ok(text) : fail(new Error(`${basename(argv[0])} ${argv.slice(1).join(" ")} exited with ${code ?? signal}`)));
  });
}

async function integrity(file) {
  const hash = createHash("sha512");
  for await (const data of createReadStream(file)) hash.update(data);
  return "sha512-" + hash.digest("base64");
}

async function pack(names) {
  const runDir = work();
  const staging = makeDir(join(runDir,"tarballs"));
  const packages = [];
  for (const repo of repositories) {
    const repoDir = join(siblings,repo);
    const head = spawnSync("git",["rev-parse","HEAD"],{cwd:repoDir,encoding:"utf8"});
    const dirty = spawnSync("git",["status","--porcelain"],{cwd:repoDir,encoding:"utf8"});
    for (const entry of readdirSync(join(repoDir,"packages")).sort()) {
      const dir = join(repoDir,"packages",entry);
      const pkg = json(join(dir,"package.json"));
      if (pkg.private || names.length && !names.includes(pkg.name)) continue;
      await run([...pnpm,"run","build"],{cwd:dir});
      const file = join(staging,pkg.name.replace("@","").replace("/","-")+"-"+pkg.version+".tgz");
      const stdout = await run([...pnpm,"pack","--out",file,"--json"],{cwd:dir,capture:true});
      // pnpm 在生命周期命令输出之后写入 JSON；实际归档的文件列表由 npm 读取。
      assert.ok(stdout.length && existsSync(file),"pnpm pack did not produce an archive");
      const [packed] = JSON.parse(await run([...npm,"pack","--dry-run","--json","--ignore-scripts",file],{cwd:runDir,capture:true}));
      const contents = packed.files.map(f=>f.path);
      assert.ok(contents.includes("package.json") && contents.includes("LICENSE") && contents.some(f=>f.startsWith("lib/") && f.endsWith(".js")),pkg.name+" is missing runtime files or license");
      if (pkg.dsh) assert.ok(contents.includes("cordis.patch.yml"));
      if (pkg.name.startsWith("pi-minder-")) assert.ok(pkg.keywords.includes("pi-package"));
      packages.push({name:pkg.name,version:pkg.version,file,integrity:await integrity(file),repo,commit:head.status===0?head.stdout.trim():null,dirty:Boolean(dirty.stdout?.length)});
    }
  }
  assert.ok(packages.length && names.every(name=>packages.some(pkg=>pkg.name===name)),"Unknown package selection");
  const digest = createHash("sha256").update(JSON.stringify(packages.map(p=>[p.name,p.version,p.integrity]))).digest("hex");
  return {digest,packages,node:process.version,platform:process.platform};
}

async function registry(manifest,action) {
  const runDir = work();
  const dir = makeDir(join(lab,"registries",manifest.digest));
  const probe = createServer();
  await new Promise((ok,fail)=>probe.once("error",fail).listen(0,"127.0.0.1",ok));
  const port = probe.address().port;
  await new Promise((ok,fail)=>probe.close(err=>err?fail(err):ok()));
  const origin = "http://127.0.0.1:"+port;
  const config = join(runDir,"verdaccio.yaml");
  const uplink = new URL(process.env.MINDER_LAB_UPLINK || (await run([...pnpm,"config","get","registry"],{capture:true})).trim());
  assert.ok(uplink.protocol==="https:" && !uplink.username && !uplink.password,"Select an HTTPS package uplink without embedded credentials");
  const routes = Object.fromEntries(registryPackages.map(name=>[name,{access:"$all",publish:"$authenticated"}]));
  // YAML 同时接受 JSON；使用结构化配置避免从命令行拼接未转义路径。
  save(config,{
    storage:join(dir,"storage"),auth:{htpasswd:{file:join(dir,"htpasswd")}},
    web:{enable:false},log:{type:"stdout",format:"pretty",level:"warn"},
    uplinks:{npmjs:{url:uplink.href,timeout:"60s",max_fails:10,fail_timeout:"5s"}},
    packages:{...routes,"**":{access:"$all",proxy:"npmjs"}}
  });
  const tokenFile = join(dir,"client.json");
  const binary = join(dirname(require.resolve("verdaccio/package.json")),"bin","verdaccio");
  const child = spawn(process.execPath,[binary,"-c",config,"-l","127.0.0.1:"+port],{cwd:runDir,env:commonEnv,stdio:["ignore","inherit","inherit"]});
  const stopped = once(child,"exit");
  let quit = false;
  const stop = () => { if (!quit) { quit = true; child.kill(); } };
  process.once("exit",stop);
  try {
    let ready = false;
    for (let i=0;i<200;i++) {
      if (child.exitCode!==null || child.signalCode!==null) throw new Error("Local registry exited during startup");
      try { ready = (await fetch(origin+"/-/ping")).ok; }
      catch (err) { if (err.cause?.code!=="ECONNREFUSED") throw err; }
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready,"Local registry did not start");
    if (!existsSync(tokenFile)) {
      const name = "minder-"+randomUUID();
      const response = await fetch(origin+"/-/user/org.couchdb.user:"+name,{
        method:"PUT",headers:{"content-type":"application/json"},
        body:JSON.stringify({name,password:randomUUID(),email:name+"@localhost.invalid",type:"user",roles:[]})
      });
      assert.ok(response.ok,"Local registry sign-up failed: "+response.status);
      const {token} = await response.json();
      assert.equal(typeof token,"string");
      save(tokenFile,{token});
    }
    const npmrc = join(runDir,"npmrc");
    const publishConfig = join(runDir,"publish.npmrc");
    const baseConfig = `registry=${origin}/\naudit=false\nfund=false\n`;
    writeFileSync(npmrc,baseConfig,{mode:0o600});
    writeFileSync(publishConfig,baseConfig+`//127.0.0.1:${port}/:_authToken=${json(tokenFile).token}\n`,{mode:0o600});
    const env = {...commonEnv};
    for (const key of Object.keys(env)) {
      if (/^npm_config_(registry|userconfig|cache)$/i.test(key) || /^(npm_token|node_auth_token)$/i.test(key)) delete env[key];
    }
    Object.assign(env,{NPM_CONFIG_USERCONFIG:npmrc,NPM_CONFIG_REGISTRY:origin,NPM_CONFIG_CACHE:makeDir(join(lab,"npm-cache")),MINDER_TEST_REGISTRY:origin});
    return await action({origin,env,runDir,publishEnv:{...env,NPM_CONFIG_USERCONFIG:publishConfig}});
  } finally {
    stop();
    await stopped;
    process.off("exit",stop);
  }
}

async function publish(manifest,context) {
  for (const pkg of manifest.packages) {
    const {origin,publishEnv,runDir} = context;
    const endpoint = origin+"/"+pkg.name.replace("/","%2f");
    const metadata = await fetch(endpoint);
    if (metadata.status !== 404 && !metadata.ok) throw new Error("Local package lookup failed: "+metadata.status);
    const existing = metadata.ok ? (await metadata.json()).versions?.[pkg.version] : null;
    if (!existing) {
      await run([...npm,"publish",pkg.file,"--registry="+origin,"--access=public","--ignore-scripts"],{cwd:runDir,env:publishEnv});
    }
    const response = await fetch(endpoint);
    assert.ok(response.ok);
    const published = (await response.json()).versions[pkg.version];
    assert.equal(published.dist.integrity,pkg.integrity,pkg.name+" integrity mismatch");
    for (const spec of Object.values(published.dependencies || {})) assert.doesNotMatch(spec,/^(workspace:|link:|file:)/);
  }
}

async function install(names,{runDir,env},directory="consumer") {
  const cwd = makeDir(join(runDir,directory));
  save(join(cwd,"package.json"),{name:"minder-local-consumer",private:true,type:"module"});
  await run([...npm,"install","--ignore-scripts","--no-audit","--no-fund","--prefer-offline",...names],{cwd,env});
  return cwd;
}
function spec(manifest,name) {
  const pkg = manifest.packages.find(p=>p.name===name);
  assert.ok(pkg,"Run publish-local with the complete release set; missing "+name);
  return name+"@"+pkg.version;
}
const manifestPath = join(lab,"release.json");
const delivery = join(root,".minder-dev","delivery");
async function publishKit(manifest) {
  assert.equal(manifest.packages.length,10,"Pack all ten release packages before creating the kit.");
  const dependencies = {};
  const contents = [];
  makeDir(join(delivery,"tarballs"));
  for (const pkg of manifest.packages) {
    const file = "tarballs/"+pkg.name.replace("@","").replace("/","-")+".tgz";
    const dest = join(delivery,file);
    copyFileSync(pkg.file,dest);
    assert.equal(await integrity(dest),pkg.integrity);
    contents.push({...pkg,file});
    if (pkg.repo!=="dsh-plugin-minder") dependencies[pkg.name]="file:./"+file;
  }
  for (const name of ["INSTALL.md","verify.mjs"]) copyFileSync(join(root,"tests","distribution","kit",name),join(delivery,name));
  const lock = join(delivery,"package-lock.json");
  if (existsSync(lock)) unlinkSync(lock);
  save(join(delivery,"package.json"),{name:"minder-local-release",private:true,type:"module",scripts:{verify:"node verify.mjs",minder:"minder"},dependencies});
  save(join(delivery,"release.json"),{...manifest,packages:contents});
}
function retain(manifest) {
  const directory = makeDir(join(lab,"releases",manifest.digest));
  save(join(directory,"release.json"),manifest);
  console.log("Versioned release inventory:",join(directory,"release.json"));
}
if (command==="publish-local") {
  const manifest = await pack(args);
  await registry(manifest,ctx=>publish(manifest,ctx));
  save(manifestPath,manifest);
  retain(manifest);
  if (manifest.packages.length===10) await publishKit(manifest);
  console.log("Local release inventory:",manifestPath);
} else if (command==="kit") {
  const manifest = json(manifestPath);
  retain(manifest);
  await publishKit(manifest);
  console.log(delivery);
} else if (command==="test-kit") {
  const runDir = work();
  const cwd = join(runDir,"portable");
  cpSync(delivery,cwd,{recursive:true,filter:path=>basename(path)!=="node_modules" && basename(path)!=="package-lock.json"});
  await run([process.execPath,join(cwd,"verify.mjs")],{cwd});
  const registry = process.env.MINDER_LAB_UPLINK || (await run([...pnpm,"config","get","registry"],{capture:true})).trim();
  assert.equal(new URL(registry).protocol,"https:");
  await run([...npm,"install","--registry="+registry,"--prefer-offline","--ignore-scripts","--no-audit","--no-fund"],{cwd});
  const help = await run([...npm,"exec","--offline","--","minder","--help"],{cwd,capture:true});
  assert.match(help,/Minder/);
  const lock = json(join(cwd,"package-lock.json"));
  for (const pkg of json(join(cwd,"release.json")).packages.filter(p=>p.repo!=="dsh-plugin-minder")) {
    const installed = lock.packages["node_modules/"+pkg.name];
    assert.ok(installed.resolved.startsWith("file:"));
    assert.equal(installed.integrity,pkg.integrity);
  }
  const lockedDir = join(runDir,"locked-copy");
  cpSync(delivery,lockedDir,{recursive:true,filter:path=>basename(path)!=="node_modules" && basename(path)!=="package-lock.json"});
  copyFileSync(join(cwd,"package-lock.json"),join(lockedDir,"package-lock.json"));
  await run([...npm,"ci","--registry="+registry,"--prefer-offline","--ignore-scripts","--no-audit","--no-fund"],{cwd:lockedDir});
  const lockedHelp = await run([...npm,"exec","--offline","--","minder","--help"],{cwd:lockedDir,capture:true});
  assert.match(lockedHelp,/Minder/);
  copyFileSync(join(cwd,"package-lock.json"),join(delivery,"package-lock.json"));
  console.log("Verified standalone npm installation:",delivery);
} else if (["run","test-install","test-hosts","test-init","test-upgrade","demo","verify-release"].includes(command)) {
  const manifest = json(manifestPath);
  await registry(manifest,async ctx=>{
    const {env,runDir} = ctx;
    if (command==="test-hosts") {
      const packages = manifest.packages.filter(p=>p.repo==="pi-minder").map(p=>spec(manifest,p.name));
      const cwd = await install([...packages,"@earendil-works/pi-coding-agent@1.6.0"],ctx,"pi");
      const pi = join(siblings,"pi-minder");
      const piEnv = {...env,MINDER_PI_INSTALL_ROOT:cwd};
      await run([process.execPath,"--test","tests/pi-host/host.test.mjs"],{cwd:pi,env:piEnv});
      await run([process.execPath,"tests/pi-host/independent.mjs"],{cwd:pi,env:piEnv});
      await run([...pnpm,"run","test:installed"],{cwd:join(siblings,"dsh-plugin-minder"),env});
      return;
    }
    const cli = spec(manifest,"@minder/cli");
    let previous;
    if (command==="test-upgrade") {
      assert.ok(args[0],"Supply a previous release.json or CLI tarball");
      if (args[0].endsWith(".json")) {
        const historical = json(resolve(args[0]));
        assert.ok(historical.packages.every(p=>registryPackages.some(pattern=>p.name.startsWith(pattern.slice(0,-1)))),"Unexpected historical package");
        await publish(historical,ctx);
        previous = spec(historical,"@minder/cli");
      } else previous = resolve(args[0]);
    }
    const cwd = await install([previous ?? cli],ctx);
    const main = join(cwd,"node_modules","@minder","cli","lib","bin.js");
    const sessionDir = command==="run" ? makeDir(join(lab,"user")) : runDir;
    const home = makeDir(join(sessionDir,"home")), data = makeDir(join(sessionDir,"documents"));
    const isolated = {...env,MINDER_HOME:home};
    if (command==="run") return run([process.execPath,main,...args],{cwd:data,env:isolated,interactive:true});
    if (command==="demo") assert.equal(args[0],"record","Use demo record");
    const runner = fileURLToPath(new URL("../tests/distribution/consumer.mjs",import.meta.url));
    const check = mode=>run([process.execPath,runner,mode,cwd,data,home,manifestPath],{cwd,env:isolated});
    if (command==="test-install" || command==="verify-release") {
      const help = await run([...npm,"exec","--offline","--","minder","--help"],{cwd,env:isolated,capture:true});
      assert.match(help,/Minder/);
    }
    if (command==="test-upgrade") {
      await check("prepare-upgrade");
      const old = json(join(cwd,"node_modules","@minder","cli","package.json")).version;
      const wanted = manifest.packages.find(p=>p.name==="@minder/cli").version;
      assert.notEqual(old,wanted,"Identical versions cannot verify an upgrade.");
      await run([...npm,"install","--ignore-scripts","--prefer-offline",cli],{cwd,env});
      await check("verify-upgrade");
    } else if (command==="verify-release") {
      await check("test-install");
      await check("test-init");
      await check("demo");
    } else await check(command);
    console.log("Local test evidence:",runDir);
  });
} else {
  console.log("pnpm lab publish-local [package names] | kit | test-kit | verify-release | test-install | test-hosts | test-init | test-upgrade <older release.json or cli.tgz> | run [CLI arguments] | demo record");
  if (command && command!=="--help") process.exitCode=2;
}
