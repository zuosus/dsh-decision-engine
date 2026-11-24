      const deleteKey = async () => {
        const id = providerDraft.provider;
        // 不从后面的 `catalog` 取：它在这段之后才声明，事件里引用会踩暂时性死区。
        const providerList = Array.isArray(view.providerCatalog) ? view.providerCatalog : [];
        const item = providerList.find((entry) => entry.id === id) ?? null;
        const label = item !== null ? providerText(item, "label") : id;
        const confirmed = typeof globalThis.confirm === "function"
          ? globalThis.confirm(t("确定删除 {provider} 的 API Key 吗？此操作不可撤销。", { provider: label }))
          : true;
        if (confirmed !== true) return;
        setBusy("deleteKey");
        setMsg(null);
        try {
          const next = await call("/config/key", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: id }),
          });
          // 服务端的 keyStatus 已更新：用它重画「已配置 / 未配置」，不能只靠
          // 本地猜——凭据文件与 config.yml 两处的状态只有服务端算得准。
          applyServerState(next);
          // 输入框里可能还留着删掉的那把 key（用户粘贴过但没失焦）：清空，
          // 否则下一次随便改一项保存时又被写回去。
          setKeyInputs((previous) => {
            const fresh = { ...previous };
            delete fresh[id];
            return fresh;
          });
          setMsg({ ok: true, text: t("已删除 {provider} 的 API Key", { provider: label }) });
        } catch (error) {
          setMsg({ ok: false, text: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy("");
        }
      };

      /**
       * 一行：左标题+说明，右控件。
       *
       * 第 5 个参数 `note` 是**可选**的：一行更小、更淡的补充说明，渲染在
       * 说明（hint）下面。它是给「这句话是风险声明、不属于正文说明」用的
       * ——例如「使用免费模型」下面的「可能会失效」：它是这件事的代价，
       * 与「这个开关干什么」不是同一层信息，压成同一段会让人读漏。
       * 不给 note 时行为与之前逐字一致（向后兼容，老调用点不用改）。
       */
      const row = configRow;

      /* ------------------------------------------------------------
       * 分组折叠（DEC-051）
       *
       * 形状参考 @xbzbing/dsh-git-panel 的插件配置页：
       *   - 标题是一行**按钮**（整行可点），右边一个 chevron 指示开合；
       *   - 标题左边一个 24px 的色块图标，色块颜色 = 这一组的语义色；
       *   - 正文挂在标题下面，左侧有一条同色的竖线，把「下面这些行属于
       *     这一组」这件事画出来。
       *
       * 折叠状态**记在 localStorage**：用户关掉「守卫行为」这一组，
       * 下次打开面板不该又弹回来。这一组的状态是纯 UI 偏好，不该
       * 跟配置一起落盘（config.yml 是给别的进程读的）。
       * ------------------------------------------------------------ */

      /**
       * 渲染一个可折叠分组。
       *
       * @param id - 分组 id（同时是 localStorage 里的键）。
       * @param title - 分组标题（中文源文案，渲染边界翻译）。
       * @param tone - 语义色：business / warn / success / neutral。
       * @param items - 这一组的正文元素数组。
       */
      const sectionBlock = (id, tone, title, items) => {
        const open = sectionOpen[id] === true;
        const bodyId = `de-cfg-sec-${id}`;
        return h(
          "section",
          {
            key: `section-${id}`,
            className: `de-cfg__section de-cfg__section--${tone}`,
            "data-section": id,
          },
          // 标题行：整行可点，按钮语义（aria-expanded / aria-controls）。
          h(
            "button",
            {
              type: "button",
              key: "hd",
              className: "de-cfg__section-hd",
              "aria-expanded": open ? "true" : "false",
              "aria-controls": bodyId,
              onClick: () => {
                const next = { ...sectionOpen, [id]: !open };
                setSectionOpen(next);
                writeSectionOpen(next);
              },
            },
            h(
              "span",
              { key: "left", className: "de-cfg__section-left" },
              // 色块图标：折叠状态下也能一眼认出这一组是什么。
              h(
                "span",
                {
                  key: "ic",
                  className: `de-cfg__section-ic de-cfg__section-ic--${tone}`,
                  "aria-hidden": "true",
                },
                h(SectionIcon, { tone, size: 14 }),
              ),
              h("span", { key: "t" }, title),
            ),
            // chevron：闭合时朝右，展开时转 90° 朝下。旋转**只由 CSS 类**决定
            // （`.de-cfg__chevron--open`），否则两态长得一样，指示就失效了。
            // 纯装饰，语义由 aria-expanded 承担。
            h(
              "span",
              {
                key: "chevron",
                className: `de-cfg__chevron${open ? " de-cfg__chevron--open" : ""}`,
                "aria-hidden": "true",
              },
              "›",
            ),
          ),
          // 正文：折叠时是 `hidden`（不是卸载），这样控件的草稿值不会丢。
          h(
            "div",
            {
              key: "body",
              id: bodyId,
              className: "de-cfg__section-body",
              hidden: open ? undefined : true,
            },
            ...items,
          ),
        );
      };

      /** 开关：仿内置样式（轨道 + 圆点）。 */
      const toggle = (on, onClick) =>
        h(
          "button",
          {
            type: "button",
            onClick,
            disabled: busy !== "",
            style: {
              ...S.track,
              background: on ? "rgba(74,222,128,.55)" : "rgba(128,128,128,.28)",
            },
            "aria-pressed": on,
          },
          h("span", {
            style: { ...S.knob, transform: on ? "translateX(16px)" : "translateX(0)" },
          }),
        );

      /**
       * 密钥保存位置：用户改过就用草稿，否则用服务端的值。
       *
       * 默认 credentials —— 与 DSH 其他服务统一托管，不必在插件目录留第二份明文。
       */
      const storageValue = storageDraft ?? view.keyStorage ?? "credentials";

      // 每个 provider 自己的 key 状态（服务端下发的 keyStatus）。
      const keyStatusOf = (id) => (view.keyStatus ?? {})[id] ?? null;
      const activeKeyStatus = keyStatusOf(providerDraft.provider);
      const keyOk = activeKeyStatus !== null ? activeKeyStatus.configured === true : view.keyConfigured === true;

      /** provider 预设清单（服务端下发；拿不到时只显示当前项）。 */
      const catalog = Array.isArray(view.providerCatalog) ? view.providerCatalog : [];
      const activeProvider = catalog.find((item) => item.id === providerDraft.provider) ?? null;
      // 「自己填地址」的那一个由服务端下发的 `customizable` 标记，不按 id 猜：
      // 数据文件里改标记就自动跟着变。状态未到时回落到历史 id。
      const isCustom =
        activeProvider !== null ? activeProvider.customizable === true : providerDraft.provider === "custom";

      /**
       * 模型字段按 provider 分派：字段名叫什么由服务端下发（`modelField`），
       * 前端不再逐个 provider 写 if/else——否则新增预设就得同步改前端，
       * 漏改就是「A 的模型名写进了 B 的格子」。
       *
       *   systemone        -> systemoneModel
       *   siliconflow      -> siliconflowModel
       *   siliconflow-intl -> siliconflowIntlModel
       *   duanyan          -> duanyanModel
       *   perplexity      -> perplexityModel
       *   openrouter      -> openrouterModel
       *   decisionmodels  -> decisionModelsModel
       *   custom           -> customModel
       *
       * 各格分开存，切换 provider 才不会把 A 的模型名发给 B。
       */
      const activeFields = providerFieldsOf(providerDraft.provider, view);
      const modelField = activeFields?.modelField ?? "model";
      const modelValue = draft[modelField] ?? "";
      const setModelValue = (value) => {
        const next = { ...draft, [modelField]: value };
        setDraft(next);
        // 下拉是离散控件：选完即存。
        scheduleSave({ draft: next }, true);
      };

      /**
       * 展示用的错误文案：本地保存失败的提示优先，其次是服务端回报的
       * 「当前配置不可用」。后者必须能在首帧就显示——它是升级后配置坏掉的
       * 唯一线索，等用户点一次保存才出现就太晚了。
       */
      const providerErrorText =
        providerError.length > 0
          ? providerError
          : view.providerValid === false
            ? view.providerError ?? "当前 provider 配置不可用"
            : "";

      /**
       * 本地预校验：与服务端同规则（见模块级 `customUrlProblem`），
       * 只是为了让用户在落盘之前就看到问题。服务端仍会独立校验（前端校验不可信）。
       */
      const customUrlError = isCustom ? customUrlProblem(providerDraft.customBaseUrl, "custom") : "";

      /** provider 提示文案：优先用服务端下发的说明，避免前端另写一份。 */
      const providerHint =
        loading === true
          ? "正在读取服务端配置…"
          : activeProvider === null
            ? "服务端未返回 provider 列表；当前选择仍会生效"
            : isCustom
              ? "自定义决策服务：自建 llama.cpp / vLLM、企业网关或第三方中转"
              : providerText(activeProvider, "hint");

      /**
       * 服务提供方的 grid 线框按钮（DEC-082）。
       *
       * 用一组 `button[aria-pressed]` 取代原来的 `<select>`：一眼能看见全部
       * 服务商、谁被选中、谁已经配过 key，切换一下就落盘。按钮放在标题与
       * 说明之间，说明会随当前选择变化，正好在按钮下方解释刚选的那家。
       *
       * 「已配置的 provider 在按钮右侧用小字标出」用的是服务端下发的
       * `keyStatus`：明文不回传，凭据文件 / config.yml / 环境变量三个来源
       * 只有服务端算得准，与「删除配置」行用的是同一份判断（见 keyOk）。
       */
      const selectProvider = (id) => {
        if (id === providerDraft.provider || busy !== "") return;
        const next = { ...providerDraft, provider: id };
        setProviderDraft(next);
        // 切换 provider 只改「当前用哪个」，不动其它 provider 已保存的值：
        // custom 的字段留在 providerDraft 里，切回来还在。
        setProviderError("");
        // 离散控件：选完即存。切到 custom 但地址还没填时，flush 会整笔延后
        // 并提示（见 flush 里的 urlProblem），地址补全后自动落盘。
        scheduleSave({ providerDraft: { ...providerDraft, provider: id } }, true);
      };
      const providerGrid = h(
        "div",
        {
          className: "de-cfg__provider-grid",
          role: "group",
          "aria-label": t("服务提供方"),
          key: "provider-grid",
        },
        ...(catalog.length === 0
          ? [
              h(
                "button",
                {
                  type: "button",
                  key: providerDraft.provider,
                  "aria-pressed": true,
                  disabled: true,
                  onClick: () => {},
                },
                providerDraft.provider,
              ),
            ]
          : catalog.map((item) => {
              const selected = item.id === providerDraft.provider;
              const configured = (() => {
                const status = (view.keyStatus ?? {})[item.id];
                return status !== undefined && status !== null ? status.configured === true : false;
              })();
              return h(
                "button",
                {
                  type: "button",
                  key: item.id,
                  "aria-pressed": selected,
                  disabled: busy !== "",
                  onClick: () => selectProvider(item.id),
                  title: providerText(item, "hint"),
                },
                h("span", { className: "de-cfg__provider-grid-name" }, providerText(item, "label")),
                configured
                  ? h("span", { className: "de-cfg__provider-grid-key" }, t("已配置Key"))
                  : null,
              );
            })),
      );

      /**
       * 「使用免费模型」那一行的说明（DEC-030，DEC-037 改名）。
       *
       * 各状态都要**说清现在到底在用谁**：用户最怕的是「界面说已生效、实际
       * 打的是本地旧地址」这类静默偏差，所以 ready 状态把地址、模型与密钥
       * 末四位都摆出来，不可用时明确写「已回落到本地手动配置」。
       *
       * 为什么不用顶层 `view.keyHint`：顶层回传的是**生效值**，服务端不生效
       * 时它就是本地 key 的末四位——两把 key 挤在同一字段里，提示会指向错的
       * 那一把。这里只认 `serverProvider.keyHint`。
       */
      const serverHint = (() => {
        const sp = view.serverProvider ?? {};
        if (sp.enabled !== true) return t("关闭：使用下方的本地配置（与现在完全一致）");
        if (sp.status === "ready") {
          const model =
            typeof sp.model === "string" && sp.model.length > 0 ? sp.model : t("自动（服务端默认）");
          const when = formatLocalMs(sp.fetchedAt);
          return (
            t("服务端下发：{baseUrl} · 模型 {model} · 密钥 {hint}", {
              baseUrl: sp.baseUrl ?? "",
              model,
              hint: sp.keyHint || t("未下发"),
            }) + (when.length > 0 ? t(" · 获取于 {time}", { time: when }) : "")
          );
        }
        if (sp.status === "idle") return t("尚未获取（保存后自动获取）");
        if (sp.status === "loading") return t("正在获取…");
        const reason =
          typeof sp.error === "string" && sp.error.length > 0
            ? tr(sp.error)
            : t("尚未获取（保存后自动获取）");
        return (
          t("服务端不可用：{error}；已回落到本地手动配置", { error: reason }) +
          (sp.expired === true ? t("（服务端下发的值已过期）") : "")
        );
      })();

      /**
       * 模型行（DEC-031 反馈）：
       *
       *   - 内置预设：留在通用区域（预设的默认模型由插件兜底，「自动」语义明确）；
       *   - custom：**移入下方「自定义 provider」区**——模型清单来自用户自己的
       *     服务，与 Base URL / 端点风格是一组的；放在通用区域会让人以为
       *     「自动」也是插件兜底的，而自定义服务不一定有默认模型，「自动」
       *     （省略 model 字段）未必是正确选择。
       */
      const requiresModelPreset = (activeFields?.requiresModel ?? false) === true;
      const modelHint = requiresModelPreset
        ? t("该端点 model 必填；留空 = 用预设默认 {model}", { model: activeFields.defaultModel })
        : isCustom
          ? modelsState === "ok"
            ? t("从自定义服务实时获取；可从列表选择，也可直接手填模型名；留空表示不发送 model 字段")
            : modelsState === "loading"
              ? "正在获取模型列表…"
              : "获取失败或暂无列表，可手填模型名"
          : modelsState === "ok"
            ? "从服务商实时获取；选「自动」则由服务端决定，换名也不会失效"
            : modelsState === "loading"
              ? "正在获取模型列表…"
              : modelsState === "error"
                ? "获取失败，可手填或留空用服务端默认"
                : "未获取到列表，可手填或留空用服务端默认";
      const autoOptionLabel = requiresModelPreset
        ? t("默认（{model}）", { model: activeFields.defaultModel })
        : isCustom
          ? "自动（不发送 model 字段）"
          : "自动（服务端默认）";
      /**
       * custom 的模型框是**组合框**（可下拉、可手填），内置预设仍是下拉。
       *
       * 为什么要分成两种（issue #2）：有些决策服务的 /v1/models 里根本没有
       * 它的决策模型——书生·端砚的 intern-decision-4b 就是这样。而 `<select>`
       * 只能从列表里选，于是用户被卡在「列表里没有、界面又不能填」。
       *
       * 用原生 `<input list>` + `<datalist>`：既保留「点开有候选」的便利，
       * 又允许任意输入，零依赖、零新状态。
       *
       * 空串的语义不变 = 「自动（不发送 model 字段）」，由 placeholder 与
       * 说明文字表达；**不用** value="" 的 datalist option（各浏览器对空值
       * option 的可选性不一致）。
       */
      const modelListId = `de-model-options-${modelField}`;
      /**
       * 检测到的模型候选项。
       *
       * 做成函数而不是常量：下拉与 datalist 各要一份**独立**的节点实例
       * （同一批节点挂到两处会让渲染库按身份复用出怪结果），而列表内容
       * 只有这一处来源。
       */
