// 把站点源文件渲染成 dist/ 下的静态文件。运行：node site/build.mjs
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nav, footer, codeBlock, table, figure, fact, DECISION_ICON, FLATMAP_ICON, esc } from "./lib/partials.mjs";
import { indexBodyEn, pluginBodyEn, flatmapBodyEn } from "./lib/content-en.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
// 版本号只有一个来源：插件自己的 package.json。写死在这里必然漂移
// （曾经停在 0.7.1，而包已经走到 0.9.x，站点上挂的就是旧号）。
const VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
// flatmap 版本号写死在这里：构建环境（Cloudflare Workers Builds）只拉取本仓库
// (dsh-decision-engine)，没有平级的 dsh-model-flatmap 仓库，无法在构建期读到它的
// package.json。升级 flatmap 时记得手动同步这个数字（见 DEC 记录）。
const FLATMAP_VERSION = "1.0.0";
const ORIGIN = "https://dsh.zuos.us";

// 两个语言的顶部导航。链接都写绝对路径，子目录页也能正确跳转。
function navLinksFor(locale) {
  const prefix = locale === "zh" ? "" : "/en";
  const L = locale === "zh";
  return [
    { href: `${prefix}/dsh-decision-engine/#points`, label: L ? "决策点" : "Decision points", opt: true },
    { href: `${prefix}/dsh-decision-engine/#providers`, label: "Provider", opt: true },
    { href: `${prefix}/dsh-decision-engine/#verify`, label: L ? "验证" : "Verification", opt: true },
    { href: `${prefix}/dsh-model-flatmap/#what`, label: "flatmap", opt: true },
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
    两个开源 DSH 插件，做同一件事：<strong>用一次很小的调用，省下一次很大的开销</strong>。
    默认只观察、不打断；任何出错都退回原生行为。
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="/dsh-decision-engine/">dsh-decision-engine →</a>
    <a class="btn" href="/dsh-model-flatmap/">dsh-model-flatmap</a>
    <a class="btn" href="https://github.com/zuosus/dsh-decision-engine">源码</a>
  </div>
</div>

${figure("/assets/promo.jpeg", "dsh-decision-engine 宣传图", "dsh-decision-engine：主模型动手前，先用一个小模型做判断")}

<div class="wrap"><hr class="rule"></div>

<section class="wrap">
  <h2>两个插件</h2>
  <p class="sub">一个管「该不该做、用哪个模型」，一个管「选模型别再层层点开」。都免费、MIT、装了就能用。</p>

  <div class="projects">
    <a class="project" href="/dsh-decision-engine/">
      ${DECISION_ICON}
      <div>
        <h3>dsh-decision-engine</h3>
        <span class="ver">v${VERSION}</span>
        <p>
          在主模型动手前，把「当前状态 + 四个问题」发给一个便宜的小模型，
          拿回答案后决定<strong>放行、询问、拦截</strong>，或换用便宜模型、跳过一次昂贵调用。
          八个决策点全部实装、逐个可切换；默认 shadow 只记录不生效。
        </p>
        <div class="toc">
          <span class="badge green">默认只观察</span>
          <span class="badge blue">接任意决策端点</span>
          <span class="badge gray">MIT</span>
        </div>
      </div>
      <span class="go">查看介绍 →</span>
    </a>

    <a class="project" href="/dsh-model-flatmap/">
      ${FLATMAP_ICON}
      <div>
        <h3>dsh-model-flatmap</h3>
        <span class="ver">v${FLATMAP_VERSION}</span>
        <p>
          把输入框里的模型选择器换成<strong>一块平铺面板</strong>：所有模型、推理等级、
          协作开关一次看完，没有二级菜单。支持跨 provider 搜索、两种分组；
          额度不足的模型自动加删除线。关闭插件即复原原生控件。
        </p>
        <div class="toc">
          <span class="badge green">平铺无二级菜单</span>
          <span class="badge blue">跟随主题</span>
          <span class="badge gray">MIT</span>
        </div>
      </div>
      <span class="go">查看介绍 →</span>
    </a>
  </div>
</section>

<section class="wrap">
  <h2>界面长这样</h2>
  <p class="sub">都是运行中的真实截图，来自各自仓库的 <code>docs/assets/</code>。</p>
  <div class="shots">
    ${figure("/assets/shot-decisions.png", "决策历史标签页", "dsh-decision-engine：每一次判断与降级都有记录")}
    ${figure("/assets/shot-flatmap.jpeg", "平铺模型选择器", "dsh-model-flatmap：模型、推理等级、协作开关同屏")}
  </div>
</section>

<section class="wrap">
  <h2>三条共同约定</h2>
  <p class="sub">也是它们能被放心常驻的原因。</p>
  <div class="facts">
    ${fact("fail-open", "<strong>不确定就放行。</strong>超时、网络错误、鉴权失败、返回异常，一律退回原生行为并记一条遥测；守卫自己故障不会卡住工具调用。")}
    ${fact("shadow first", "<strong>先观察，再生效。</strong>每个决策点有 关闭 / 观察 / 生效 三态；新点默认跑「观察」，确认判断靠谱后再切「生效」。")}
    ${fact("cheap by design", "<strong>只省更大的开销。</strong>只在「替代更贵的调用」或「阻止更大的开销」处介入，不为多一道检查而介入。")}
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
    主模型动手前，先让一个<strong>便宜的小模型</strong>回答四个问题——
    <strong>风险、可逆性、任务相关性、注入嫌疑</strong>——再决定放行、询问、
    拦截，或者换个便宜模型、干脆跳过这次昂贵调用。默认 <code>shadow</code>：
    只记录，不打断。
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

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="what">
  <h2>它是什么</h2>
  <p class="sub">
    一个便宜的<strong>判断层</strong>：一次约 1.9k token 的小模型调用，
    去替代或阻止更贵的 LLM 开销。八个决策点全部实装，逐个可切换。
  </p>

  <div class="stats">
    <div class="stat"><span class="n">8</span><span class="l">个决策点，全部实装</span></div>
    <div class="stat"><span class="n">~1.9k</span><span class="l">token / 次决策</span></div>
    <div class="stat"><span class="n">0.5s</span><span class="l">p50 延迟</span></div>
    <div class="stat"><span class="n">shadow</span><span class="l">默认只记录不生效</span></div>
  </div>

  ${figure("/assets/shot-config.png", "配置页：八个决策点逐个切换三态", "配置页：每个决策点有 关闭 / 观察 / 生效 三态，改完即保存")}

  <div class="facts">
    ${fact("四个问题", "风险 · 可逆性 · 任务相关性 · 注入嫌疑。答案被解析成 <code>allow</code> / <code>ask</code> / <code>deny</code>，需要时还能替换模型、注入提示、跳过一次检索。")}
    ${fact("克制的介入", "只在「替代更贵的调用」或「阻止更大的开销」处介入；热路径上的点都带触发闸，绝不为了多一道检查而介入。")}
    ${fact("接任意端点", "请求只有一个形状：<code>{ model, state, questions, think_mode }</code> 发过去，拿回 <code>answers</code>。内置多个 provider 预设，也能填任意 <code>custom</code> base URL。")}
  </div>

  <div class="note">
    <strong>免费通道。</strong>打开「使用免费模型」即可用项目方提供的决策模型，
    不用自己填 key；额度由项目方承担，随时可能停用或调整，界面上会直说这个风险。
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="install">
  <h2>安装</h2>
  <p class="sub">从 npm 装（推荐），或本地开发。</p>

  ${codeBlock("dsh plugin add dsh-decision-engine")}
  <p class="sub">或手动装进 profile，再把 <code>"dsh-decision-engine"</code> 加进 <code>package.json</code> → <code>dsh.profile.bundles</code>，重启 DSH：</p>
  ${codeBlock("cd ~/.dsh/profiles/desktop && pnpm add dsh-decision-engine")}

  <div class="facts">
    ${fact("配置不用重填", "启动时把旧目录的配置与遥测自动搬到 <code>~/.dsh/dsh-decision-engine/</code>，只搬一次，不覆盖后来改的值。")}
    ${fact("本地开发", "<code>git clone</code> 后跑 <code>node scripts/migrate-profile.mjs --write</code>（默认只预览，带 <code>--write</code> 才写入并自动备份）。")}
    ${fact("0.5.0 起", "配置文件名从 <code>startlux.yml</code> 改为 <code>config.yml</code>，旧文件自动迁移，升级不用重填 key。")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="config">
  <h2>配置</h2>
  <p class="sub">
    打开 <strong>插件 → 已安装 → dsh-decision-engine</strong>，配置区出现 Decision Engine 卡片。
    改完即保存，没有保存按钮，也不用重启。
  </p>
  <div class="facts">
    ${fact("三态", "<span class='badge gray'>关闭</span> 不发请求；<span class='badge blue'>观察</span> 判断并记录「本该怎样」但不改行为；<span class='badge green'>生效</span> 按判断执行。")}
    ${fact("密钥", "默认写进 <code>~/.dsh/.credentials.yaml</code> 的 <code>refs:</code> 段，插件目录不留明文；也可选 <code>config</code> 自包含。各 provider 键名互不覆盖。")}
    ${fact("优先级", "显式 key &gt; 密钥存储位置里对应的键 &gt; 环境变量。切换 provider 只改一个键，其它 provider 的值原样留着。")}
    ${fact("模型", "下拉来自当前 provider 的 <code>/v1/models</code>，默认「自动」——不发送该字段，服务商换模型名也不会 400。")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="points">
  <h2>八个决策点</h2>
  <p class="sub">全部实装，由你决定让决策模型进入哪些环节。挂载的 hook 只是实现细节。</p>
  ${pointsTable}

  ${figure("/assets/shot-decisions.png", "决策历史标签页", "决策历史：每一次判断、分数与降级都查得到")}

  <div class="note">
    <strong>为什么不把每个 hook 都打开：</strong>一次判断约 1.9k token、p50 约 0.5 秒，
    而 <code>agent/pre-step</code> / <code>agent/request</code> 每步都触发。热路径上的点都带触发闸，不能无条件调用。
  </div>

  <h3>阈值是实测校准的</h3>
  <p class="sub">用真实端点跑过成对样本（「该判 A」vs「该判 B」），分得开才留着。过程中修掉三个问题：</p>
  <div class="facts">
    ${fact("01 · confidence", "三选项平分时天然只有 0.33，所以分派点的门槛取 0.5（显著高于均分），不能设 0.6，否则 <code>advise</code> 永远判不出。")}
    ${fact("02 · 问法", "问「是否已知道」得到 0.30 / 0.12 毫无区分力；改问「recent 里是否逐字覆盖」后变成 0.92 / 0.01。")}
    ${fact("03 · 判据顺序", "轮次延续若先看 <code>closed</code>，「明确未完成」会掉进默认 <code>stop</code>；现在先看 <code>unfinished</code>。")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="providers">
  <h2>Provider：接哪个决策服务</h2>
  <p class="sub">
    请求形状对所有 provider 完全一致，响应只需含 <code>answers</code>。
    provider 只决定三件事：<strong>往哪发、用谁的 key、默认哪个模型</strong>。
  </p>
  ${codeBlock("POST <base>/decisions  或  POST <base>/systemone")}
  ${providersTable}

  <div class="note ok">
    <strong>开箱即用：</strong><code>siliconflow</code> / <code>siliconflow-intl</code>
    只需粘一个 API key——地址、路径（<code>/systemone</code>）、默认模型（<code>Kev-4B</code>）都已预置。两个站点是两套账号，key 不通用。
  </div>

  <h3>端点路径由服务商决定，不由模型决定</h3>
  <p class="sub">实测过（2026-10-25，真实 key 打真实端点）：</p>
  ${table(
    ["服务商", "模型", "<code>/v1/decisions</code>", "<code>/v1/systemone</code>"],
    [
      ["SiliconFlow", "<code>Kev-4B</code>", "<strong>404 Not Found</strong>", '<span class="badge green">200 ✓</span>'],
      ["bamboonode", "<code>startlux-decision-27b-autothink</code>", '<span class="badge green">200 ✓</span>', '<span class="badge green">200 ✓</span>'],
    ]
  )}
  <p class="sub">
    所以「端点风格」只是<strong>首选</strong>：先打首选路径，收到 404 自动换另一条再试一次，
    试通的会被记住（按 base URL 区分）。只有 404 会换路径——400 / 401 / 5xx 与路径无关，换路径只是多烧一次请求。
  </p>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="tokens">
  <h2>省 token 的设计</h2>
  <div class="facts">
    ${fact("双层缓存", "<strong>精确层</strong>完整 state + 问题集一致才复用，默认开启；<strong>同类复用层</strong>刻意丢弃参数内容，默认关闭且工具授权永久禁用——安全决策要么绑定完整上下文，要么不缓存。")}
    ${fact("thinkMode", "默认 <code>never</code>，实测主要省延迟（约 1.9s vs 7.2s）。<code>never</code> / <code>auto</code> / <code>always</code> 可切换，非法值归一成 <code>never</code>。")}
    ${fact("触发闸", "<code>read</code> / <code>grep</code> / <code>glob</code> / <code>todo_write</code> 等只读工具直接放行；state 也截断，<code>recent</code> 只带最近 4 条、每条 240 字符。")}
    ${fact("失败冷却", "连续 3 次失败 → 冷却 60s，期内 0ms 放行、不再对着故障端点烧钱。单次硬超时默认 8000ms（实测 p50≈0.7s、冷启动 p95≈6.4s）。")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="failopen">
  <h2>失败降级（fail-open）</h2>
  <p class="sub">
    <strong>任何不确定都退回原生行为</strong>，守卫自身故障绝不卡住工具调用。
    以下情形全部放行，并在 <code>telemetry.jsonl</code> 记一条 <code>action=degraded</code>。
  </p>
  ${degradeTable}
  <div class="note ok">默认 <code>shadow</code> 时，即使判断出 <code>deny</code> 也只记录、不执行。</div>
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
      ["<code>pnpm verify:wiring</code>", "用真实 schemastery 加载插件，确认宿主确实给了这个服务"],
      ["<code>pnpm verify:endpoint</code>", "8 个决策点逐个打真实端点，校验题型与答案形状"],
    ]
  )}
  <div class="note warn">
    <strong><code>verify:endpoint</code> 不能省。</strong>题型写错会在运行时 400 并静默降级，
    光看日志很难发现「这个点其实一直没生效」。
  </div>

  <h3>手工看一条记录</h3>
  <p class="sub">把某个点切到「观察」，触发一次动作，读 <code>~/.dsh/dsh-decision-engine/telemetry.jsonl</code>：</p>
  <div class="facts">
    ${fact("detail", "<code>no-key</code> → key 没读到；<code>http-404</code> / <code>http-400</code> → 地址或模型不对；<code>answer-shape-mismatch</code> → 问题集要复核。")}
    ${fact("point", "<code>point=route, action=switch</code> 表示该点判出「本该下沉到便宜模型」；每条都带 <code>point</code> 与原始 <code>scores</code>。")}
    ${fact("数据目录", "<code>$DSH_HOME/dsh-decision-engine/</code>，<code>~/.dsh</code> 只是未设置时的默认值；空白值按未设置处理，支持波浪号，相对路径规范化为绝对路径。")}
  </div>
</section>
`;

/* ------------------------------------------------------------------ *
 * flatmap 插件页（中文）
 * ------------------------------------------------------------------ */

const flatmapBody = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness 插件 · v${FLATMAP_VERSION} · MIT</span>
  <h1>dsh-model-flatmap</h1>
  <p class="lede">
    把输入框里的模型选择器换成<strong>一块平铺面板</strong>：所有模型、推理等级、
    协作开关在同一平面上，一次看完，没有层层弹层。搜索、分组、跟随主题都在这块面板里。
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="#install">安装</a>
    <a class="btn" href="#what">它是什么</a>
    <a class="btn" href="https://github.com/zuosus/dsh-model-flatmap">GitHub</a>
  </div>
  <div class="toc">
    <a href="#what">它是什么</a>
    <a href="#features">功能</a>
    <a href="#install">安装</a>
    <a href="#layout">目录结构</a>
    <a href="#dev">开发</a>
  </div>
</div>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="what">
  <h2>它是什么</h2>
  <p class="sub">
    一个<strong>纯浏览器端</strong>的 DSH 插件，替换 composer 里的
    <code>conversation.input.model</code> 控件，渲染成一块可搜索的平铺网格。
  </p>

  <div class="stats">
    <div class="stat"><span class="n">0</span><span class="l">个二级菜单</span></div>
    <div class="stat"><span class="n">320px</span><span class="l">面板高度上限</span></div>
    <div class="stat"><span class="n">2</span><span class="l">种分组模式</span></div>
    <div class="stat"><span class="n">shadow</span><span class="l">禁用即复原原生</span></div>
  </div>

  ${figure("/assets/shot-flatmap.jpeg", "运行中的平铺模型选择器", "运行中的面板：模型网格、推理等级、协作开关都在同一平面")}

  <div class="facts">
    ${fact("一块平面", "触发器打开高度上限 320px 的面板。头部、推理等级行、协作行固定常驻，只有模型网格滚动——信息一次看完，不用在弹层之间来回钻。")}
    ${fact("只用公开 API", "只通过公开的 Client API 读写模型目录、协作设置与宿主文案；宿主部分 <code>index.js</code> 不提供任何服务/工具/事件，UI 全在 <code>client.js</code>，用负优先级覆盖原生 <code>ModelSelect</code>。")}
    ${fact("禁用即复原", "关闭 bundle 不触碰任何原生控件，<code>ModelSelect</code> 无残留地恢复。纯 ES 模块、零构建。")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="features">
  <h2>功能</h2>
  <p class="sub">没有嵌套菜单，取而代之的是一块可搜索、可分组、跟随主题的平面。</p>
  <div class="facts">
    ${fact("全局搜索", "跨所有 provider 与 family 过滤；空组会被丢弃，不留空标题。命中排序：前缀 &gt; 子串 &gt; 有序字符匹配。")}
    ${fact("分词搜索", "空白把查询拆成多个 token，每个都要在名称中命中；一次命中的排序取决于最弱的那个 token。")}
    ${fact("按 provider 整体", "查询若命中某个 provider（id / 目录名 / 分组标签），该 provider 的整个目录都会保留。")}
    ${fact("两种分组", "分段控件在「按 provider」与「按 family」间切换；分组与搜索彼此独立，可任意组合。")}
    ${fact("模型家族", "内置词典识别 DeepSeek、Grok、Claude、Qwen、GLM、Kimi、GPT、Gemini、Llama 等；已注册品牌按 generation 分节（HY3 / HY4 / HY），未覆盖的按 id 推断，无法判断归 Others（永远排最后）。家族保持平铺。")}
    ${fact("推理等级", "当前模型的推理等级渲染成互斥、可键盘操作的分组（基于 radio 语义）。与协作开关放得下就共用一行，放不下各占一行，换行由 CSS flex 决定。")}
    ${fact("额度不足划删除线", "某模型调用因额度/余额不足失败后，该行带 <code>line-through</code>，直到同模型下次返回正常结果才去掉；纯限流的 429 不划线。")}
    ${fact("跟随主题 · 零构建", "只用宿主主题令牌着色，浅色/深色都正确；纯 ES 模块，测试直接读 <code>client.js</code> 驱动真实组件，捕获崩溃、缺失区块与错误列数。")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="install">
  <h2>安装</h2>
  <p class="sub">本包是一个 DSH <strong>bundle</strong>。从插件管理器安装，或手动放进 profile 的 bundle 目录。</p>
  ${codeBlock("dsh plugin add dsh-model-flatmap")}
  <p class="sub">或手动放入 profile（路径因安装而异）：</p>
  ${codeBlock('cp -r . "<profile>/bundles/dsh-model-flatmap"')}
  <div class="note ok">
    <strong>禁用即复原。</strong>在插件列表里启用/停用即可；<code>dsh</code> 加载器读取
    <code>cordis.patch.yml</code> 完成挂载，关闭后原生控件无残留恢复。
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="layout">
  <h2>目录结构</h2>
  <p class="sub">插件很轻：宿主部分几乎为零，全部 UI 集中在 <code>client.js</code>。</p>
  ${table(
    ["路径", "用途"],
    [
      ["<code>index.js</code>", "宿主部分——bundle 入口，运行时不提供任何能力。"],
      ["<code>client.js</code>", "浏览器部分——完整的平铺选择器 UI。"],
      ["<code>cordis.patch.yml</code>", "由 <code>dsh</code> bundle 加载器应用的 Cordis 补丁。"],
      ["<code>locale/en.json</code> / <code>locale/zh.json</code>", "英文 / 简体中文文案与元数据。"],
      ["<code>docs/DETAIL.md</code>", "详细行为规格。"],
      ["<code>test/</code>", "通过最小化 hook 运行时驱动的渲染路径测试。"],
    ]
  )}
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="dev">
  <h2>开发</h2>
  <p class="sub">纯 ES 模块，无需构建步骤。</p>
  ${codeBlock("node --test test/")}
  <p class="sub">
    完整行为规格见 <a href="https://github.com/zuosus/dsh-model-flatmap/blob/main/docs/DETAIL.md">docs/DETAIL.md</a>，
    设计决策见 <a href="https://github.com/zuosus/dsh-model-flatmap/blob/main/DECISIONS.md">DECISIONS.md</a>。
  </p>
</section>
`;

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

// 与 partials.mjs 的品牌图标同一造型，深色底 + 渐变三层。
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="6" y1="10" x2="58" y2="54">
      <stop offset="0%" stop-color="#3AC251"/>
      <stop offset="52%" stop-color="#2BAE7E"/>
      <stop offset="100%" stop-color="#1481BF"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="#0b0e14"/>
  <path d="M32 11 55 24 32 37 9 24z" fill="url(#g)"/>
  <path d="M9 35 32 48 55 35" fill="none" stroke="url(#g)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity=".78"/>
  <path d="M9 45 32 58 55 45" fill="none" stroke="url(#g)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity=".45"/>
</svg>
`;

if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "assets"), { recursive: true });
await mkdir(path.join(DIST, "dsh-decision-engine"), { recursive: true });
await mkdir(path.join(DIST, "dsh-model-flatmap"), { recursive: true });
await mkdir(path.join(DIST, "en", "dsh-decision-engine"), { recursive: true });
await mkdir(path.join(DIST, "en", "dsh-model-flatmap"), { recursive: true });

await copyFile(path.join(HERE, "assets/style.css"), path.join(DIST, "assets/style.css"));
await copyFile(path.join(HERE, "assets/app.js"), path.join(DIST, "assets/app.js"));
await copyFile(path.join(HERE, "assets/theme.js"), path.join(DIST, "assets/theme.js"));
// 站点自包含：把两个插件的宣传图与截图一并拷进 dist/，make-bundle.mjs 会以
// base64 嵌进 Worker（见 BINARY_EXT）。图片源在各自仓库的 docs/assets/ 里，
// 这里只放优化过的副本，不引用 GitHub，避免 CSP 放行外域与外链失效。
for (const img of ["promo.jpeg", "shot-config.png", "shot-decisions.png", "shot-flatmap.jpeg"]) {
  await copyFile(path.join(HERE, "assets", img), path.join(DIST, "assets", img));
}

// 中文（默认）与英文各两页；alt 互相指认，hreflang 与导航语言按钮共用。
const ZH_HOME = { lang: "zh-CN", self: "/", alt: { path: "/en/", label: "English" } };
const ZH_PROJ = {
  lang: "zh-CN",
  self: "/dsh-decision-engine/",
  alt: { path: "/en/dsh-decision-engine/", label: "English" },
};
const ZH_FLATMAP = {
  lang: "zh-CN",
  self: "/dsh-model-flatmap/",
  alt: { path: "/en/dsh-model-flatmap/", label: "English" },
};
const EN_HOME = { lang: "en", self: "/en/", alt: { path: "/", label: "中文" } };
const EN_PROJ = {
  lang: "en",
  self: "/en/dsh-decision-engine/",
  alt: { path: "/dsh-decision-engine/", label: "中文" },
};
const EN_FLATMAP = {
  lang: "en",
  self: "/en/dsh-model-flatmap/",
  alt: { path: "/dsh-model-flatmap/", label: "中文" },
};

await writeFile(
  path.join(DIST, "index.html"),
  page(
    "dsh.zuos.us — DeepSeek Harness 插件项目",
    "DeepSeek Harness 插件项目主页：dsh-decision-engine —— 便宜的决策层，在主模型动手前用小的决策模型做结构化判断。",
    indexBody,
    ZH_HOME
  )
);

await writeFile(
  path.join(DIST, "dsh-decision-engine/index.html"),
  page(
    "dsh-decision-engine — 给 DeepSeek Harness 的决策层",
    "便宜的决策层：在主模型动手前，把当前状态与一组结构化问题发给小的决策模型，用它的概率化答案决定放行、询问、拦截、换模型或跳过。八个决策点全部已实装，默认 shadow 只记录不打断。",
    pluginBody,
    ZH_PROJ
  )
);

await writeFile(
  path.join(DIST, "en/index.html"),
  page(
    "dsh.zuos.us — DeepSeek Harness plugin projects",
    "Home of DeepSeek Harness plugin projects: dsh-decision-engine — a cheap judgement layer for DSH.",
    indexBodyEn,
    EN_HOME
  )
);

await writeFile(
  path.join(DIST, "en/dsh-decision-engine/index.html"),
  page(
    "dsh-decision-engine — a judgement layer for DeepSeek Harness",
    "A cheap judgement layer for DeepSeek Harness: sends state plus a set of structured questions to a small decision model and uses the probability-bearing answers to allow, ask, block, reroute or skip. All eight decision points implemented; shadow mode by default.",
    pluginBodyEn,
    EN_PROJ
  )
);

await writeFile(
  path.join(DIST, "dsh-model-flatmap/index.html"),
  page(
    "dsh-model-flatmap — 平铺的 DSH 模型选择器",
    "一个平铺、无二级菜单的 DSH 模型选择器：把会话输入框的 model 控件换成一个平面面板，所有模型与推理等级都在同一平面上，没有层层弹层。跨 provider 全局搜索、按 provider / 按 family 两分组、额度不足自动划删除线，纯浏览器端、零构建。",
    flatmapBody,
    ZH_FLATMAP
  )
);

await writeFile(
  path.join(DIST, "en/dsh-model-flatmap/index.html"),
  page(
    "dsh-model-flatmap — a flat model picker for DeepSeek Harness",
    "A flat, two-level-free model picker for DeepSeek Harness: replaces the composer model control with one surface where every model and reasoning level is visible at once, no nested popovers. Cross-provider search, by-provider / by-family grouping, strike-through on out-of-balance models. Browser-only, no build step.",
    flatmapBodyEn,
    EN_FLATMAP
  )
);

await writeFile(path.join(DIST, "favicon.svg"), favicon);

console.log("built ->", DIST);
