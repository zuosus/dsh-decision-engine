// 极小的交互：命令块一键复制。没有框架，没有构建。
(function () {
  "use strict";

  document.querySelectorAll(".code-block").forEach(function (block) {
    const code = block.querySelector("code");
    if (!code) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "复制";
    btn.setAttribute("aria-label", "复制命令");

    btn.addEventListener("click", async function () {
      const text = code.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        // 剪贴板 API 在非安全上下文里不可用，退回选中文本让用户自己按 ⌘C。
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      btn.textContent = "已复制";
      btn.classList.add("done");
      setTimeout(function () {
        btn.textContent = "复制";
        btn.classList.remove("done");
      }, 1600);
    });

    block.appendChild(btn);
  });

  /* ---------- 主题切换 ---------- */
  const KEY = "dsh-theme";
  const root = document.documentElement;

  function currentTheme() {
    const attr = root.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  document.querySelectorAll(".theme-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY, next);
      } catch (err) {
        /* 隐私模式下写不了 localStorage：本次浏览内仍然生效。 */
      }
    });
  });
})();
