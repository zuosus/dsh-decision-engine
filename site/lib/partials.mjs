// 站点构建期共用的 HTML 片段。纯字符串拼接，无模板引擎。
//
// 图标：插件包里的 icon.svg 是它们自己的资产，站点不改动；这里另画一套
// 站点用的图标（导航品牌 + 两个插件各自的图标），风格统一：渐变描边、
// 平涂、无底砖、36×36 视口、userSpaceOnUse 让同一枚图标里渐变方向一致。

const GRAD = (id) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="3" y1="6" x2="33" y2="30">
      <stop offset="0%" stop-color="#3AC251"/>
      <stop offset="52%" stop-color="#2BAE7E"/>
      <stop offset="100%" stop-color="#1481BF"/>
    </linearGradient>`;

// 品牌：两层叠加的「层」，意思是给 DSH 加一层判断。
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" role="img" aria-label="dsh.zuos.us">
  <defs>${GRAD("brand")}</defs>
  <path d="M18 5.5 31 13 18 20.5 5 13z" fill="url(#brand)"/>
  <path d="M5 19.5 18 27 31 19.5" fill="none" stroke="url(#brand)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" opacity=".78"/>
  <path d="M5 25.5 18 33 31 25.5" fill="none" stroke="url(#brand)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" opacity=".45"/>
</svg>`;

// dsh-decision-engine：一个输入 → 一个判断点 → 三种处置（放行 / 询问 / 拦截）。
const DECISION_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" role="img" aria-label="Decision Engine">
  <defs>${GRAD("de")}</defs>
  <g fill="none" stroke="url(#de)" stroke-width="2.5" stroke-linecap="round">
    <path d="M3 18h7"/>
    <path d="M15 18 23 9.5"/>
    <path d="M15 18h13"/>
    <path d="M15 18 23 26.5"/>
  </g>
  <g fill="url(#de)">
    <circle cx="12.5" cy="18" r="3.4"/>
    <circle cx="25" cy="8" r="2.4"/>
    <circle cx="30" cy="18" r="2.4"/>
    <circle cx="25" cy="28" r="2.4"/>
  </g>
</svg>`;

// dsh-model-flatmap：一块平面上平铺的模型格，没有二级菜单。
const FLATMAP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" role="img" aria-label="Flat model picker">
  <defs>${GRAD("fm")}</defs>
  <rect x="3.5" y="6.5" width="29" height="23" rx="4.5" fill="none" stroke="url(#fm)" stroke-width="2.2"/>
  <g fill="url(#fm)">
    <rect x="7.5" y="11" width="6.5" height="6" rx="1.6"/>
    <rect x="14.75" y="11" width="6.5" height="6" rx="1.6" opacity=".38"/>
    <rect x="22" y="11" width="6.5" height="6" rx="1.6" opacity=".38"/>
    <rect x="7.5" y="20" width="6.5" height="6" rx="1.6" opacity=".38"/>
    <rect x="14.75" y="20" width="6.5" height="6" rx="1.6"/>
    <rect x="22" y="20" width="6.5" height="6" rx="1.6" opacity=".38"/>
  </g>
</svg>`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const THEME_BTN = (aria) => `<button class="theme-btn" type="button" aria-label="${esc(aria)}" title="${esc(aria)}">
      <svg class="i-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      <svg class="i-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>`;

export function nav({ brand = "dsh.zuos.us", links = [], i18n = null, themeAria = "切换主题" } = {}) {
  const items = links
    .map((l) => `<a class="link${l.opt ? " opt" : ""}" href="${l.href}">${esc(l.label)}</a>`)
    .join("\n        ");
  const lang = i18n
    ? `<a class="link i18n-link" href="${i18n.href}" hreflang="${i18n.hreflang}">${esc(i18n.label)}</a>`
    : "";
  return `<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="/">
      ${ICON}
      <span>${esc(brand)}</span>
    </a>
    <div class="nav-spacer"></div>
        ${items}
        ${lang}
        ${THEME_BTN(themeAria)}
  </div>
</header>`;
}

export function footer({ repo = "https://github.com/zuosus/dsh-decision-engine" } = {}) {
  return `<footer>
  <div class="wrap">
    <span>© ${new Date().getFullYear()} zuosus</span>
    <a href="${repo}">GitHub</a>
    <a href="https://www.npmjs.com/package/dsh-decision-engine">npm</a>
    <span>MIT License</span>
  </div>
</footer>`;
}

export function codeBlock(cmd) {
  return `<div class="code-block"><pre><code><span class="pfx">$ </span>${esc(cmd)}</code></pre></div>`;
}

export function table(headers, rows) {
  const th = headers.map((h) => `<th>${h}</th>`).join("");
  const tr = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("\n");
  return `<div class="table-scroll"><table>
<thead><tr>${th}</tr></thead>
<tbody>
${tr}
</tbody>
</table></div>`;
}

/** 站内截图 / 宣传图。图片随站点一起打包，全部走 /assets/ 同源路径。 */
export function figure(src, alt, caption = "") {
  return `<figure class="shot">
  <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">
  ${caption ? `<figcaption>${caption}</figcaption>` : ""}
</figure>`;
}

/** 一行「要点」：左侧短标签 + 右侧说明，取代成排的小卡片。 */
export function fact(label, text) {
  return `<div class="fact"><span class="fact-k">${label}</span><span class="fact-v">${text}</span></div>`;
}

export { ICON, DECISION_ICON, FLATMAP_ICON, esc };
