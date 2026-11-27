    async function call(path, init) {
      const response = await fetch(BASE + path, {
        ...init,
        headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (!response.ok) throw new Error(typeof data === "object" ? data.error ?? `HTTP ${response.status}` : String(data));
      return data;
    }

    /**
     * 自动保存的防抖时长：文本框停手多久之后落盘。
     *
     * 太短会把打字过程中的半截值写进 yml（每个字符一次请求），太长则
     * 「改完立刻关掉面板」会丢改动。700ms 是这两者之间的常见折中。
     */
    const AUTOSAVE_DELAY_MS = 700;

    /**
     * 自定义 base URL 的问题描述，空串表示可用。
     *
     * 规则与服务端 `validateProviderPatch` 一致：本地先判，是为了让「打字打到一半
     * 的非法地址」停在本地（显示红字），而不是每停一下就发一次注定 400 的请求。
     *
     * @param rawUrl - 用户填写的地址（未 trim）。
     * @param provider - 当前 provider；只有 custom 时空地址才是「必填缺失」。
     */
    function customUrlProblem(rawUrl, provider) {
      const url = (rawUrl ?? "").trim();
      if (url.length === 0) {
        return provider === "custom" ? "必填：请填写决策服务的 base URL" : "";
      }
      if (/\s/.test(url)) return "不能包含空格或换行";
      if (!/^https?:\/\//i.test(url)) return "必须以 http:// 或 https:// 开头";
      try {
        const parsed = new URL(url);
        if (parsed.search.length > 0) return "不要带查询串（? 之后的部分）";
      } catch {
        return "不是合法地址（示例：https://api.example.com/v1）";
      }
      return "";
    }

    /**
     * 待落盘的决策点改动，没有改动时返回 null。
     *
     * 与 `/decisions` 的 PUT body 同形（`{ points? }`）：
     * 服务端对空 body 直接 400，所以「没改动就不发」必须由调用方保证。
     */
    function pendingDecisions(values, decisions) {
      const changed = {};
      for (const [id, mode] of Object.entries(values.pointsDraft ?? {})) {
        const original = (decisions?.points ?? []).find((item) => item.id === id);
        if (original !== undefined && original.mode !== mode) changed[id] = mode;
      }
      if (Object.keys(changed).length === 0) return null;
      return { points: changed };
    }

    /**
     * 滑块落点上的**短标签**（只有档位名）。
     *
     * 为什么不在落点上带语义尾注（「轻松（只问最前 1%）」）：
     *
     *   - 落点上带尾注时，四段等宽，每段只剩标签本身那点宽度：当年容器还限死
     *     620px，每段只有 ~140px，「轻松（只问最前 1%）」放不下，只能换行或溢出，
     *     而换行会让四个段叠成一团（真机上就是这么坏的）。容器如今不限宽
     *     （DEC-040），但这条不翻案：窗口窄的时候它照样成立。
     *   - 尾注只对**当前档位**有意义：用户要确认的是「我选的这档到底多频繁」，
     *     另外三档的具体比例在他点过去之后才知道就行了。
     *
     * 因此尾注移到轨道**下方那行说明**里（见 toleranceActiveSummary），
     * 落点上只留档位名——这也是分段控件的常规形态。
     *
     * @param preset - 服务端下发的一档元数据。
     * @returns 档位名（已过语言）。
     */
    function toleranceShortLabel(preset) {
      return tr(preset.label ?? preset.id ?? "");
    }

    /**
     * 当前档位的**语义尾注**（轨道下方一行）。
     *
     * 只写「轻松」用户看不出它比默认更少打扰还是更多，所以这一行必须说清
     * 「只问最前 1%」。比例由 `percentile` 算，因此加一档只改 tolerance.js。
     *
     * @param preset - 当前档位元数据。
     * @returns 带比例的说明；不按比例的档位返回其 summary。
     */
    function toleranceActiveSummary(preset) {
      if (preset === null || preset === undefined) return "";
      if (preset.percentile === null || preset.percentile === undefined) {
        return tr(preset.summary ?? "");
      }
      const percent = Math.round((1 - preset.percentile) * 100);
      return t("当前档位只问最前 {percent}% 的调用", { percent });
    }

    /**
     * 人工审核比例滑块——**配置页与决策历史页共用这一个组件**（DEC-035）。
     *
     * 两处放同一个控件不是重复：用户看到「刚才又问我了」的地方（决策历史）
     * 正是他想调频率的地方，而配置页是「这个插件的设定」的正式入口。
     *
     * 组件只做渲染与回调，**不自己发请求**：两处的保存链路完全不同
     * （配置页走自动保存 flush，决策历史页没有那条链路），把 IO 留在调用方，
     * 这个组件才能在两个上下文里都用得上。
     *
     * @param props.tolerance - 服务端下发的 `tolerance` 对象。
     * @param props.level - 当前生效档位（草稿优先）。
     * @param props.onSelect - `(level) => void`，用户点了一个落点。
     * @param props.disabled - 是否禁用（保存进行中）。
     * @param props.compact - 紧凑模式（决策历史页的头部空间更紧）。
     */
    function ToleranceSlider(props) {
      const data = props?.tolerance ?? null;
      const presets = Array.isArray(data?.presets) ? data.presets : [];
      const levels = Array.isArray(data?.levels) && data.levels.length > 0
        ? data.levels
        : presets.map((item) => item.id);
      const current = typeof props?.level === "string" ? props.level : data?.level ?? "default";
      const calibration = data?.calibration ?? null;

      if (levels.length === 0) return null;

      // 四档是一组 **iOS 式分段按钮**（DEC-088 去掉贯穿圆点的横线，DEC-095 把
      // 四个独立线框按钮合并成一整块控件）：整组共一条外框，段与段挨着，
      // 段间只有分隔线，选中段反色且两侧分隔线隐去。形状与行为的对应关系
      // 不变——四档是同一条轴上的相邻取值，所以画成一个控件而不是四个。
      // 颜色、边框、圆角、分隔线全部由 client.config.css 的
      // `.de-tolerance__*` 规则承担（走宿主语义令牌，明暗主题自动跟随）。
      const stops = levels.map((id) => {
        const preset = presets.find((item) => item.id === id)
          ?? { id, label: id, labelEn: id, percentile: null };
        const active = id === current;
        return h(
          "button",
          {
            type: "button",
            key: `tol-${id}`,
            className: "de-tolerance__stop",
            disabled: props?.disabled === true,
            title: tr(preset.summary ?? ""),
            "aria-pressed": active,
            onClick: () => {
              if (active || props?.disabled === true) return;
              props?.onSelect?.(id);
            },
          },
          toleranceShortLabel(preset),
        );
      });

      /**
       * 校准脚注：只在「这一档真的按比例走」时才说分位数。
       *
       * 自治 / 默认两档不按比例（`percentile === null`），此时说「校准中」
       * 会让用户以为它还没生效——而它本来就该用模型自己的判断。
       */
      let note = "";
      if (calibration !== null && typeof calibration === "object") {
        const preset = presets.find((item) => item.id === current);
        if (preset?.percentile === null || preset?.percentile === undefined) {
          note = current === "autonomous"
            ? t("自治档不按比例：从不询问用户")
            : t("这一档沿用决策模型自己的判断，不需要校准");
        } else if (calibration.ready === true && typeof calibration.threshold === "number") {
          note = t("已按这个模型校准：最前的 {percent}% ≈ 严重度 {threshold}（{samples} 个样本）", {
            percent: Math.round((1 - preset.percentile) * 100),
            threshold: calibration.threshold.toFixed(3),
            samples: calibration.samples ?? 0,
          });
        } else {
          note = t("校准中 {samples}/{min} 次授权决策（当前用冷启动阈值 {fallback}）", {
            samples: calibration.samples ?? 0,
            min: calibration.minSamples ?? 50,
            fallback: typeof calibration.fallbackSeverity === "number"
              ? calibration.fallbackSeverity.toFixed(2)
              : "—",
          });
        }
      }

      const activePreset = presets.find((item) => item.id === current) ?? null;
      const activeSummary = toleranceActiveSummary(activePreset);

      return h(
        "div",
        { className: "de-tolerance", style: { marginTop: props?.compact === true ? "6px" : "4px" } },
        h(
          "div",
          { className: "de-tolerance__stops" },
          ...stops,
        ),
        // 当前档位的语义（带比例）：它取代了原本挤在落点上的尾注。
        activeSummary.length > 0
          ? h("div", { style: { ...S.pointHint, marginTop: "8px", opacity: 0.78 } }, activeSummary)
          : null,
        note.length > 0
          ? h("div", { style: { ...S.pointHint, marginTop: "3px", opacity: 0.55 } }, note)
          : null,
        // 两条总则合成一行：拆成两行会在配置页占掉太多纵向空间，而它们
        // 是「前提」而不是「主信息」，挤在一行里读起来仍然成立。
        h(
          "div",
          { style: { ...S.pointHint, marginTop: "3px", opacity: 0.42 } },
          t("分位数窗口按 provider × model 分开，换模型会重新校准；高风险调用一律直接拦下（四档一致）"),
        ),
      );
    }

    /**
     * provider 的展示文案：中文取 `label` / `hint`，英文取 `labelEn` / `hintEn`。
     *
     * 这两栏都由服务端从 `providers.json` 原样下发，所以新增一家服务只要在
     * JSON 里写好中英两份文案，两种界面都自动正确——不必再来本文件补词典
     * （补漏一行就是「英文界面里夹一句中文」，而这类漏词只有真渲染才看得见）。
     * 老服务端只下发中文时回落到中文，行为与改前一致。
     *
     * @param item - providerCatalog 的条目。
     * @param key - `"label"` 或 `"hint"`。
     */
    function providerText(item, key) {
      if (item === null || item === undefined) return "";
      const zh = typeof item[key] === "string" ? item[key] : "";
      if (lang === "zh") return zh;
      const en = item[`${key}En`];
      return typeof en === "string" && en.length > 0 ? en : zh;
    }

    /**
     * 当前 provider 的字段名与模型策略。
     *
     * **全部由服务端下发**（`providerCatalog` 的 `modelField` / `keyField` /
     * `requiresModel` / `models`），前端不抄一份。理由与 provider 下拉
     * 那条一致：名字只有 providers.json 的 provider 清单知道，前端再写一份就是
     * 「界面显示存到 A、实际写进 B」这种最难自查的偏差。
     *
     * @param providerId - 当前 provider 的 id。
     * @param view - `/status` 回显。
     * @returns catalog 条目；拿不到（状态未加载）时返回 null。
     */
    function providerFieldsOf(providerId, view) {
      const item = (view?.providerCatalog ?? []).find((row) => row.id === providerId);
      // 字段名是写回配置的前提，少了它宁可不写——见 flush() 里的延后处理。
      if (item === undefined || typeof item.modelField !== "string" || typeof item.keyField !== "string") {
        return null;
      }
      return item;
    }

    /**
     * 各模型字段的原值，键就是 config.yml 里的字段名。
     *
     * 服务端下发 `rawModels`（按字段名）；老服务端只有三个散字段，
     * 一并并入，于是「回显」与「比较有没有改动」都只有一种写法，
     * 不会因为少了一格而漏判改动（漏判 = 改了不保存 = 静默）。
     */
    function rawModelsOf(view) {
      return {
        model: view?.rawModel ?? "",
        systemoneModel: view?.rawSystemoneModel ?? "",
        customModel: view?.customModel ?? "",
        ...(view?.rawModels ?? {}),
      };
    }

    /**
     * 由 `/status` 回显派生**整份草稿**——这是唯一一处这样的派生。
     *
     * 为什么必须收敛成一处：草稿的三个来源（首屏兜底、`refresh()` 拉到状态、
     * 保存成功后的 `applyServerState()`）此前各写了一份字段表，漏一项的表现
     * 分两种，两种都很糟：
     *
     *   1. **控件回显错**。某处漏了 `telemetryLevel`，控件读到的就是兜底值
     *      `daily`——用户把匿名统计关掉、存好了、退出配置页再进来，下拉又
     *      显示 daily（用户反馈，长期存在的 bug）。
     *   2. **保存静默改值**。`configPatchOf` 里 `draft.telemetryLevel ?? "daily"`
     *      同样是兜底：草稿没有这一项时，用户改任何一个**无关**开关都会把
     *      `telemetryLevel: daily` 一并提交，服务端照写——已经关掉的隐私开关
     *      被一次无关的保存重新打开。所以这从来不只是「显示问题」。
     *
     * 加字段时只改这里，三处调用自动跟上。
     *
     * `tolerance` 是**有条件下发**的（服务端要算校准分位，可能整块缺席），
     * 因此只有真的拿到 `level` 才写进草稿：写死一个 `default` 会让 patch 在
     * 「服务端没下发」时把用户存好的档位覆盖成默认（见 configPatchOf 里的
     * 注释）。
     *
     * @param view - `/status` 回显，或状态未加载时的兜底对象（形状相同）。
     */
    function draftFromStatus(view) {
      return {
        enabled: view?.enabled === true,
        mode: view?.mode ?? "shadow",
        thinkMode: view?.thinkMode ?? "never",
        // 匿名统计档位（DEC-020）：必须回显生效值，否则下拉永远停在 daily。
        telemetryLevel: view?.telemetryLevel ?? "daily",
        // 决策历史（DEC-022）：服务端缺省 = 开。
        decisionsTabEnabled: view?.decisionsTabEnabled !== false,
        // 审批卡正文可读化（DEC-042 / DEC-043）：服务端缺省 = 开。
        approvalDetailReadable: view?.approvalDetailReadable !== false,
        // 危险权限申请交决策模型（DEC-089）：服务端缺省 = 关。
        // 用 `=== true` 而不是 `!== false`：这一项默认关，把 undefined
        // 折算成「开」会让首次进来就把界面画成已开启（而服务端其实没开）。
        dangerFullAccessDecider: view?.dangerFullAccessDecider === true,
        // 跟随服务端下发（DEC-030）：缺省 = 关。
        serverProvider: view?.serverProvider?.enabled === true,
        // 免费模型兜底：缺省 = 关。
        backupModel: view?.backupModel?.enabled === true,
        ...(typeof view?.tolerance?.level === "string" ? { tolerance: view.tolerance.level } : {}),
        // 模型各 provider 一格：键就是 config.yml 里的字段名。
        ...rawModelsOf(view),
      };
    }

    /**
     * 由 `/status` 回显派生 provider 草稿。
     *
     * 与 `draftFromStatus` 同一个理由：这五个字段也在三处各写了一份，漏一项
     * 就是「保存后再打开，自定义地址 / 请求头自己变空」。模型**不在这里**——
     * 它跟模型行走（见 rawModelsOf）。
     */
    function providerDraftFromStatus(view) {
      return {
        provider: view?.provider ?? "systemone",
        customBaseUrl: view?.customBaseUrl ?? "",
        customEndpointStyle: view?.customEndpointStyle ?? "auto",
        customHeaders: view?.customHeaders ?? "",
        customApiKeyEnv: view?.customApiKeyEnv ?? "",
      };
    }

    /**
     * 由「当前值」拼出 `/config` 的 PUT patch。
     *
     * 与旧版「点保存」时提交的内容逐字一致，只是取值来源从渲染闭包换成了
     * `valuesRef`（setState 是异步的，自动保存必须读到刚改完的值）。
     *
     * @param values - `{ draft, providerDraft, keyInputs, storageDraft }`。
     * @param keyCommit - 用户明确提交密钥的 provider（失焦/回车），否则 null。
     * @param modelFields - 当前 provider 的字段（providerFieldsOf 结果，非 null）。
     * @param keyFields - 提交密钥的那个 provider 的字段；本次没提交时为 null。
     */
