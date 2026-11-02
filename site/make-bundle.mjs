// 生成一个体积最小的自包含 Worker：
// 站点文件 -> JSON -> gzip -> base64，嵌进一段很短的 Worker 样板里。
// 这样需要搬运到 Cloudflare 的字节数最少，且全是 ASCII。
//
// Worker 除了静态页，还负责两件事（DEC-020）：
//
//   1. `POST /api/e` —— 收匿名心跳（每台机器每天最多一次），写进 D1。
//   2. `scheduled()` —— 每天 UTC 10:42（Asia/Shanghai 18:42）跑一次，
//      汇总 D1 + 拉 npm 下载数，然后把结果推到 Bark。
//
// 为什么 API 路由插在 `new URL(rq.url)` 之后、405 判定之前：
//   - `POST` 会被原来的 GET/HEAD 门直接挡成 405；
//   - 免得为了一个 30 字节的心跳去解压 20 KB 的静态 payload；
//   - 在 `decodeURIComponent` 之前，恶意 `%` 序列不会把整个 Worker 打成 500。
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

// 注意：这段模板里**刻意不使用** `${...}` 与反引号，避免与外层模板串冲突。
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

// ---------- 匿名统计（D1） ----------
// 时区固定 +8：中国无夏令时，因此 (ms+8h) 的日历日就是 Asia/Shanghai 的日期。
// 客户端用同一算法，两端对日一致。
const TZ=8*3600e3;
const NOSTORE={"cache-control":"no-store","x-content-type-options":"nosniff"};
const MAX_BODY=2048;
const MAX_FIELD=32;
const UUIDV4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 插件标识（npm 包名形态）：小写字母数字 + - . _，最长 48。上报体里的 p 字段。
// 校验在服务端再做一次：客户端被改坏、或有人直接 POST 时，不能让它写进
// 一个无法归属的插件名下。
const PLUGIN_RE=/^[a-z0-9][a-z0-9._-]{0,47}$/;
// 兜底插件名：老客户端（升级前那批）还没带 'p' 字段。它们的上报全部来自
// dsh-decision-engine，所以按历史事实回填，而不是丢弃（丢掉的代价是那段
// 时间的 DAU 永远缺一块，且无法补回）。
const DEFAULT_PLUGIN="dsh-decision-engine";

function dayOf(ms){return new Date(ms+TZ).toISOString().slice(0,10)}
function dayStart(day){return Date.parse(day+"T00:00:00+08:00")}
function json(obj,status){return new Response(JSON.stringify(obj),{status:status||200,headers:Object.assign({"content-type":"application/json; charset=utf-8"},NOSTORE)})}
function clean(v,max){return typeof v==="string"?v.trim().slice(0,max||MAX_FIELD):""}
function intOr(v,dflt,max){const n=Number(v);if(!Number.isFinite(n)||n<0)return dflt;return Math.min(Math.trunc(n),max)}

