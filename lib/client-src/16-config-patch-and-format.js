    function configPatchOf(values, keyCommit, modelFields, keyFields) {
      const draft = values.draft;
      const provider = values.providerDraft;
      const patch = {
        enabled: draft.enabled === true,
        mode: draft.mode,
        // 思考模式总是提交：它是全局项（与 provider 无关），服务端还会再校验一次。
        thinkMode: draft.thinkMode ?? "never",
        // 匿名统计档位也总是提交——**但只在草稿里真的有这一项时**。
        //
        // 这一项此前同时漏在这里和服务端 PUT 白名单里，于是下拉能点、显示
        // 「已保存」，值却从来没落盘（用户以为关掉了统计，实际每天照发）。
        // 白名单补上了，但「无条件回填 daily」还有第二个坑：草稿一旦缺这一项
        // （历史上三处手写派生表时就漏过），改任何一个无关开关都会把
        // `telemetryLevel: daily` 一起写下去——**已关掉的隐私开关被一次无关
        // 保存重新打开**。所以这里与 tolerance 同款：拿不到字符串就不提交，
        // 宁可少写一次也不能替用户把开关打开。
        ...(typeof draft.telemetryLevel === "string" ? { telemetryLevel: draft.telemetryLevel } : {}),
        // 模型只写当前 provider 自己那一格（字段名叫什么由 fields 给）。
        // 混写会让「切过去再切回来」丢掉原值，也会把当前 provider 的模型名
        // 发给别的服务。
        [modelFields.modelField]: (draft[modelFields.modelField] ?? "").trim(),
        provider: provider.provider,
        customEndpointStyle: provider.customEndpointStyle ?? "auto",
        // 决策历史（DEC-022）：这个开关**总是**提交（不是「只在改过时提交」）。
        //
        // 为什么总是提交：它是「关掉就不再记录」的性质，服务端读到
        // 什么就按什么执行。若只在改动时提交，那么「服务端是关、界面显示关」
        // 之后用户碰别的字段触发一次保存，patch 里没有这个键，服务端仍
        // 保持关——这是对的；反过来「服务端是开、界面显示开」也没问题。
        // 真正需要小心的是**默认值**：服务端 DEFAULTS 是 true，配置文件里
        // 可能根本没有这一项。因此提交**生效值**（而不是 undefined），
        // 保证「界面上看到的状态」与「落盘的状态」永远一致。
        decisionsTabEnabled: draft.decisionsTabEnabled !== false,
        // 审批卡正文可读化（DEC-042 / DEC-043）：与决策历史同款——**总是**提交
        // 生效值。服务端 DEFAULTS 现在是 true，配置文件里可能没写这一项，
        // 「没写」等于「开」，所以这里必须按 `!== false` 折算：否则拨了开关也会
        // 因为 patch 里是这个键的 undefined 而被服务端当成没提交。
        approvalDetailReadable: draft.approvalDetailReadable !== false,
        // 危险权限申请交决策模型（DEC-089）：与上面同款——**总是**提交生效值。
        //
        // 这一项尤其不能静默失效：界面已经弹过风险提示、用户已经确认过，
        // 若 patch 里没有这个键，服务端什么都没写，用户会以为模型在替他把关。
        dangerFullAccessDecider: draft.dangerFullAccessDecider === true,
        // 跟随服务端下发（DEC-030）：与上面的决策历史同款——**总是**提交
        // 生效值，而不是「只在改过时提交」。
        //
        // 为什么总是提交：服务端读到什么就按什么执行（开着就取下发值、关着
        // 就用本地手动配置）。若只在改动时提交，那么「服务端是关、界面显示关」
        // 之后用户碰别的字段触发一次保存，patch 里没有这个键，服务端仍保持关
        // ——这是对的；但配置文件里可能根本没有这一项（服务端默认关），
        // 提交 undefined 会让「界面显示的状态」与「落盘的状态」在一段时间内
        // 不一致。提交 `=== true` 得到的是确定的布尔值，两种状态都对得上。
        serverProvider: draft.serverProvider === true,
        // 免费模型兜底：与上面同款——**总是**提交生效值。它同样是「开着就
        // 会多网络行为」的选择，界面上看到什么就该落盘什么。
        backupModel: draft.backupModel === true,
        // 人工审核比例（DEC-035）：与上面两个开关同款——**总是**提交生效值。
        //
        // 为什么总是提交：配置文件里可能根本没有这一项（服务端默认 `default`），
        // 提交 undefined 会让「界面显示的档位」与「落盘的档位」在一段时间内
        // 不一致。档位是离散字符串，回填一个确定的取值，两种状态都对得上。
        //
        // 没拿到服务端下发的档位元数据时（首帧、接口失败）**不提交**：
        // 此时 `draft.tolerance` 也是 undefined，硬塞一个 `default` 会把用户
        // 已经存好的「自治」覆盖掉——那正是「保存后档位回弹」的来源。
        ...(typeof draft.tolerance === "string" ? { tolerance: draft.tolerance } : {}),
        // custom 的字段总是带上：用户可能先填地址再切 provider，
        // 分开提交会让中间状态被当成最终配置。
        customHeaders: (provider.customHeaders ?? "").trim(),
        customApiKeyEnv: (provider.customApiKeyEnv ?? "").trim(),
      };
      // customBaseUrl 只在**合法**时提交。空串对内置 provider 是合法的
      //（等于不覆盖），对 custom 则是必填缺失——那种情况整笔延后，见 flush()。
      // 不合法的值一律不发：服务端会拒，而打字途中的每一次拒绝都是噪音。
      const url = (provider.customBaseUrl ?? "").trim();
      if (customUrlProblem(url, provider.provider) === "") patch.customBaseUrl = url;
      // 保存位置：只在用户改过时才提交，避免每次保存都覆盖。
      if (values.storageDraft !== null && values.storageDraft !== undefined) {
        patch.keyStorage = values.storageDraft;
      }
      // 密钥：只有用户明确提交（失焦 / 回车）且长度够时才带上。
      // 否则打字过程中每停一下都会把半截 key 写进凭据文件。
      //
      // 写到哪一格按**提交时的 provider**（keyCommit）而不是当前选中的 provider：
      // 提交与落盘之间可能隔了几百毫秒（防抖、上一次保存还在飞），期间用户
      // 完全可以切走。按当前选中项写，就会把硅基流动的 key 存进 systemone 的
      // 格子——正是「存了 key 却说没配 key」的来源。
      if (keyCommit !== null && keyCommit !== undefined && keyFields !== null) {
        const raw = (values.keyInputs[keyCommit] ?? "").trim();
        if (raw.length >= 10) patch[keyFields.keyField] = raw;
      }
      return patch;
    }

    /**
     * patch 是否真的与服务端当前状态不同。
     *
     * 自动保存会频繁调用：不做这个比较，用户改一个决策点也会重写一次
     * config.yml（白改 mtime、白触发一次热加载）。比较对象是 status 回显，
     * 也就是「服务端认为的值」——与旧版「保存按钮的可用条件」同一语义。
     *
     * @param patch - `configPatchOf` 拼出的 patch。
     * @param view - `/status` 回显（缺字段时用安全默认）。
     */
    function patchDiffersFromServer(patch, view, fields) {
      const pairs = [
        ["enabled", view.enabled === true],
        ["mode", view.mode ?? "shadow"],
        ["thinkMode", view.thinkMode ?? "never"],
        // 匿名统计档位：与生效值比，否则改档位不会触发保存。
        ["telemetryLevel", view.telemetryLevel ?? "daily"],
        ["provider", view.provider ?? "systemone"],
        ["customBaseUrl", view.customBaseUrl ?? ""],
        ["customEndpointStyle", view.customEndpointStyle ?? "auto"],
        ["customHeaders", view.customHeaders ?? ""],
        ["customApiKeyEnv", view.customApiKeyEnv ?? ""],
        ["keyStorage", view.keyStorage ?? "credentials"],
        // 决策历史（DEC-022）：与服务端的生效值比。服务端回传的是
        // `cfg.decisionsTabEnabled !== false` 这种**生效值**（不是原值），
        // 因此这里与它比是对的。
        ["decisionsTabEnabled", view.decisionsTabEnabled !== false],
        // 审批卡正文可读化（DEC-042 / DEC-043）：同样是生效值比较（缺省 = 开），
        // 否则拨了开关不触发保存。
        ["approvalDetailReadable", view.approvalDetailReadable !== false],
        // 跟随服务端下发（DEC-030）：与服务端回传的**生效值**比（服务端回
        // `enabled === true` 归一化后的布尔值），否则拨开关不会触发保存。
        ["serverProvider", view.serverProvider?.enabled === true],
        // 免费模型兜底：与服务端回传的生效值比，否则拨开关不触发保存。
        ["backupModel", view.backupModel?.enabled === true],
        // 人工审核比例（DEC-035）：与服务端的生效值比，否则点滑块不触发保存。
        ["tolerance", view.tolerance?.level ?? "default"],
        // 模型字段逐格比较：键就是 config.yml 里的字段名（rawModels 下发）。
        // 用一张表而不是逐个 provider 写死，新增预设才不用改这里——漏一格
        // 的后果是「改了模型却不触发保存」。
        ...Object.entries(rawModelsOf(view)),
      ];
      for (const [key, server] of pairs) {
        if (Object.hasOwn(patch, key) && String(patch[key] ?? "") !== String(server ?? "")) return true;
      }
      // 密钥字段一出现就代表「有新 key 要写」：服务端只回传掩码，没法比较，
      // 而且重复写同一个 key 是无害的（幂等覆盖）。字段名由服务端下发。
      return Object.hasOwn(patch, fields.keyField);
    }

    /**
     * 千分位分组。
     *
     * 不用 `toLocaleString()`：它的分组与分隔符随运行环境的 locale 变
     * （Node 与 Electron 的默认 locale 未必一致），同一份数据在两个地方
     * 显示成两种数字，正是最难核对的那类问题。
     */
    function groupDigits(value) {
      const n = Number(value ?? 0);
      if (!Number.isFinite(n)) return "0";
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 毫秒的可读化。
     *
     * 「1067032ms」没法读，而统计里时间跨度正好横跨毫秒到分钟量级，
     * 所以按量级切换单位；小于 1 秒保留 ms（那正是本插件关心的粒度）。
     */
    function formatMs(value) {
      const n = Number(value ?? 0);
      if (!Number.isFinite(n) || n <= 0) return "0ms";
      if (n < 1000) return `${Math.round(n)}ms`;
      if (n < 60000) return `${Math.round(n / 100) / 10}s`;
      return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
    }

    /** 比例（0–1）显示成百分数；一位小数足够，再多就是假精确。 */
    function formatRatio(value) {
      const n = Number(value ?? 0);
      if (!Number.isFinite(n) || n <= 0) return "0%";
      return `${Math.round(n * 1000) / 10}%`;
    }

    /** ISO 串显示成本地「MM-DD HH:mm」，让用户看见预设解析成的真实边界。 */
    function formatLocalTime(iso) {
      const ms = Date.parse(String(iso ?? ""));
      if (Number.isNaN(ms)) return "";
      const d = new Date(ms);
      const pad = (v) => String(v).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /**
     * ISO 串显示成本地「YYYY-MM-DD HH:mm:ss」，给决策历史的「时间」列用。
     *
     * 与上面的 `formatLocalTime` 是两个用途：那个渲染统计页的区间边界（分钟
     * 粒度足够），这个渲染逐条决策的流水——**必须带秒**，因为同一次工具调用
     * 链里的几条决策可能落在同一分钟，省掉秒会让它们看起来同时发生。
     *
     * 为什么要专门写一个：这里原来只是把 ISO 串切一刀
     * （`ts.replace("T"," ").replace(/\.\d+Z$/,"")`），看着像本地时间，其实
     * 显示的是 **UTC 挂钟**——用户看到的时间与自己差 8 小时（2026-11-03 反馈
     * 「时间是 UTC，切换为运行环境本地时间」）。ISO 串必须经 `Date` 解析后
     * 用本地取值器渲染，才真的是本地时间。
     */
    function formatLocalDateTime(iso) {
      const ms = Date.parse(String(iso ?? ""));
      if (Number.isNaN(ms)) return "";
      const d = new Date(ms);
      const pad = (v) => String(v).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * 毫秒时间戳显示成本地「MM-DD HH:mm」。
     *
     * 与 `formatLocalTime` 同一显示习惯，区别只在入参：那个收 ISO 串
     * （统计区间的服务端值），这个收毫秒数（服务端下发值的 `fetchedAt`）。
     * 不引任何日期库：两个 `pad` 就够了。
     */
    function formatLocalMs(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return "";
      const d = new Date(n);
      const pad = (v) => String(v).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** 可排序表头：点击切到该字段，再点切换升降序。 */
