// 站点构建期共用的 HTML 片段。纯字符串拼接，无模板引擎。

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Decision Engine">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3AC251"/>
      <stop offset="55%" stop-color="#2BAE7E"/>
      <stop offset="100%" stop-color="#1481BF"/>
    </linearGradient>
  </defs>
  <g transform="translate(4 4) scale(2)">
    <rect x="3" y="10" width="3.2" height="16" rx="1.6" fill="url(#g)"/>
    <rect x="8" y="4" width="3.2" height="22" rx="1.6" fill="url(#g)"/>
    <rect x="13" y="0" width="3.2" height="26" rx="1.6" fill="url(#g)"/>
    <rect x="18" y="6" width="3.2" height="20" rx="1.6" fill="url(#g)"/>
    <rect x="23" y="12" width="3.2" height="14" rx="1.6" fill="url(#g)"/>
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

export { ICON, esc };
