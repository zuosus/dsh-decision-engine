      const detectedModelOptions = () =>
        models.map((item) => h("option", { value: item.id, key: item.id }, item.id));
      // 控件按 provider 分两种：custom 是组合框，内置预设是下拉。
      // 一次分支出「控件 + 候选列表」，避免同一个判断散在两处。
      const modelControlNodes = isCustom
        ? [
            h(
              "input",
              {
                type: "text",
                list: modelListId,
                style: { ...S.input, minWidth: "220px" },
                placeholder: autoOptionLabel,
                // 可访问名由行的标题给出（configRow 会给控件挂 aria-labelledby），
                // 这里不再手写 aria-label——两处都写会让读屏只认其中一个。
                value: modelValue ?? "",
                onChange: (event) => {
                  const next = { ...draft, [modelField]: event.target.value };
                  setDraft(next);
                  // 文本框：停手防抖落盘（与 Base URL / 请求头同一套节奏）。
                  scheduleSave({ draft: next });
                },
                // 失焦立即存一次：用户填完模型名直接点别的控件时，不必等防抖。
                onBlur: () => scheduleSave(null, true),
              },
            ),
            // 候选列表：点开输入框即见候选，仍可自由输入。
            h("datalist", { id: modelListId }, ...detectedModelOptions()),
          ]
        : [
            h(
              "select",
              {
                style: { ...S.input, minWidth: "220px" },
                value: modelValue ?? "",
                onChange: (event) => setModelValue(event.target.value),
              },
              h("option", { value: "" }, autoOptionLabel),
              // 当前值不在列表里时也保留，避免下拉把已配置的值吞掉。
              ...((modelValue ?? "") === "" || models.some((item) => item.id === modelValue)
                ? []
                : [h("option", { value: modelValue, key: "current-model" }, t("{model}（当前值）", { model: modelValue }))]),
              ...detectedModelOptions(),
            ),
          ];
      const modelRow = row(
        "模型",
        modelHint,
        h(
          "div",
          { style: { display: "flex", gap: "6px", alignItems: "center", flex: 1, minWidth: 0 } },
          ...modelControlNodes,
          h(
            "button",
            {
              type: "button",
              onClick: loadModels,
              disabled: modelsState === "loading",
              style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
            },
            modelsState === "loading" ? "…" : "获取",
          ),
        ),
        "model",
      );

      // 配置 tab 的全部内容（DEC-051：从「一条长表单 + 三条分隔线」改成
      // **四组可展开的分组**）。
      //
      // 四个 `*Items` 数组分别是四组的正文；下面的 `configBody` 用
      // `sectionBlock()` 把它们各自包成一个可折叠的 `<section>`：标题行
      // 整行可点、带 chevron，展开状态记在 localStorage（见 readSectionOpen）。
      //
      // 分组顺序与理由：
      //   ① 连接方式——连到哪、用谁的 key（地址来源是其余一切的前提）
      //   ② 守卫行为——判不判、拦不拦、问得多不多、决策模型进哪些环节
      //   ③ 记录与展示——记不记、审批卡长什么样
      //   ④ 模型与统计——思考模式与匿名统计（设一次就忘，默认收起）
      //
      // 页脚（保存状态 / 状态信息）**不进任何分组**：保存与诊断状态是所有
      // 分组的共同结论；测试端点本身是连接操作，放在连接方式分组末尾。
      const connectionItems = [
        // ① 连接方式：地址从哪来、发给谁、用谁的 key、怎么存。
        //   第一行的「使用免费模型」是这一组的总开关：它决定下面这些项
        //   是服务端下发还是用户自己填，所以必须排在最前。
        // 1) 使用免费模型（DEC-030，原名「跟随服务端下发」；DEC-037 改名并置顶）：
        //    地址 / 模型 / key 都改由服务端下发，不必自己填。
        //
        // 放在整页的最上面：它是**地址来源**的决定——「用免费的，还是自己配」。
        // 下面每一组的每一项都取决于它（发给谁、用谁的 key、守卫跑在哪家模型上），
        // 所以它必须先被读到。
        //
        // 说明下面那行小字「可能会失效」是这件事的代价，不是附注：免费通道随时
        // 可能停用，用户得知道本地手动配置仍是可靠后路。改名也是为了让用户先看到
        // 「免费」这个能感知的事实，而不是「服务端下发」这个实现细节。
        //
        // 默认关：不打开时本插件的行为与之前逐字一致（全部走本地手动配置）。
        row(
          "使用免费模型",
          serverHint,
          h(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center", flex: "none" } },
            // 「重新获取」只在开着时出现：关着的时候它什么也不会变，摆在那里
            // 只会让人以为这个功能坏了。
            view.serverProvider?.enabled === true
              ? h(
                  "button",
                  {
                    type: "button",
                    key: "server-refetch",
                    onClick: reloadServerProvider,
                    disabled: busy !== "",
                    style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
                  },
                  busy === "serverProvider" ? "…" : t("重新获取"),
                )
              : null,
            toggle(draft.serverProvider === true, () => {
              const next = draft.serverProvider !== true;
              const fresh = { ...draft, serverProvider: next };
              setDraft(fresh);
              // 开关是离散控件：拨一下就落盘。服务端据它决定是否去取下发值。
              scheduleSave({ draft: fresh }, true);
            }),
          ),
          "serverProvider",
          "可能会失效",
        ),
        // 1b) 免费模型兜底（backup model）：主模型 4xx/5xx 时改用免费模型。
        //
        // 紧跟在「使用免费模型」后面：它复用的正是同一份下发配置，两者是
        // 「免费通道怎么用」的两种方式——当主模型（用它）、或只当兜底。
        // 放在别处会让人以为它是另一个独立的服务商。
        //
        // 四种状态都要说清「现在到底会不会兜底」，因为用户最怕的是
        // 「开关开着但实际没生效」这类静默偏差：
        //   primary-is-free → 免费模型已是主模型，兜底无意义；
        //   no-config       → 配置还没取到（会自动重试）；
        //   ready           → 生效，并把已兜底次数摆出来；
        //   关闭            → 与升级前逐字一致。
        row(
          "免费模型兜底",
          (() => {
            const bm = view.backupModel ?? {};
            if (draft.backupModel !== true) return t("关闭：主模型失败时直接降级放行，与现在完全一致");
            if (bm.blocked === "primary-is-free") return t("已开启「使用免费模型」，兜底不生效（免费模型已是主模型）");
            if (bm.ready === true) {
              return t("主模型失败（4xx/5xx）时改用免费模型 · 已兜底 {n} 次", { n: bm.uses ?? 0 });
            }
            if (bm.blocked === "expired") return t("免费模型配置已过期，正在重新获取；期间主模型失败仍直接降级");
            return t("免费模型配置尚未获取（会自动重试）；期间主模型失败仍直接降级");
          })(),
          toggle(draft.backupModel === true, () => {
            const next = draft.backupModel !== true;
            const fresh = { ...draft, backupModel: next };
            setDraft(fresh);
            // 离散控件：拨一下就落盘。服务端据它决定是否提前去取免费配置。
            scheduleSave({ draft: fresh }, true);
          }),
          "backupModel",
          "需要提前获取免费模型配置",
        ),
        // 2a) 服务提供方：最高层的选择，决定地址与鉴权从哪来。
        //     DEC-082：picker 从下拉改成标题下方的 grid 线框按钮——选中的
        //     高亮反色，已配 key 的按钮右侧带「已配置Key」小字，一眼可切换。
        row("服务提供方", providerHint, null, "provider", undefined, providerGrid),
        // 2b) 模型行：custom 时移入下方「自定义 provider」区（见 modelRow 的说明）。
        // 每个 provider 用自己那一格（modelField 由服务端下发），分开存才能做到
        // 「切 provider 不覆盖其它 provider 已保存的模型」。
        ...(isCustom ? [] : [modelRow]),
        // 2c) API Key：每个 provider 一格，各自保存各自的 key。
        //    密钥**只**在失焦或回车时落盘（commitKey）：打字途中自动保存会把
        //    半截 key 写进凭据文件，比多一步确认更危险。
        row(
          "API Key" + (keyOk
            ? t("（已配置 {hint}）", { hint: activeKeyStatus?.hint ?? view.keyHint ?? "" })
            : t("（未配置）")),
          activeKeyStatus !== null
            ? storageValue === "config"
              // 存到配置文件时，目标是该 provider 的显式字段名（如
              // systemoneApiKey），而不是凭据变量名——两者是不同的位置，
              // 混着说会让人去 .credentials.yaml 里找 key。
              ? t("存到插件配置 config.yml 的 {field}（明文）", { field: activeKeyStatus.keyField || t("显式 key 字段") })
              : t("存到 .credentials.yaml 的 {ref}", { ref: activeKeyStatus.refName })
            : "留空则不修改；粘贴新 key 后失焦或回车即保存",
          h("input", {
            type: "password",
            style: S.input,
            placeholder: keyOk ? "sk-…（留空不改）" : "sk-…",
            value: keyInputs[providerDraft.provider] ?? "",
            onChange: (event) => {
              const next = { ...keyInputs, [providerDraft.provider]: event.target.value };
              setKeyInputs(next);
              // 同步进 ref：commitKey 读的是它。回车可能紧贴最后一次按键，
              // 等重绘就来不及了。
              valuesRef.current = { ...valuesRef.current, keyInputs: next };
            },
            // 密钥只在「明确提交」时落盘：失焦或回车。
            onBlur: () => commitKey(providerDraft.provider),
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              commitKey(providerDraft.provider);
            },
          }),
          "key",
        ),
        // 2c-2) 删除当前 provider 的 key（DEC-080）：只在它确实配了 key 时出现。
        //        判断用服务端下发的 keyStatus（明文不回传、来源它最清楚），
        //        不用输入框内容——没粘贴过也可能来自凭据文件 / 环境变量。
        //        只删密钥，模型 / 地址 / 变量名等其它设置保留，按钮说明里写清。
        keyOk
          ? row(
              t("删除配置"),
              t("删除当前 provider 的 API Key（保留模型、地址等其它设置）"),
              h(
                "button",
                {
                  type: "button",
                  key: "delete-key",
                  disabled: busy !== "",
                  onClick: deleteKey,
                  style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
                },
                busy === "deleteKey" ? t("删除中…") : t("删除配置"),
              ),
              "deleteKey",
            )
          : null,
        // 2d) 当前 provider 的生效端点：让「实际打到哪」始终可见
        row(
          "生效端点",
          isCustom
            ? "由上方 base URL + 端点风格拼接；已带 /decisions 或 /systemone 时原样使用"
            : "内置预设的默认地址（可用 config.yml 的 baseUrl 覆盖当前默认预设）",
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "3px", maxWidth: "320px" } },
            h(
              "span",
              { style: { ...S.v, fontSize: "11px", opacity: 0.75, wordBreak: "break-all" } },
              view.providerValid === false
                ? "配置不可用"
                : view.baseUrl || "(服务端未返回)",
            ),
            // 探测出的实际可用路径：路径后缀由服务商决定（实测 SiliconFlow
            // 只通 /systemone），必须让用户看见「最后打的是哪条」。
            typeof view.detectedEndpoint === "string" && view.detectedEndpoint.length > 0
              ? h(
                  "span",
                  { style: { ...S.v, fontSize: "11px", opacity: 0.85, color: "#7dd3a0" } },
                  t("已验证可用：{endpoint}", { endpoint: view.detectedEndpoint }),
                )
              : null,
            // 服务端下发生效时给这行一个来源角标：地址看起来「凭空变了」时，
            // 用户要能立刻知道这是下发值而不是自己配的值。
            view.serverProvider?.active === true
              ? h(
                  "span",
                  { style: { ...S.v, fontSize: "11px", opacity: 0.9, color: "#93c5fd" } },
                  t("（地址与密钥来自服务端下发）"),
                )
              : null,
          ),
          "endpoint",
        ),
        // 4c) 密钥保存位置：默认托管到 .credentials.yaml（DEC-037 从 API Key 紧邻处
        //     下移到这里：它讲的是「这把 key 存到哪个文件」，不是「怎么连上服务」，
        //     夹在连接组中间会打断 provider → 模型 → key → 端点这条阅读线；
        //     而且它平时不用改，属于「设一次就忘」的项）
        row(
          "密钥保存位置",
          storageValue === "config"
            ? t("存进插件配置 config.yml 的 {field}（自包含，便于随目录备份；注意是明文）", { field: activeKeyStatus?.keyField || t("显式 key 字段") })
            : "存进 ~/.dsh/.credentials.yaml（默认，与其他服务统一托管）",
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: storageValue,
              disabled: busy !== "",
              onChange: (event) => {
                setStorageDraft(event.target.value);
                // 下拉是离散控件：选完即存。
                scheduleSave({ storageDraft: event.target.value }, true);
              },
            },
            h("option", { value: "credentials" }, ".credentials.yaml（默认）"),
            h("option", { value: "config" }, "插件配置 config.yml"),
          ),
          "keyStorage",
        ),
        // 4d) custom 专属字段：只有选了 custom 才出现，避免内置预设被无用输入干扰
        isCustom
          ? h(
              "div",
              { key: "custom" },
              h("div", { style: S.sectionTitle }, "自定义 provider"),
              row(
                "Base URL（必填）",
                customUrlError.length > 0
                  ? customUrlError
                  : "任意提供决策端点的服务；末尾斜杠会自动规范化，端点段不会重复",
                h("input", {
                  type: "text",
                  style: {
                    ...S.input,
                    borderColor: customUrlError.length > 0 ? "rgba(248,113,113,.75)" : "rgba(128,128,128,.32)",
                  },
                  placeholder: "https://api.example.com/v1",
                  value: providerDraft.customBaseUrl ?? "",
                  onChange: (event) => {
                    const next = { ...providerDraft, customBaseUrl: event.target.value };
                    setProviderDraft(next);
                    setProviderError("");
                    // 文本框：停手防抖落盘（打字途中的非法地址会被 flush 整笔延后）。
                    scheduleSave({ providerDraft: next });
                  },
                  onBlur: () => scheduleSave(null, true),
                }),
                "custom-url",
              ),
              row(
                "端点风格",
                t("路径后缀由服务商决定（实测 SiliconFlow 只通 /systemone）。这里是「首选」：若首选路径返回 404，插件会自动改用另一条再试一次"),
                h(
                  "select",
                  {
                    style: { ...S.input, minWidth: "150px", flex: "none" },
                    value: providerDraft.customEndpointStyle ?? "auto",
                    onChange: (event) => {
                      const next = { ...providerDraft, customEndpointStyle: event.target.value };
                      setProviderDraft(next);
                      // 下拉是离散控件：选完即存。
                      scheduleSave({ providerDraft: next }, true);
                    },
                  },
                  h("option", { value: "auto" }, "auto（先 /decisions）"),
                  h("option", { value: "decisions" }, "decisions"),
                  h("option", { value: "systemone" }, "systemone"),
                ),
                "custom-style",
              ),
              row(
                "附加请求头",
                "可留空。格式 `名称: 值`，多项用分号分隔；authorization / content-type 由插件固定",
                h("input", {
                  type: "text",
                  style: S.input,
                  placeholder: "X-Tenant: team-a; X-Trace: dsh",
                  value: providerDraft.customHeaders ?? "",
                  onChange: (event) => {
                    const next = { ...providerDraft, customHeaders: event.target.value };
                    setProviderDraft(next);
                    scheduleSave({ providerDraft: next });
                  },
                  onBlur: () => scheduleSave(null, true),
                }),
                "custom-headers",
              ),
              row(
                "密钥变量名",
                "可留空。填了就从这个环境变量或 ~/.dsh/.credentials.yaml 的 refs 段取 key",
                h("input", {
                  type: "text",
                  style: S.input,
                  placeholder: "MY_DECISION_API_KEY",
                  value: providerDraft.customApiKeyEnv ?? "",
                  onChange: (event) => {
                    const next = { ...providerDraft, customApiKeyEnv: event.target.value };
                    setProviderDraft(next);
                    scheduleSave({ providerDraft: next });
                  },
                  onBlur: () => scheduleSave(null, true),
                }),
                "custom-env",
              ),
              // 模型行也属于 custom 区：清单来自这个服务，「自动」的含义
              // （省略 model 字段）只有结合这里的端点才说得清。
              modelRow,
            )
          : null,
        // 4e) provider 校验错误：必须显式显示，否则用户只会看到「保存失败」
        providerErrorText.length > 0
          ? h(
              "div",
              {
                key: "provider-error",
                style: {
                  ...S.pointHint,
                  marginTop: "8px",
                  color: "#f87171",
                  fontSize: "12px",
                  opacity: 1,
                },
              },
              providerErrorText,
            )
          : null,
        // 2e) 测试端点：放在连接方式分组最后一项，方便在配好地址与密钥后直接验证。
        row(
          t("测试端点"),
          t("探测当前生效的决策端点是否可用"),
          h(
            "button",
            {
              type: "button",
              disabled: busy !== "",
              onClick: runTest,
              style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
            },
            busy === "test" ? t("测试中…") : t("测试端点"),
          ),
          "testEndpoint",
        ),
        // 2f) 状态信息（紧凑）：连着哪家、生效的端点、用的哪份密钥。
        //     它是「测试端点」按钮那一问的另一半：先看当前是什么状态，
        //     再按按钮，诊断结果（2g）就显示在旁边。原先在页脚，分组一