// 心跳：校验 -> 立即回 202 -> ctx.waitUntil 里落库。
// 用 waitUntil 而不是 await，是因为响应已经发出，剩下的写入不该拖住请求；
// 而不用 waitUntil 的话，调用结束时会直接取消未完成的 D1 写入。
async function ingestEvent(rq,env,ctx){
  if(!env||!env.DB)return json({ok:false,err:"db-not-configured"},503);
  let text;
  try{text=await rq.text()}catch{return json({ok:false,err:"read-failed"},400)}
  if(text.length>MAX_BODY)return json({ok:false,err:"too-large"},413);
  let body;
  try{body=JSON.parse(text)}catch(e){return json({ok:false,err:"bad-json"},400)}
  if(body===null||typeof body!=="object")return json({ok:false,err:"bad-body"},400);
  if(body.v!==1)return json({ok:false,err:"bad-version"},400);
  // 插件维度：新客户端必须带合法的 p；老客户端没有这个字段时按历史事实
  // 回填 DEFAULT_PLUGIN（见常量注释）。带了但非法 —— 直接拒绝，绝不猜测。
  const hasPlugin=Object.prototype.hasOwnProperty.call(body,"p");
  const plugin=hasPlugin?String(body.p==null?"":body.p).trim().toLowerCase():DEFAULT_PLUGIN;
  if(!PLUGIN_RE.test(plugin))return json({ok:false,err:"bad-plugin"},400);
  const id=typeof body.id==="string"?body.id:"";
  if(!UUIDV4.test(id))return json({ok:false,err:"bad-id"},400);
  const kind=body.k==="install"?"install":(body.k==="heartbeat"?"heartbeat":"");
  if(kind==="")return json({ok:false,err:"bad-kind"},400);
  const ver=clean(body.ver)||"unknown";
  const os=clean(body.os);
  const arch=clean(body.arch);
  const host=clean(body.host);
  const decisions=intOr(body.d,0,100000);

  const now=Date.now();
  const day=dayOf(now);
  // 两个 upsert 合成一个 batch：一次往返、一个事务，也只算一次查询。
  // decisions 取 MAX 而不是累加：同一台机器同一天若真的重复上报（客户端状态
  // 文件被删），也不会把决策数算成两倍。
  const stmts=[
    env.DB.prepare("INSERT INTO installs (plugin,install_id,first_seen_ms,last_seen_ms,first_version,last_version,platform,arch,host_version) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(plugin,install_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,last_version=excluded.last_version,host_version=excluded.host_version,platform=excluded.platform,arch=excluded.arch")
      .bind(plugin,id,now,now,ver,ver,os,arch,host),
    env.DB.prepare("INSERT INTO daily_active (plugin,day,install_id,version,platform,decisions,updated_ms) VALUES (?,?,?,?,?,?,?) ON CONFLICT(plugin,day,install_id) DO UPDATE SET version=excluded.version,platform=excluded.platform,decisions=MAX(daily_active.decisions,excluded.decisions),updated_ms=excluded.updated_ms")
      .bind(plugin,day,id,ver,os,decisions,now)
  ];
  ctx.waitUntil(env.DB.batch(stmts).catch(e=>console.warn("telemetry-write-failed "+String(e&&e.message))));
  return json({ok:true,day:day,plugin:plugin},202);
}

// ---------- 每日推送 ----------
// 只推数值，不建展示页（DEC-020）。内容刻意很短：Bark 把标题与正文放在 URL
// 路径段里，太长会被截断。
const BARK_BASE="https://api.day.app";
const SEG_MAX=480;

function seg(v){const t=String(v||"").trim();const s=t.length>SEG_MAX?t.slice(0,SEG_MAX-3)+"...":t;return encodeURIComponent(s)}

async function barkPush(env,title,body){
  const key=(env&&typeof env.BARK_TOKEN==="string"?env.BARK_TOKEN:"").trim();
  if(key.length===0)return {ok:false,err:"no-token"};
  const url=BARK_BASE+"/"+encodeURIComponent(key)+"/"+seg(title)+"/"+seg(body);
  try{
    const r=await fetch(url,{method:"GET"});
    if(r.ok)return {ok:true};
    const detail=(await r.text().catch(()=>"" )).slice(0,120);
    return {ok:false,err:"http-"+r.status+":"+detail};
  }catch(e){return {ok:false,err:"network:"+String(e&&e.message)}}
}

// npm 下载数：官方公开 API，无需 token。
async function npmDownloads(plugin,day){
  try{
    // 按插件查各自的下载量：原来写死包名，加第二个插件时会把两个插件的
    // 下载数算成同一个。
    const r=await fetch("https://api.npmjs.org/downloads/point/"+day+"/"+encodeURIComponent(plugin));
    if(!r.ok)return null;
    const j=await r.json();
    const n=Number(j&&j.downloads);
    return Number.isFinite(n)&&n>=0?Math.trunc(n):null;
  }catch{return null}
}

function sumRows(res){let n=0;const rows=(res&&res.results)||[];for(const r of rows){n+=Number(r.n)||0}return n}
function one(res){const rows=(res&&res.results)||[];return rows.length>0?rows[0]:null}

