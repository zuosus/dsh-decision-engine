    /**
     * 分组元数据：id → { title, tone }。
     *
     * tone 决定图标底色与正文竖线的颜色，四组各一色：
     *   business（连接方式）/ warn（守卫行为）/ success（记录与展示）/ neutral（模型与统计）。
     *
     * 为什么最后一组是 neutral 而不是第四种色：四组里三组已经是
     * 「强调 / 警示 / 正向」这三档语义色，再加一档等于把颜色当成
     * 装饰。第四组是「调优与诊断」，中性最贴切——它的颜色不该读成
     * 任何一种状态。
     */
    const SECTION_META = {
      connection: { title: "连接方式", tone: "business" },
      guard: { title: "守卫行为", tone: "warn" },
      record: { title: "记录与展示", tone: "success" },
      model: { title: "模型与统计", tone: "neutral" },
    };

    /** 分组展开状态在 localStorage 里的键。 */
    const SECTION_OPEN_KEY = "dsh-decision-engine:cfg-sections";

    /**
     * 读出上次的展开状态。
     *
     * 读不到（隐私模式 / 首次访问 / 解析失败）时回落到默认值：
     * **第一组默认展开，其余收起**。理由是「连接方式」是第一次进来
     * 最可能要动的那一组，而守卫与模型那些项设一次就忘，铺开只是
     * 加长页面。
     */
    const readSectionOpen = () => {
      const fallback = { connection: true, guard: false, record: false, model: false };
      try {
        if (typeof localStorage === "undefined") return fallback;
        const raw = localStorage.getItem(SECTION_OPEN_KEY);
        if (typeof raw !== "string" || raw === "") return fallback;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return fallback;
        const out = {};
        for (const id of Object.keys(SECTION_META)) {
          out[id] = parsed[id] === true;
        }
        return out;
      } catch {
        return fallback;
      }
    };

    /** 把展开状态写回 localStorage。写不进去（配额满 / 隐私模式）就忽略。 */
    const writeSectionOpen = (next) => {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(SECTION_OPEN_KEY, JSON.stringify(next));
      } catch {
        /* 写不进去不影响使用：本次会话内仍然折叠正常 */
      }
    };

    // 展开状态的读写挂在 `i18n` 探针上：渲染测试需要一个口来验证
    // 「记住了上次的选择」这条行为，而模拟 `document` + 重渲染只为测
    // 两个纯函数不值当。与 `tr` / `t` 挂在一起，控制台排查时也在同一处。
    i18n.readSectionOpen = readSectionOpen;
    i18n.writeSectionOpen = writeSectionOpen;
    i18n.SECTION_OPEN_KEY = SECTION_OPEN_KEY;
    i18n.SECTION_META = SECTION_META;

    /**
     * 分组图标（DEC-051）：折叠状态下也要一眼认出这一组是什么。
     *
     * 为什么自己画 SVG 而不用图标库：本插件的 `client.js` 不注入
     * `@deepseek-ai/dsh-client-ui-primitives`，多引一个包就多一份宿主
     * 版本耦合；这四个图形是纯装饰（`aria-hidden`），自己画几行 path
     * 就够，也免得宿主换图标集时形状突变。
     *
     * 形状按语义选，不是随手配的：
     *   - business（连接方式）：插头——连到哪儿；
     *   - warn（守卫行为）：盾牌——拦不拦；
     *   - success（记录与展示）：书页——记不记；
     *   - neutral（模型与统计）：滑块——调什么参数。
     */
    function SectionIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 14;
      const tone = props?.tone;
      // 描边属性是四条 path 共用的：抽出来只写一次，改线宽只改这里。
      const stroke = {
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      };
      // 每个图形是一组 <path>/<circle>，用 key 保证同一 tone 下重绘稳定。
      const paths = {
        // 插头：两个脚 + 一个身（「连到哪儿」）。
        business: [
          h("path", { key: "a", ...stroke, d: "M6 2v4M10 2v4" }),
          h("path", { key: "b", ...stroke, d: "M4 6h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4z" }),
          h("path", { key: "c", ...stroke, d: "M8 13v2" }),
        ],
        // 盾牌：中间一道竖线（守卫的「拦截」语义）。
        warn: [
          h("path", { key: "a", ...stroke, d: "M8 2l5 2v4c0 3-2.2 5.3-5 6-2.8-.7-5-3-5-6V4z" }),
          h("path", { key: "b", ...stroke, d: "M8 6v4" }),
        ],
        // 书页：翻开的纸（「记不记」）。
        success: [
          h("path", { key: "a", ...stroke, d: "M2.5 3.5A1.5 1.5 0 0 1 4 2h3.5v11H4a1.5 1.5 0 0 0-1.5 1.5z" }),
          h("path", { key: "b", ...stroke, d: "M13.5 3.5A1.5 1.5 0 0 0 12 2H8.5v11H12a1.5 1.5 0 0 1 1.5 1.5z" }),
        ],
        // 滑块：两条轨道 + 两个把手（「调什么参数」）。
        neutral: [
          h("path", { key: "a", ...stroke, d: "M2.5 5.5h11M2.5 10.5h11" }),
          h("circle", { key: "b", ...stroke, cx: 6, cy: 5.5, r: 1.8 }),
          h("circle", { key: "c", ...stroke, cx: 10.5, cy: 10.5, r: 1.8 }),
        ],
      };
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" },
        },
        ...(paths[tone] ?? paths.neutral),
      );
    }

