import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// 在真实传输之前检查请求体。认证头随原始请求直接交给提供方。
const send = globalThis.fetch;
const normalize = value => value.replaceAll("\\","/");
const privatePaths = [
  homedir(), process.cwd(), process.env.MINDER_HOME, process.env.MINDER_TEST_PROVIDER_FILE
].map(path => normalize(resolve(path)));

globalThis.fetch = async (input, options) => {
  const request = new Request(input,options);
  const credentials = [...request.headers.entries()]
    .filter(([key])=>/authorization|api[-_]?key|token|secret/i.test(key))
    .flatMap(([,value])=>[value,value.replace(/^(bearer|basic)\s+/i,"")])
    .filter(value=>value.length>6);
  const forbidden = [...privatePaths,...credentials];
  const allowed = value => !forbidden.some(item=>normalize(value).includes(item));
  const address = new URL(request.url);
  if (address.origin!==process.env.MINDER_TEST_ORIGIN || address.username || address.password || !allowed(decodeURIComponent(address.href))) {
    throw new Error("Model request URL failed the privacy check");
  }
  if (request.body) {
    if (!/application\/json/i.test(request.headers.get("content-type") ?? "")) {
      throw new Error("Expected a JSON model request");
    }
    const body = await request.clone().json();
    const inspect = value => {
      if (typeof value === "string" && !allowed(value)) throw new Error("Model request body failed the privacy check");
      if (value && typeof value === "object") for (const [key,entry] of Object.entries(value)) { inspect(key); inspect(entry); }
    };
    inspect(body);
    appendFileSync(process.env.MINDER_TEST_COUNTER,"1\n",{mode:0o600});
  }
  return send(request,{redirect:"error"});
};