async function runDigest(env,opts={}){
  if(!env||!env.DB)return { skipped:"no-db" };
  // 一个插件一条日报：所有查询都按 plugin 过滤，否则装了两个插件的用户
  // 会看到「混在一起的 DAU」，数字没有任何含义。
  const plugin=PLUGIN_RE.test(String(opts.plugin||""))?String(opts.plugin).toLowerCase():DEFAULT_PLUGIN;
  const now=Date.now();
  const today=dayOf(now);
  const yday=dayOf(now-86400000);
  const todayStart=dayStart(today);
  const ydayStart=dayStart(yday);
  const weekStart=dayStart(dayOf(now-6*86400000));
  const monthStart=dayStart(dayOf(now-29*86400000));

  // 去重：同一天成功推过就不再推（防止手工触发与 cron 撞车时刷两条）。
  // force 只给 /api/digest 的调试入口用：验证时需要能重复跑。
  const seen=one(await env.DB.prepare("SELECT ok FROM digest_log WHERE plugin=? AND day=?").bind(plugin,today).all());
  if(!opts.force&&seen&&Number(seen.ok)===1)return { skipped:"already-sent" };

  const qs=[
    env.DB.prepare("SELECT COUNT(*) AS n FROM daily_active WHERE plugin=? AND day=?").bind(plugin,yday),
    env.DB.prepare("SELECT COUNT(*) AS n FROM daily_active WHERE plugin=? AND day=?").bind(plugin,today),
    env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE plugin=? AND first_seen_ms>=? AND first_seen_ms<?").bind(plugin,ydayStart,todayStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE plugin=? AND first_seen_ms>=?").bind(plugin,todayStart),
    env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE plugin=?").bind(plugin),
    env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM daily_active WHERE plugin=? AND day>=?").bind(plugin,dayOf(weekStart+TZ)),
    env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM daily_active WHERE plugin=? AND day>=?").bind(plugin,dayOf(monthStart+TZ)),
    env.DB.prepare("SELECT COALESCE(SUM(decisions),0) AS n FROM daily_active WHERE plugin=? AND day=?").bind(plugin,yday),
    env.DB.prepare("SELECT version, COUNT(*) AS n FROM daily_active WHERE plugin=? AND day=? GROUP BY version ORDER BY n DESC LIMIT 3").bind(plugin,yday),
    env.DB.prepare("SELECT source, count FROM downloads WHERE plugin=? AND day=?").bind(plugin,yday),
    // 每个版本的「新装」按 first_version 分组——installs 表里只有
    // first_version / last_version 两列，没有裸 version（写裸 version 会
    // 直接 SQLITE_ERROR，整个 cron 静默失败）。
    env.DB.prepare("SELECT first_version AS version, COUNT(*) AS n FROM installs WHERE plugin=? AND first_seen_ms>=? AND first_seen_ms<? GROUP BY first_version ORDER BY n DESC LIMIT 3").bind(plugin,ydayStart,todayStart)
  ];
  const res=await env.DB.batch(qs);

  const dauY=sumRows(res[0]);
  const dauT=sumRows(res[1]);
  const newY=sumRows(res[2]);
  const newT=sumRows(res[3]);
  const total=sumRows(res[4]);
  const wau=sumRows(res[5]);
  const mau=sumRows(res[6]);
  const decisions=sumRows(res[7]);
  const verActive=(res[8]&&res[8].results)||[];
  const dlRows=(res[9]&&res[9].results)||[];
  const verNew=(res[10]&&res[10].results)||[];

  const npm=(dlRows.find(r=>r.source==="npm")||{}).count;
  const npmNow=await npmDownloads(plugin,yday);

  // 顺手把版本维度与下载数固化下来：以后要看趋势不用回扫明细。
  const writes=[
    env.DB.prepare("INSERT INTO downloads (plugin,day,source,count,updated_ms) VALUES (?,?,?,?,?) ON CONFLICT(plugin,day,source) DO UPDATE SET count=excluded.count,updated_ms=excluded.updated_ms")
      .bind(plugin,yday,"npm",npmNow===null?Number(npm)||0:npmNow,now)
  ];
  for(const r of verActive){
    writes.push(env.DB.prepare("INSERT INTO version_daily (plugin,day,version,installs,active_users) VALUES (?,?,?,?,?) ON CONFLICT(plugin,day,version) DO UPDATE SET installs=excluded.installs,active_users=excluded.active_users")
      .bind(plugin,yday,String(r.version||"unknown"),0,Number(r.n)||0));
  }
  for(const r of verNew){
    writes.push(env.DB.prepare("INSERT INTO version_daily (plugin,day,version,installs,active_users) VALUES (?,?,?,?,?) ON CONFLICT(plugin,day,version) DO UPDATE SET installs=excluded.installs")
      .bind(plugin,yday,String(r.version||"unknown"),Number(r.n)||0,0));
  }
  await env.DB.batch(writes).catch(e=>console.warn("digest-write-failed "+String(e&&e.message)));

  const dlTotal=npmNow===null?(Number(npm)||0):npmNow;
  const avgUser=dauY>0?Math.round(decisions/dauY*10)/10:0;
  const verTop=verActive.length>0
    ?verActive.map(r=>String(r.version||"unknown")+" ×"+Number(r.n||0)).join(" · ")
    :"(无)";
  const verNewTop=verNew.length>0
    ?verNew.map(r=>String(r.version||"unknown")+" +"+Number(r.n||0)).join(" · ")
    :"(无)";

  const title=plugin+" "+yday;
  const body=[
    "DAU "+dauY+"（今日至此刻 "+dauT+"）",
    "新增安装 "+newY+"（今日 "+newT+"） · 累计 "+total,
    "WAU "+wau+" · MAU "+mau,
    "npm 下载 "+dlTotal,
    "决策 "+(Number(decisions)||0)+" · 人均 "+avgUser,
    "版本 "+verTop,
    "新装版本 "+verNewTop
  ].join("\\n");

  const sent=await barkPush(env,title,body);
  await env.DB.prepare("INSERT INTO digest_log (plugin,day,sent_ms,ok,detail) VALUES (?,?,?,?,?) ON CONFLICT(plugin,day) DO UPDATE SET sent_ms=excluded.sent_ms,ok=excluded.ok,detail=excluded.detail")
    .bind(plugin,today,now,sent.ok?1:0,sent.ok?"":String(sent.err||"").slice(0,200))
    .run().catch(()=>{});
  if(!sent.ok)console.warn("bark-push-failed "+String(sent.err||""));
  return { ok:sent.ok, err:sent.err||"", day:yday, dau:dauY };
}

