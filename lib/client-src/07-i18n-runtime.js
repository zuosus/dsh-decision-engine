    /**
     * 把任意宿主/浏览器语言标号归一到 `zh` | `en`。
     *
     * 只有两种语言，所以规则是「带 zh 前缀算中文，其余算英文」：宿主将来
     * 加第三种语言时，本面板继续显示英文而不是回落到中文。
     */
    function normalizeLang(value) {
      if (typeof value !== "string" || value === "") return null;
      const id = value.toLowerCase().replace(/_/g, "-");
      return id === "zh" || id.startsWith("zh-") ? "zh" : "en";
    }

    /**
     * 设置界面语言。
     *
     * `force === true` 时即使值没变也通知一遍：宿主刚注册完字典、面板已经
     * 渲染过一次的情况下，需要一次重绘把新词表用上去。
     */
    function setLang(next, force) {
      const normalized = normalizeLang(next) || "zh";
      const changed = normalized !== lang;
      lang = normalized;
      if (!changed && force !== true) return;
      for (const notify of langListeners) {
        try {
          notify();
        } catch {
          /* 某个组件已经卸载：忽略，不影响其他订阅者 */
        }
      }
    }

    /** 中文 → 当前语言。只认整段命中。 */
    function tr(text) {
      if (typeof text !== "string" || text === "" || lang === "zh") return text;
      const hit = EN[text];
      return typeof hit === "string" ? hit : text;
    }

    /**
     * 参数化文案：先按模板查英文，再把 `{name}` 填回去。
     *
     * 填进去的值也过一遍 `tr`：统计页的「按「{label}」排序」里 label 是
     * 中文列名，不翻译会翻出「Sort by “总耗时”」这种半英半中的句子。
     */
    function t(template, params) {
      let text = template;
      if (lang !== "zh") {
        const hit = T[template] ?? EN[template];
        if (typeof hit === "string") text = hit;
      }
      if (params === undefined || params === null) return text;
      return text.replace(/\{(\w+)\}/g, (all, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? tr(String(params[key])) : all,
      );
    }

    /**
     * 会被翻译的文本类属性。
     *
     * 只列白名单，不做「凡是字符串都翻」：`value` / `href` / `style` 这些
     * 属性里的字符串是数据或标识，翻了就改坏行为。
     */
    const TRANSLATED_PROPS = new Set(["title", "placeholder", "alt", "aria-label", "label"]);

    function translateProps(props) {
      if (!props || typeof props !== "object") return props;
      let changed = false;
      const next = {};
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (typeof value === "string" && TRANSLATED_PROPS.has(key)) {
          const text = tr(value);
          next[key] = text;
          if (text !== value) changed = true;
        } else {
          next[key] = value;
        }
      }
      return changed ? next : props;
    }

    function translateChild(child) {
      if (typeof child === "string") return tr(child);
      if (Array.isArray(child)) return child.map(translateChild);
      return child;
    }

    /**
     * 渲染入口：`createElement` 的翻译包装。
     *
     * 组件里照旧写中文，文本一落到虚拟 DOM 就按当前语言换一次；`t()` 的
     * 结果也会经过这里，但英文串不在词典里，等于原样通过。
     */
    function h(type, props, ...children) {
      // 中文界面下 `tr()` 是恒等函数（开头 `lang === "zh"` 直接返回原文），
      // 因此 `translateProps` 必然原样返回 props、`translateChild` 必然原样
      // 返回每个 child——但两者仍会：`Object.keys(props)` 建一个键数组、
      // `props` 有文本属性时建一份副本、`children.map()` 建一个新数组。
      // 一次决策历史渲染是三千多个元素，这些全是纯垃圾。
      //
      // `lang` 是模块级可变状态（切语言会改它），所以这个判断必须**每次调用
      // 现读**，不能在加载时固化。
      if (lang === "zh") {
        return children.length === 0
          ? createElement(type, props)
          : createElement(type, props, ...children);
      }
      return createElement(type, translateProps(props), ...children.map(translateChild));
    }

    /**
     * 订阅语言变化的钩子。
     *
     * 返回值没有用于取值渲染（`tr` 读的是模块级 `lang`），它的**唯一作用是
     * 在宿主切语言时把这个组件重绘一次**。所以调用位置固定在所有
     * `useState` 之后——测试用「useState 第 n 个槽位」注入状态，多插一个
     * 槽位会把后面的槽位全部挪位。
     */
    function useLang() {
      const [value, setValue] = react.useState(lang);
      react.useEffect(() => {
        const notify = () => setValue(lang);
        langListeners.add(notify);
        notify();
        return () => {
          langListeners.delete(notify);
        };
      }, []);
      return value;
    }

    /**
     * 读宿主语言。
     *
     * 宿主的 `locale` 服务（dsh-client-locale）挂着 LocaleFace：
     * `getSnapshot()` 返回冻结的 `{ active, locales, revision }`，
     * active 就是生效中的 locale id（内置只有 `"zh"` 与 `"en"`）。
     * 读不到快照时退回试直接属性——宿主各版本未必都装好了 face。
     */
    function readHostLang(ctx) {
      const locale = ctx && ctx.locale;
      if (!locale) return null;
      const candidates = [];
      try {
        const snapshot = typeof locale.getSnapshot === "function" ? locale.getSnapshot() : null;
        if (snapshot) candidates.push(snapshot.active, snapshot.locale);
      } catch {
        /* 快照不可用：继续试直接属性 */
      }
      candidates.push(locale.active, locale.current, locale.language, locale.locale);
      for (const candidate of candidates) {
        const normalized = normalizeLang(typeof candidate === "function" ? candidate() : candidate);
        if (normalized) return normalized;
      }
      return null;
    }

    /**
     * 跟随宿主语言变化。
     *
     * `ctx.locale.subscribe(fn)` 在**每次快照变化**时回调（切语言与注册词典
     * 都会推进 revision），返回值就是退订函数——正是本函数要 yield 给
     * cordis 的 disposer。备用通道 `ctx.on("locale/change", fn)` 只在切换时
     * 发（词典注册不发），payload 是同一个快照；老宿主没有 subscribe 时靠它。
     *
     * 注意：回调里不用 force——setLang 只在语言真的变了才通知，宿主启动时
     * 注册词典引起的几次快照变化不值得整页重绘。
     *
     * @returns 撤销订阅的函数（没有订阅时是空函数）
     */
    function watchHostLang(ctx) {
      const apply = () => setLang(readHostLang(ctx) ?? browserLang());
      const locale = ctx && ctx.locale;
      if (!locale) return () => {};
      const disposers = [];
      try {
        if (typeof locale.subscribe === "function") {
          const result = locale.subscribe(apply);
          if (typeof result === "function") disposers.push(result);
        }
      } catch {
        /* 不支持 subscribe：继续试事件 */
      }
      try {
        if (typeof ctx.on === "function") {
          const result = ctx.on("locale/change", apply);
          if (typeof result === "function") disposers.push(result);
        }
      } catch {
        /* 不支持事件：到此为止 */
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 撤销失败不影响其余订阅 */
          }
        }
      };
    }

    /** 浏览器语言：宿主没给语言时的依据（与宿主的 zh/en 二分口径一致）。 */
    function browserLang() {
      try {
        const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
        for (const item of list) {
          const normalized = normalizeLang(item);
          if (normalized) return normalized;
        }
      } catch {
        /* 没有 navigator（Node 里的渲染测试）：按中文 */
      }
      return "zh";
    }

    /* i18n 内部状态：给测试与浏览器控制台留的口。 */
