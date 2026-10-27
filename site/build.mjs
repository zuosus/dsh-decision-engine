// 把站点源文件渲染成 dist/ 下的静态文件。运行：node site/build.mjs
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nav, footer, codeBlock, table, ICON, esc } from "./lib/partials.mjs";
import { indexBodyEn, pluginBodyEn } from "./lib/content-en.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const VERSION = "0.7.1";
const ORIGIN = "https://dsh.zuos.us";

// 两个语言的顶部导航。链接都写绝对路径，子目录页也能正确跳转。
function navLinksFor(locale) {
  const prefix = locale === "zh" ? "" : "/en";
  const L = locale === "zh";
  return [
    { href: `${prefix}/dsh-decision-engine/#points`, label: L ? "决策点" : "Decision points", opt: true },
    { href: `${prefix}/dsh-decision-engine/#providers`, label: "Provider", opt: true },
    { href: `${prefix}/dsh-decision-engine/#verify`, label: L ? "验证" : "Verification", opt: true },
    { href: "https://github.com/zuosus/dsh-decision-engine", label: "GitHub" },
  ];
}

/**
 * @param opts
 *   lang     <html lang>
 *   self     本页路径（canonical 用）
 *   alt      另一语言版本 { path, label }，渲染成导航语言按钮 + hreflang
 */