export default{fetch:async(rq,env,ctx)=>{
  const u=new URL(rq.url);
  // API 路由放在 405 门与静态解码之前（见文件头说明）。
  if(u.pathname==="/api/e"){
    if(rq.method!=="POST")return new Response("Method Not Allowed",{status:405,headers:{allow:"POST"}});
    return ingestEvent(rq,env,ctx);
  }
  // 手工触发一次日报：cron 只能在 UTC 到点才会跑，本地无法验证「推送到底
  // 发没发出去」，因此留一个有密钥保护的调试入口。
  //
  // 必须带 'x-digest-key' 且与 Worker Secret 'DIGEST_KEY' 一致；没配这个
  // secret 时整条路由不存在（404），不会意外成为公开接口。
  if(u.pathname==="/api/digest"){
    if(rq.method!=="POST")return new Response("Method Not Allowed",{status:405,headers:{allow:"POST"}});
    const expected=(env&&typeof env.DIGEST_KEY==="string"?env.DIGEST_KEY:"").trim();
    if(expected.length===0)return json({ok:false,err:"not-found"},404);
    const given=(rq.headers.get("x-digest-key")||"").trim();
    if(given!==expected)return json({ok:false,err:"forbidden"},403);
    const wantPlugin=String(u.searchParams.get("plugin")||"").trim().toLowerCase();
    const plugin=PLUGIN_RE.test(wantPlugin)?wantPlugin:DEFAULT_PLUGIN;
    const result=await runDigest(env,{force:true,plugin});
    return json({ok:true,plugin:plugin,result:result||null},200);
  }
  if(u.pathname.indexOf("/api/")===0){
    return json({ok:false,err:"not-found"},404);
  }
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
},scheduled:async(ev,env,ctx)=>{
  // 与 fetch 一样用 waitUntil：cron 的 CPU 预算很小（Free 只有 10ms），
  // 而 D1 与 fetch 都是 I/O，不该被 CPU 预算卡住。
  //
  // 插件清单从 D1 里读，而不是写死常量：新增插件只要它开始上报，第二天就会
  // 自动进日报，不必为了「加一条推送」去改 Worker 代码再发版。
  // 兜底：表为空时（还没人上报）只跑默认插件，保证首日也有日报。
  ctx.waitUntil((async()=>{
    let plugins=[];
    try{
      const r=await env.DB.prepare("SELECT DISTINCT plugin FROM installs").all();
      plugins=((r&&r.results)||[]).map(x=>String(x.plugin||"")).filter(p=>PLUGIN_RE.test(p));
    }catch(e){console.warn("plugin-list-failed "+String(e&&e.message))}
    if(plugins.length===0)plugins=[DEFAULT_PLUGIN];
    // 串行而不是 Promise.all：D1 每次调用只有有限的并发连接，
    // 而且并发推送更容易触发 Bark 的频率限制。
    for(const plugin of plugins){
      try{ await runDigest(env,{plugin}) }catch(e){ console.warn("digest-failed "+plugin+" "+String(e&&e.message)) }
    }
  })());
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
