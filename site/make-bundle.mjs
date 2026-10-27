// 生成一个体积最小的自包含 Worker：
// 站点文件 -> JSON -> gzip -> base64，嵌进一段很短的 Worker 样板里。
// 这样需要搬运到 Cloudflare 的字节数最少，且全是 ASCII。
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const OUT = path.join(HERE, "worker");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const files = (await walk(DIST))
  .filter((f) => !f.split("/").some((seg) => seg.startsWith("."))) // 跳过 .DS_Store 等
  .sort();

// 目录访问要 308 到带尾斜杠的形式——从文件树自动推导，新增语言/项目不用手改。
const dirs = files
  .filter((f) => f.endsWith("index.html") && f !== "index.html")
  .map((f) => "/" + f.split("/").slice(0, -1).join("/"));
const payload = {};
for (const rel of files) {
  payload["/" + rel] = {
    t: MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
    b: (await readFile(path.join(DIST, rel))).toString("utf8"),
  };
}

const raw = Buffer.from(JSON.stringify(payload), "utf8");
const gz = gzipSync(raw, { level: 9 });
const b64 = gz.toString("base64");

const BOILER = `const B64="@@PAYLOAD@@";
let CACHE=null;
async function files(){
  if(CACHE)return CACHE;
  const bin=Uint8Array.from(atob(B64),c=>c.charCodeAt(0));
  const ds=new DecompressionStream("gzip");
  const out=new Response(new Blob([bin]).stream().pipeThrough(ds));
  CACHE=JSON.parse(await out.text());
  return CACHE;
}
const DIRS=@@DIRS@@;
const CSP="default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;object-src 'none';base-uri 'none';frame-ancestors 'none'";
// 把请求路径映射到 FILES 的键：/ -> /index.html，/x -> /x/index.html
function find(F,p){
  if(F[p])return p;
  const base=p.endsWith("/")?p:p+"/";
  const idx=base+"index.html";
  if(F[idx])return idx;
  return null;
}
export default{fetch:async(rq)=>{
  const u=new URL(rq.url);
  if(rq.method!=="GET"&&rq.method!=="HEAD")return new Response("Method Not Allowed",{status:405,headers:{allow:"GET, HEAD"}});
  let p=decodeURIComponent(u.pathname);
  if(DIRS.includes(p))return Response.redirect(new URL(p+"/"+u.search,u).href,308);
  const F=await files();
  let k=find(F,p);
  if(!k)return new Response("Not Found\\n",{status:404,headers:{"content-type":"text/plain; charset=utf-8"}});
  const f=F[k],et='"'+k+'"';
  if(rq.headers.get("if-none-match")===et)return new Response(null,{status:304,headers:{etag:et}});
  return new Response(f.b,{status:200,headers:{
    "content-type":f.t,etag:et,
    "cache-control":"public, max-age=300, must-revalidate",
    "x-content-type-options":"nosniff",
    "referrer-policy":"strict-origin-when-cross-origin",
    "content-security-policy":CSP}});
}};`;

const script = BOILER.replace("@@PAYLOAD@@", b64).replace("@@DIRS@@", JSON.stringify(dirs));

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "bundle.js"), script);
await writeFile(path.join(OUT, "payload.b64"), b64);
console.log(`dirs (308 redirect): ${JSON.stringify(dirs)}`);

console.log(`raw JSON      : ${(raw.length / 1024).toFixed(1)} KB`);
console.log(`gzip          : ${(gz.length / 1024).toFixed(1)} KB`);
console.log(`base64 payload: ${(b64.length / 1024).toFixed(1)} KB (${b64.length} chars)`);
console.log(`worker script : ${(script.length / 1024).toFixed(1)} KB`);
console.log(`files         : ${files.length} -> ${files.join(", ")}`);