function page(title, description, body, { lang = "zh-CN", self = "/", alt = null } = {}) {
  const locale = lang.startsWith("zh") ? "zh" : "en";
  const canonical = ORIGIN + self;
  const altHref = alt ? ORIGIN + alt.path : null;
  const hreflang = alt
    ? `<link rel="alternate" hreflang="${locale === "zh" ? "en" : "zh-CN"}" href="${altHref}">
<link rel="alternate" hreflang="${lang}" href="${canonical}">
<link rel="alternate" hreflang="x-default" href="${canonical}">`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
${hreflang}
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f7fa">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0e14">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css">
<script src="/assets/theme.js"></script>
</head>
<body>
${nav({
    brand: "dsh.zuos.us",
    links: navLinksFor(locale),
    i18n: alt ? { href: alt.path, label: alt.label, hreflang: locale === "zh" ? "en" : "zh-CN" } : null,
    themeAria: locale === "zh" ? "切换主题" : "Toggle theme",
  })}
<main>
${body}
</main>
${footer()}
<script src="/assets/app.js" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * 首页：项目列表
 * ------------------------------------------------------------------ */

const indexBody = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness 插件</span>
  <h1>给 <span class="grad">DeepSeek Harness</span><br>加一层便宜的判断</h1>
  <p class="lede">
    dsh.zuos.us 是 <strong>DeepSeek Harness（DSH）</strong> 插件项目的主页。
    这里收录的每一个插件都遵循同一条原则：<strong>用一次很小的模型调用，
    去替代或阻止一次很大的开销</strong>——并且默认只观察，不打断你干活。
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="/dsh-decision-engine/">查看 dsh-decision-engine →</a>
    <a class="btn" href="https://github.com/zuosus/dsh-decision-engine">源码</a>
  </div>
</div>

<div class="wrap">
  <hr class="rule">
</div>

<section class="wrap">
  <h2>项目</h2>
  <p class="sub">目前收录 1 个插件。</p>

  <div class="grid">
    <a class="project" href="/dsh-decision-engine/">
      <div class="project-head">
        ${ICON}
        <div>
          <h3>dsh-decision-engine</h3>
        </div>
        <div class="nav-spacer"></div>
        <span class="ver">v${VERSION}</span>
      </div>
      <p>
        给 DSH 的 System-1 决策守卫：在每次工具调用前问模型四个问题
        （风险、可逆性、任务相关性、注入嫌疑），据此放行、询问或拦截。
        八个决策点（工具授权、模型路由、子任务分派、上下文压缩、轮次延续、
        检索必要性、技能选择、思维链翻译）全部已实装，逐个可切换。
      </p>
      <div class="toc">
        <span class="badge green">默认 shadow，不打断</span>
        <span class="badge blue">任意 system-one API</span>
        <span class="badge gray">MIT</span>
      </div>
    </a>
  </div>
</section>

<section class="wrap">
  <h2>共同的设计约定</h2>
  <p class="sub">这里的插件都遵守下面几条，也是它们能被放心常驻的原因。</p>
  <div class="grid grid-3">
    <div class="card">
      <span class="kicker">fail-open</span>
      <h4>不确定就放行</h4>
      <p>超时、网络错误、鉴权失败、返回结构异常——一律退回原生行为，并记一条遥测。守卫自身故障永远不会卡住工具调用。</p>
    </div>
    <div class="card">
      <span class="kicker">shadow first</span>
      <h4>先观察，再生效</h4>
      <p>每个决策点都有 关闭 / 观察 / 生效 三态。新点默认先跑「观察」，确认判断与人工一致后再切「生效」。</p>
    </div>
    <div class="card">
      <span class="kicker">cheap by design</span>
      <h4>省的是更大的开销</h4>
      <p>只在「替代更贵的调用」或「阻止更大的开销」处介入，绝不为了「多一道检查」而介入。</p>
    </div>
  </div>
</section>
`;

/* ------------------------------------------------------------------ *
 * 插件页
 * ------------------------------------------------------------------ */

const pointsTable = table(
  ["#", "决策点", "挂载位置", "触发闸", "省什么"],
  [
    [
      "1",
      "<strong>工具授权</strong>",
      "<code>tools/pre-execute</code>",
      "只读工具 / auto 预设 / 排除名单直接放行",
      "替代 auto-review：每次约省 60k token",
    ],
    [
      "2",
      "<strong>模型路由</strong>",
      "<code>agent/request</code>",
      "每轮仅前 N 步 + 路由未变不问 + 新用户输入不问",
      "主通道约省 20–40% token",
    ],
    [
      "3",
      "<strong>子任务分派</strong>",
      "<code>agent/pre-step</code>",
      "仅每轮第一步且带新用户输入",
      "少开一个 subagent = 省一整个上下文",
    ],
    [
      "4",
      "<strong>上下文压缩</strong>",
      "<code>agent/pre-step</code> → <code>ctx.compaction</code>",
      "仅实测 token 达触发线 ×70%",
      "省掉一次摘要调用",
    ],
    [
      "5",
      "<strong>轮次延续</strong>",
      "<code>agent/turn-stopping</code>",
      "同一轮最多续一次",
      "避免空转一整轮",
    ],
    [
      "6",
      "<strong>检索必要性</strong>",
      "<code>tools/pre-execute</code>",
      "仅检索类工具；其余工具零开销",
      "省搜索与结果 token",
    ],
    [
      "7",
      "<strong>技能选择</strong>",
      "<code>tools/pre-execute</code>",
      "仅 <code>skill</code> 工具且候选非空",
      "省 2–5k / 次误加载",
    ],
    [
      "8",
      "<strong>思维链翻译门槛</strong>",
      "<code>cotTranslation.translate()</code>",
      "本地预筛 + 同文本缓存",
      "按条省翻译调用",
    ],
  ]
);

const providersTable = table(
  ["Provider", "默认地址", "端点", "密钥变量名", "默认模型"],
  [
    [
      "<code>system one</code>",
      "<code>https://api.typesafe.ai/v1</code>",
      "<code>/v1/systemone</code>",
      "<code>TYPESAFE_API_KEY</code>",
      "服务端默认",
    ],
    [
      "<code>bamboonode</code>",
      "<code>https://api.bamboonode.dev/v1</code>",
      "<code>/v1/decisions</code>",
      "<code>BAMBOO_API_KEY</code>",
      "服务端默认",
    ],
    [
      "<code>siliconflow</code><br><span class='badge gray'>国内站</span>",
      "<code>https://api.siliconflow.cn/v1</code>",
      "<code>/v1/systemone</code>",
      "<code>SILICONFLOW_API_KEY</code>",
      "<code>Kev-4B</code>",
    ],
    [
      "<code>siliconflow-intl</code><br><span class='badge gray'>国际站</span>",
      "<code>https://api.siliconflow.com/v1</code>",
      "<code>/v1/systemone</code>",
      "<code>SILICONFLOW_INTL_API_KEY</code>",
      "<code>Kev-4B</code>",
    ],
    [
      "<code>custom</code>",
      "用户填写（必填）",
      "按端点风格拼",
      "<code>DECISION_ENGINE_CUSTOM_KEY</code>",
      "<code>customModel</code>",
    ],
  ]
);

const degradeTable = table(
  ["情形", "降级码"],
  [
    ["插件未启用 / 只读工具 / auto 预设 / 被排除", "不判断，直接放行"],
    ["没有 API key", "<code>no-key</code>"],
    ["命中失败冷却", "<code>cooldown</code>"],
    ["端点 4xx / 5xx", "<code>http-404</code> / <code>http-500</code> 等（附 endpoint、body）"],
    ["网络不可达", "<code>network-error</code>"],
    ["超时", "<code>timeout</code>（附 timeoutMs）"],
    ["返回非 JSON / 非对象", "<code>invalid-json</code> / <code>invalid-response</code>"],
    ["缺 <code>answers</code> 字段", "<code>missing-answers</code>"],
    ["provider 配置不可用（如 custom base URL 非法）", "<code>invalid-base-url</code>"],
    ["鉴权被拒（401/403）", "<code>auth-failed</code>"],
    ["答案形状不符", "<code>answer-shape-mismatch</code>"],
    ["调用方中止", "<code>caller-aborted</code>"],
  ]
);

const pluginBody = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness 插件 · v${VERSION} · MIT</span>
  <h1>dsh-decision-engine</h1>
  <p class="lede">
    给 DeepSeek Harness 的 <strong>System-1 决策守卫</strong>：在每次工具调用前
    问模型四个问题——<strong>风险、可逆性、任务相关性、注入嫌疑</strong>——
    据此放行、询问或拦截。默认 <code>shadow</code>：只记录判断，绝不打断你干活。
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="#install">安装</a>
    <a class="btn" href="#points">八个决策点</a>
    <a class="btn" href="https://github.com/zuosus/dsh-decision-engine">GitHub</a>
  </div>
  ${codeBlock("dsh plugin add dsh-decision-engine")}
  <div class="toc">
    <a href="#what">它是什么</a>
    <a href="#install">安装</a>
    <a href="#config">配置</a>
    <a href="#points">决策点</a>
    <a href="#providers">Provider</a>
    <a href="#tokens">省 token</a>
    <a href="#failopen">失败降级</a>
    <a href="#verify">验证</a>
  </div>
</div>

<div class="wrap">
  <hr class="rule">
</div>

<section class="wrap" id="what">
  <h2>它是什么</h2>
  <p class="sub">
    定位不是「工具调用风险闸门」，而是<strong>一个便宜的判断层</strong>：用一次约
    1.9k token 的小模型调用，去替代或阻止更贵的 LLM 开销。
  </p>

  <div class="stats">
    <div class="stat"><span class="n">8</span><span class="l">个决策点，全部已实装</span></div>
    <div class="stat"><span class="n">~1.9k</span><span class="l">token / 次决策</span></div>
    <div class="stat"><span class="n">0.5s</span><span class="l">p50 延迟</span></div>
    <div class="stat"><span class="n">shadow</span><span class="l">默认模式，只记录不生效</span></div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">四个问题</span>
      <h4>风险 · 可逆性 · 任务相关性 · 注入嫌疑</h4>
      <p>
        每次判断只问这四个。答案被解析成一个处置：<code>allow</code>、
        <code>ask</code> 或 <code>deny</code>——以及在需要时替换模型、
        注入提示、跳过一次检索。
      </p>
    </div>
    <div class="card">
      <span class="kicker">克制的介入</span>
      <h4>只在值得的地方介入</h4>
      <p>
        判断必须克制：<strong>只在「替代更贵的调用」或「阻止更大的开销」处介入</strong>，
        绝不为了「多一道检查」而介入。热路径上的点都带明确的触发闸。
      </p>
    </div>
  </div>

  <div class="note">
    <strong>它支持所有 system-one 风格 API。</strong>
    内置 <code>system one</code> 与 <code>bamboonode</code> 两个预设，
    也可以填任意 <code>custom</code> base URL（自建 llama.cpp / vLLM、
    企业网关、第三方中转）。请求路径、鉴权方式与响应结构与 system-one 协议保持一致，
    换 provider 不影响各决策点的解析逻辑。
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="install">
  <h2>安装</h2>
  <p class="sub">从 npm 装（推荐），或本地开发。</p>

  <h3>从 npm 安装</h3>
  ${codeBlock("dsh plugin add dsh-decision-engine")}
  <p style="color:var(--fg-dim);font-size:14.5px;margin-top:-4px">
    或手动装进 profile：
  </p>
  ${codeBlock("cd ~/.dsh/profiles/desktop && pnpm add dsh-decision-engine")}
  <p style="color:var(--fg-dim);font-size:14.5px">
    然后在 profile 的 <code>package.json</code> → <code>dsh.profile.bundles</code>
    里加入 <code>"dsh-decision-engine"</code>，重启 DSH。
  </p>

  <h3>本地开发</h3>
  ${codeBlock("git clone https://github.com/zuosus/dsh-decision-engine.git")}
  <p style="color:var(--fg-dim);font-size:14.5px">
    仓库带迁移脚本，不用手改（默认只预览，<code>--write</code> 才写入并自动备份）：
  </p>
  ${codeBlock("node scripts/migrate-profile.mjs --write")}

  <div class="note ok">
    <strong>配置不用重填。</strong>插件启动时会做一次自动迁移，把旧目录里的配置与
    遥测拷到新目录 <code>~/.dsh/dsh-decision-engine/</code>。
    <strong>只搬一次</strong>：新目录已有 <code>config.yml</code> 就不再动，
    绝不覆盖你后来改的值。
  </div>

  <div class="note warn">
    <strong>0.5.0 起配置文件名从 <code>startlux.yml</code> 改为 <code>config.yml</code></strong>
    ——本插件已不只服务 startlux 一家。旧文件会被自动改名迁移，升级不需要重新填 key。
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="config">
  <h2>配置</h2>
  <p class="sub">
    <strong>插件 → 已安装 → dsh-decision-engine</strong>，配置区出现 Decision Engine 卡片。
    改完即保存，没有「保存」按钮，也不需要重启。
  </p>

  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">三态</span>
      <h4>关闭 / 观察 / 生效</h4>
      <p>
        <span class="badge gray">关闭</span> 连请求都不发，省 token 也省约 2 秒延迟；
        <span class="badge blue">观察</span> 照常判断并记录「本该怎样」，但不改变任何行为；
        <span class="badge green">生效</span> 按判断执行该点的处置。
      </p>
    </div>
    <div class="card">
      <span class="kicker">密钥</span>
      <h4>两个存放位置</h4>
      <p>
        默认写进 <code>~/.dsh/.credentials.yaml</code> 的 <code>refs:</code> 段
        （与其他服务统一托管，插件目录不留明文）；也可以选 <code>config</code>
        让配置自包含。五个 provider 各有自己的键名，互不覆盖。
      </p>
    </div>
    <div class="card">
      <span class="kicker">密钥优先级</span>
      <h4>显式 &gt; 存储位置 &gt; 环境变量</h4>
      <p>
        该 provider 的显式 key 字段 &gt; 密钥存储位置里对应的键 &gt; 环境变量。
        切换 provider 只改一个键，其它 provider 已保存的地址、模型、密钥原样留着。
      </p>
    </div>
    <div class="card">
      <span class="kicker">模型</span>
      <h4>下拉来自服务端</h4>
      <p>
        模型下拉由当前 provider 的 <code>/v1/models</code> 实时提供，
        另有「自动（服务端默认）」选项。默认就是「自动」——插件不发送该字段，
        即便服务商将来换模型名也不会 400。
      </p>
    </div>
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="points">
  <h2>八个决策点</h2>
  <p class="sub">
    八个决策点<strong>全部已实装</strong>，由你决定让决策模型进入哪些环节。
    挂载的 hook 只是实现细节，配置页列的是这里定义的决策点。
  </p>
  ${pointsTable}

  <div class="note">
    <strong>为什么不是「所有 hook 都开」：</strong>决策模型每次约 1.9k token、
    p50 约 0.5 秒。<code>agent/pre-step</code> 与 <code>agent/request</code>
    都是<strong>每步</strong>触发，两个都开且不加闸，等于每步多等 1 秒以上。
    所以热路径上的决策点都带明确的触发闸，不能无条件调用。
  </div>

  <h3>阈值是实测校准的，不是拍脑袋的</h3>
  <p style="color:var(--fg-dim)">
    每个决策点的阈值都用真实端点跑过对照样本（「该判 A」与「该判 B」成对输入），
    只有两类输入真的分得开才留着。校准过程发现并修掉了三个问题：
  </p>
  <div class="grid grid-3">
    <div class="card">
      <span class="kicker">01</span>
      <h4>confidence 是被选中项的概率</h4>
      <p>三选项平分时天然只有 0.33，所以分派点的门槛不能设 0.6，否则永远判不出 <code>advise</code>。现在按「显著高于均分」取 0.5。</p>
    </div>
    <div class="card">
      <span class="kicker">02</span>
      <h4>问法决定一切</h4>
      <p>原来问「这个信息是否已知道」，两类输入给出 0.30 / 0.12——完全没有区分力。改问「recent 里是否逐字覆盖了这个事实」之后变成 0.92 / 0.01。</p>
    </div>
    <div class="card">
      <span class="kicker">03</span>
      <h4>判据顺序会改变结果</h4>
      <p>轮次延续若先看 <code>closed</code>，「明确未完成」那组会因为不达线而掉进默认 <code>stop</code>——而它恰恰该续轮。现在先看 <code>unfinished</code>。</p>
    </div>
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="providers">
  <h2>Provider：接任意 system-one 风格服务</h2>
  <p class="sub">
    请求形状对所有 provider 完全一致。响应只需含 <code>answers</code>，
    因此 provider 只决定三件事：<strong>往哪发、用谁的 key、默认哪个模型</strong>。
  </p>

  ${codeBlock('POST <base>/decisions  或  POST <base>/systemone')}

  ${providersTable}

  <div class="note ok">
    <strong>开箱即用：</strong><code>siliconflow</code> / <code>siliconflow-intl</code>
    只需要粘一个 API key——地址、路径（<code>/systemone</code>）、
    默认模型（<code>Kev-4B</code>）都已预置。两个站点是两套账号，key 互不通用。
  </div>

  <h3>端点路径由服务商决定，不由模型决定</h3>
  <p style="color:var(--fg-dim)">
    这是最容易踩空的一处，因此实测过（2026-10-25，真实 key 打真实端点）：
  </p>
  ${table(
    ["服务商", "模型", "<code>/v1/decisions</code>", "<code>/v1/systemone</code>"],
    [
      ["SiliconFlow", "<code>Kev-4B</code>", "<strong>404 Not Found</strong>", '<span class="badge green">200 ✓</span>'],
      ["bamboonode", "<code>startlux-decision-27b-autothink</code>", '<span class="badge green">200 ✓</span>', '<span class="badge green">200 ✓</span>'],
    ]
  )}
  <p style="color:var(--fg-dim)">
    所以「端点风格」只是<strong>首选</strong>：先打首选路径；收到 404 时自动改用
    另一条再试一次；试通的那条会被记住（按 base URL 区分），下次直接打它。
    只有 404 会触发换路径——400 / 401 / 5xx 都与路径无关，换路径只是多烧一次请求。
  </p>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="tokens">
  <h2>省 token 的设计</h2>
  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">双层缓存</span>
      <h4>精确层默认开启，软层默认关闭</h4>
      <p>
        <strong>精确</strong>：完整 state + 问题集一致才复用，这是唯一默认开启的层。
        <strong>同类复用</strong>：键刻意丢弃参数内容，因此
        <strong>默认关闭（fail-closed）</strong>，且工具授权<strong>永久禁用</strong>——
        安全决策的缓存要么绑定完整调用上下文，要么不做。
      </p>
    </div>
    <div class="card">
      <span class="kicker">thinkMode</span>
      <h4>默认 <code>never</code></h4>
      <p>
        实测主要省<strong>延迟</strong>（约 1.9s vs 7.2s）。
        <code>never</code> / <code>auto</code> / <code>always</code> 三档可切换；
        非法值会被归一成 <code>never</code>，不会被原样发给服务端。
      </p>
    </div>
    <div class="card">
      <span class="kicker">触发闸</span>
      <h4>只读工具直接放行</h4>
      <p>
        <code>read</code> / <code>grep</code> / <code>glob</code> /
        <code>todo_write</code> 等不发请求。state 也做截断：<code>args</code>
        走头尾摘要，<code>recent</code> 只带最近 4 条、每条 240 字符。
      </p>
    </div>
    <div class="card">
      <span class="kicker">失败冷却</span>
      <h4>连续 3 次失败 → 60s</h4>
      <p>
        冷却期内直接放行、0ms 返回，不再对着故障端点反复消耗。
        另有单次硬超时（默认 8000ms，实测 p50≈0.7s、冷启动 p95≈6.4s）。
      </p>
    </div>
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="failopen">
  <h2>失败降级（fail-open）</h2>
  <p class="sub">
    设计原则是<strong>任何不确定都退回原生行为</strong>，绝不因为守卫自身故障而
    卡住工具调用。以下情形全部放行，并在 <code>telemetry.jsonl</code> 记一条
    <code>action=degraded</code>。
  </p>
  ${degradeTable}
  <div class="note ok">
    默认 <code>mode: shadow</code> 时，即使判断出 <code>deny</code> 也只记录不执行。
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="verify">
  <h2>验证链路</h2>
  <p class="sub">三条自动化验收，全部可重复跑。</p>
  ${codeBlock("pnpm test && pnpm verify:wiring && pnpm verify:endpoint")}
  ${table(
    ["命令", "覆盖"],
    [
      ["<code>pnpm test</code>", "209 项单元测试：纯函数 + 适配器接线 + providers + 配置往返 + 设置界面渲染 + 缓存回归"],
      ["<code>pnpm verify:wiring</code>", "接线检查：用真实 schemastery 加载插件，确认宿主确实给了这个服务"],
      ["<code>pnpm verify:endpoint</code>", "8 个决策点逐个打真实端点，校验题型与答案形状"],
    ]
  )}
  <div class="note warn">
    <strong><code>verify:endpoint</code> 这一步不能省。</strong>
    题型写错会在运行时 400 并静默降级，光看日志很难发现
    「这个点其实一直没生效」。
  </div>

  <h3>手工验证</h3>
  <p style="color:var(--fg-dim)">
    把某个点切到「观察」，触发一次对应动作，然后看
    <code>~/.dsh/dsh-decision-engine/telemetry.jsonl</code>：
  </p>
  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">detail</span>
      <h4>怎么读懂一条记录</h4>
      <p>
        <code>no-key</code> → key 没读到；
        <code>http-404</code> / <code>http-400</code> → 地址或模型不对；
        <code>answer-shape-mismatch</code> → 该点的问题集要复核。
      </p>
    </div>
    <div class="card">
      <span class="kicker">point</span>
      <h4>哪个点、判了什么</h4>
      <p>
        <code>point=route, action=switch</code> 表示该点判出了
        「本该下沉到便宜模型」。每条的 <code>point</code> 字段标明决策点，
        <code>scores</code> 里是原始判断分数。
      </p>
    </div>
  </div>

  <h3>数据目录</h3>
  <p style="color:var(--fg-dim)">
    数据目录是 <code>$DSH_HOME/dsh-decision-engine/</code>，<code>~/.dsh</code>
    只是 <code>DSH_HOME</code> 未设置时的默认值。空白值等于未设置
    （<code>DSH_HOME=""</code> 会回退，绝不会解析到当前工作目录），
    支持波浪号，相对路径会被规范化成绝对路径。
  </p>
</section>
`;

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3AC251"/>
      <stop offset="55%" stop-color="#2BAE7E"/>
      <stop offset="100%" stop-color="#1481BF"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#0b0e14"/>
  <g transform="translate(6 6) scale(2)">
    <rect x="3" y="10" width="3.2" height="16" rx="1.6" fill="url(#g)"/>
    <rect x="8" y="4" width="3.2" height="22" rx="1.6" fill="url(#g)"/>
    <rect x="13" y="0" width="3.2" height="26" rx="1.6" fill="url(#g)"/>
    <rect x="18" y="6" width="3.2" height="20" rx="1.6" fill="url(#g)"/>
    <rect x="23" y="12" width="3.2" height="14" rx="1.6" fill="url(#g)"/>
  </g>
</svg>
`;

if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "assets"), { recursive: true });
await mkdir(path.join(DIST, "dsh-decision-engine"), { recursive: true });
await mkdir(path.join(DIST, "en", "dsh-decision-engine"), { recursive: true });

await copyFile(path.join(HERE, "assets/style.css"), path.join(DIST, "assets/style.css"));
await copyFile(path.join(HERE, "assets/app.js"), path.join(DIST, "assets/app.js"));
await copyFile(path.join(HERE, "assets/theme.js"), path.join(DIST, "assets/theme.js"));

// 中文（默认）与英文各两页；alt 互相指认，hreflang 与导航语言按钮共用。
const ZH_HOME = { lang: "zh-CN", self: "/", alt: { path: "/en/", label: "English" } };
const ZH_PROJ = {
  lang: "zh-CN",
  self: "/dsh-decision-engine/",
  alt: { path: "/en/dsh-decision-engine/", label: "English" },
};
const EN_HOME = { lang: "en", self: "/en/", alt: { path: "/", label: "中文" } };
const EN_PROJ = {
  lang: "en",
  self: "/en/dsh-decision-engine/",
  alt: { path: "/dsh-decision-engine/", label: "中文" },
};

await writeFile(
  path.join(DIST, "index.html"),
  page(
    "dsh.zuos.us — DeepSeek Harness 插件项目",
    "DeepSeek Harness 插件项目主页：dsh-decision-engine —— 给 DSH 的 System-1 决策守卫。",
    indexBody,
    ZH_HOME
  )
);

await writeFile(
  path.join(DIST, "dsh-decision-engine/index.html"),
  page(
    "dsh-decision-engine — 给 DeepSeek Harness 的 System-1 决策守卫",
    "在每次工具调用前问模型四个问题（风险、可逆性、任务相关性、注入嫌疑），据此放行、询问或拦截。八个决策点全部已实装，默认 shadow 只记录不打断。",
    pluginBody,
    ZH_PROJ
  )
);

await writeFile(
  path.join(DIST, "en/index.html"),
  page(
    "dsh.zuos.us — DeepSeek Harness plugin projects",
    "Home of DeepSeek Harness plugin projects: dsh-decision-engine — a System-1 decision guard for DSH.",
    indexBodyEn,
    EN_HOME
  )
);

await writeFile(
  path.join(DIST, "en/dsh-decision-engine/index.html"),
  page(
    "dsh-decision-engine — a System-1 decision guard for DeepSeek Harness",
    "Asks the model four questions (risk, reversibility, task relevance, injection suspicion) before every tool call. All eight decision points implemented; shadow mode by default.",
    pluginBodyEn,
    EN_PROJ
  )
);

await writeFile(path.join(DIST, "favicon.svg"), favicon);

console.log("built ->", DIST);
