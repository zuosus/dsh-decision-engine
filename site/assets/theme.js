// 在 <head> 里同步执行：先落 data-theme 再首屏绘制，避免主题闪白（FOUC）。
// 优先级：localStorage 里的显式选择 > 系统 prefers-color-scheme > light。
(function () {
  "use strict";
  var KEY = "dsh-theme";
  try {
    var saved = localStorage.getItem(KEY);
    var t =
      saved === "light" || saved === "dark"
        ? saved
        : window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
