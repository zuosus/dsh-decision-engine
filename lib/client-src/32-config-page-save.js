      // 即使状态还没加载回来（或 API 失败），也**照常渲染表单**——
      // API Key 输入框必须在任何情况下都可见可填，否则一旦 status 请求失败
      // 用户就永远看不到输入框。status 缺失时用安全默认值兜底。
      //
      // 兜底值刻意**不含任何具体服务商地址**：地址一律由服务端按 provider
      // 预设下发（providerCatalog / baseUrl）。前端自己写一份默认地址，
      // 就会出现「界面显示 A、实际请求 B」这类最难排查的偏差。
      const view = status ?? {
        enabled: false,
        mode: "shadow",
        provider: "systemone",
        providerLabel: "system one",
        providerValid: true,
        providerError: "",
        providerCatalog: [],
        baseUrl: "",
        // 探测出的可用路径：status 失败时留空（界面不显示那一行）。
        detectedEndpoint: "",
        model: "",
        timeoutMs: 20000,
        keyConfigured: false,
        keyHint: "",
        keyStorage: "credentials",
        keyStatus: {},
        // 兜底也要给出思考模式取值：status 请求失败时下拉框仍要能显示。
        thinkMode: "never",
        thinkModes: ["never", "auto", "always"],
        // 匿名统计的兜底：status 失败时下拉仍要能显示正确档位。
        telemetryLevel: "daily",
        telemetryLevels: ["off", "install", "daily"],
        // 决策历史（DEC-022）的兜底：默认**开**，与服务端 DEFAULTS 一致。
        // 兜底成 false 会让 status 失败那一帧显示成「关」，用户可能顺手拨一下
        // 把开关存成 false——那正是「开关自己弹回去」的来源。
        decisionsTabEnabled: true,
        // 审批卡正文可读化（DEC-042 / DEC-043）的兜底：默认**开**，与服务端
        // DEFAULTS 一致。兜底成 false 会让 status 失败那一帧把开关画成「关」，
        // 用户顺手拨一下就把 false 存下去了——与上面那个开关同一类事故。
        approvalDetailReadable: true,
        // 跟随服务端下发（DEC-030）的兜底：默认**关**，字段与冻结契约一致。
        //
        // 兜底成「开」会让 status 失败那一帧显示成「正在用服务端值」，而实际
        // 生效的是本地手动配置——用户据此以为不必填 key，实际每次请求都失败。
        // 默认关与「后端还没接线」时的真实行为也一致。
        serverProvider: {
          enabled: false,
          active: false,
          endpoint: "",
          label: "服务端下发",
          status: "idle",
          usable: false,
          error: "",
          keyHint: "",
          baseUrl: "",
          model: "",
          endpointStyle: "",
          fetchedAt: 0,
          expiresAt: 0,
          expired: false,
        },
        stats: { requests: 0, cached: 0 },
      };

      /** 生效草稿：没有用户改动时一律从服务端状态派生。 */
      const draft = draftState ?? {
        enabled: view.enabled === true,
        mode: view.mode ?? "shadow",
        // 思考模式也走 draft：与其它控件一致，改完即自动落盘。
        thinkMode: view.thinkMode ?? "never",
        // 决策历史（DEC-022）：与服务端一致，默认开。
        decisionsTabEnabled: view.decisionsTabEnabled !== false,
        // 审批卡正文可读化（DEC-042 / DEC-043）：同样默认开。缺了这一格，
        // 首屏会在服务端说「开」的同时把开关画成「关」。
        approvalDetailReadable: view.approvalDetailReadable !== false,
        // 跟随服务端下发（DEC-030）：默认关（与服务端 DEFAULTS 一致）。
        serverProvider: view.serverProvider?.enabled === true,
        // 免费模型兜底：同样默认关，且必须从服务端生效值派生——
        // 派生错了就是「开关自己弹回去」（DEC-037 记过同一类事故）。
        backupModel: view.backupModel?.enabled === true,
        // 模型一格一个 provider，键 = config.yml 字段名（见 rawModelsOf）。
        ...rawModelsOf(view),
      };
      // provider 草稿：与主配置分开保存，因为 custom 的字段是「先填后切」，
      // 混进主 draft 会让「只切 provider」也顺手把没填完的自定义地址写进去。
      // 模型不在这里——它跟模型行走，与 provider 切换同步刷新。
      const providerDraft = providerDraftState ?? {
        provider: view.provider ?? "systemone",
        customBaseUrl: view.customBaseUrl ?? "",
        customEndpointStyle: view.customEndpointStyle ?? "auto",
        customHeaders: view.customHeaders ?? "",
        customApiKeyEnv: view.customApiKeyEnv ?? "",
      };

      // 模型列表自动拉取：打开配置页就该看到当前服务可选的模型，
      // 而不是等用户发现并点「获取」（此前 loadModels 只有按钮一个调用点，
      // 迁移到 custom 的用户打开页面只会看到「自动」一项——正是反馈的问题）。
      // 触发点：状态首次加载完成 + provider / 生效地址变化（切预设、custom
      // base URL 保存后都会变）。/models 只在配置页打开时调用，服务端有
      // 独立超时，不占决策路径。
      const statusLoaded = status !== null && status !== undefined;
      const modelsKey = (view.provider ?? "") + "\u0000" + (view.baseUrl ?? "");
      react.useEffect(() => {
        if (!statusLoaded) return;
        loadModels();
      }, [loadModels, statusLoaded, modelsKey]);

      /**
       * 把服务端返回的完整状态写回本地草稿。
       *
       * 保存成功后**必须**用它而不是各自 setDraft：否则 provider、custom 字段、
       * 主配置三处会各自漂移，表现为「保存后界面显示的还是旧值」。
       */
      const applyServerState = (next) => {
        setStatus(next);
        setDraft({
          enabled: next.enabled === true,
          mode: next.mode ?? "shadow",
          thinkMode: next.thinkMode ?? "never",
          // 匿名统计档位：必须从服务端状态派生，否则首屏会落到兜底值，
          // 用户看到的档位与实际生效的不一致。
          telemetryLevel: next.telemetryLevel ?? "daily",
          // 决策历史（DEC-022）：同样必须从服务端派生，否则保存后开关会回弹。
          decisionsTabEnabled: next.decisionsTabEnabled !== false,
          // 审批卡正文可读化（DEC-042 / DEC-043）：必须从服务端派生。这个函数
          // 在**保存成功之后**才跑，缺了这一格，草稿丢掉的就不只是个显示值：
          // 开关当场画成「关」，下一次保存又把 `false` 提交上去——开关自己
          // 弹回去（DEC-037 记过同一类事故）。
          approvalDetailReadable: next.approvalDetailReadable !== false,
          // 跟随服务端下发（DEC-030）：同样是「生效值」，必须从服务端派生。
          serverProvider: next.serverProvider?.enabled === true,
          // 免费模型兜底：同上。缺了这一格，保存后开关会画成「关」，
          // 下一次保存又把 false 提交上去——开关自己弹回去。
          backupModel: next.backupModel?.enabled === true,
          // 人工审核比例（DEC-035）：同样必须从服务端派生，否则保存后回弹。
          tolerance: next.tolerance?.level ?? "default",
          // 模型各 provider 一格：键就是 config.yml 里的字段名（rawModels
          // 下发），因此新增预设不必再改前端。切 provider 也不会把 A 的
          // 模型名带进 B 那一格。
          ...rawModelsOf(next),
        });
        setProviderDraft({
          provider: next.provider ?? "systemone",
          customBaseUrl: next.customBaseUrl ?? "",
          customEndpointStyle: next.customEndpointStyle ?? "auto",
          customHeaders: next.customHeaders ?? "",
          customApiKeyEnv: next.customApiKeyEnv ?? "",
        });
        setProviderError(next.providerValid === false ? next.providerError ?? "配置不可用" : "");
        dirtyRef.current = false;
      };

      // 每次渲染把「当前值」同步进 ref：控件在事件里读它，flush 也读它。
      // 放在渲染期赋值（而不是 useEffect）是必须的——useEffect 在提交之后才跑，
      // 而事件处理器可能在它之前就读到 ref，那样拿到的还是上一次的值。
      valuesRef.current = { draft, providerDraft, keyInputs, storageDraft, pointsDraft };

      /**
       * 自动保存引擎。
       *
       * 三个动作：
       *   - `scheduleSave(partial, immediate)`：控件改动后调用。先**同步**并入
       *     `valuesRef`，再按需立即（开关/下拉）或防抖（文本框）落盘。
       *   - `flush()`：真正发请求。串行、合并，按需分两次（`/config` + `/decisions`）。
       *   - `commitKey(provider)`：密钥的「明确提交」（失焦 / 回车）。
       *
       * 三条不变量（都是这个界面反复踩过的坑）：
       *
       *   1. 同一时刻只有一个请求在飞（`savingRef`）。期间的改动只并入
       *      `valuesRef`，等这次回来再发——并发保存会让两次快照互相覆盖。
       *   2. 响应回来时若用户又改过（`editSeqRef` 变了），**不覆盖草稿**，
       *      只刷新服务端状态。否则「保存中的输入被旧快照冲掉」= 回弹。
       *   3. 失败不丢输入、也不自动重试：原因写进状态行，等用户改或点重试。
       *      自动重试一个注定 400 的请求只会刷屏。
       */
      const flushRef = react.useRef(null);

      /** 同步记录一次改动，并安排落盘（`immediate` 用于离散控件）。 */
      const scheduleSave = (partial, immediate) => {
        valuesRef.current = { ...valuesRef.current, ...(partial ?? {}) };
        editSeqRef.current += 1;
        dirtyRef.current = true;
        // 防抖窗口里就先把状态改成「待保存」：否则这一小段时间还挂着上一次的
        // 「已保存」，用户会以为刚才那一下已经落盘了。
        setSaveState("pending");
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (immediate === true) {
          void flushRef.current();
          return;
        }
        // 文本框：停手 AUTOSAVE_DELAY_MS 之后再落盘，避免每敲一个字符一次请求。
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void flushRef.current();
        }, AUTOSAVE_DELAY_MS);
      };

      /**
       * 明确提交密钥（失焦 / 回车）。
       *
       * 密钥刻意**不**跟着防抖走：粘贴后停一下就把半截 key 写进凭据文件，
       * 是比多点一次更糟的体验。这里只记「这一次是用户按下提交」。
       */
      const commitKey = (provider) => {
        const raw = (valuesRef.current.keyInputs[provider] ?? "").trim();
        // 留空 = 不修改（与旧版一致）；太短的多半是没贴完，不落盘，给一句提示。
        if (raw.length === 0) return;
        if (raw.length < 10) {
          setSaveState({ error: "未保存：密钥太短（至少 10 个字符）" });
          return;
        }
        keyCommitRef.current = provider;
        editSeqRef.current += 1;
        dirtyRef.current = true;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        void flushRef.current();
      };

      /**
       * 落盘一次。
       *
       * 决策点走独立的 `/decisions` 而不是复用 `/config`：那两份配置的校验规则
       * 不同（决策点要拒绝未实装的点），混在一起容易互相放宽。
       */
      const flush = async () => {
        if (savingRef.current === true) return;
        if (dirtyRef.current !== true) return;
        const values = valuesRef.current;
        const seq = editSeqRef.current;
        const keyCommit = keyCommitRef.current;
        const decisionsBody = pendingDecisions(values, decisions);
        // 打字途中的非法地址：整笔延后（服务端必然拒绝，那一次 400 只是噪音）。
        // 决策点与地址无关，仍然照常落盘——否则改个决策点也会被地址卡住。
        const urlProblem = customUrlProblem(
          values.providerDraft.customBaseUrl,
          values.providerDraft.provider,
        );
        // 服务端还没给出字段映射（配置页刚打开、status 尚未回来）。此时无法
        // 知道「模型与 key 该写进 config.yml 的哪一格」，猜一个名字就是把
        // siliconflow 的 key 写进 systemone 的格子——宁可延后并说明原因，
        // 也不能猜着写。状态回来后 dirty 仍为 true，改动会自动补发。
        const modelFields = providerFieldsOf(values.providerDraft.provider, view);
        // 密钥按提交时的 provider 取字段（见 configPatchOf 里的说明）。
        const keyFields =
          keyCommit === null || keyCommit === undefined
            ? null
            : providerFieldsOf(keyCommit, view);
        const mapProblem =
          modelFields === null || (keyCommit != null && keyFields === null)
            ? "配置尚未就绪（服务端未返回 provider 字段映射），请稍后重试"
            : "";
        const problem = urlProblem.length > 0 ? urlProblem : mapProblem;
        const configDeferred = problem.length > 0;
        if (configDeferred === true && decisionsBody === null) {
          setSaveState({ error: t("配置未保存：{problem}", { problem }) });
          return;
        }

        const patch =
          modelFields === null ? {} : configPatchOf(values, keyCommit, modelFields, keyFields);
        // 只要带了 key 就必须写配置：key 不能因为「其它字段没变」被漏掉。
        const keyWritten = keyFields !== null && Object.hasOwn(patch, keyFields.keyField);
        const configNeeded =
          configDeferred !== true
          && (keyWritten === true || patchDiffersFromServer(patch, view, modelFields) === true);

        savingRef.current = true;
        setSaveState("saving");
        setMsg(null);
        setProviderError("");
        /** 失败的到底是哪一半：只有配置那一半才该显示成「provider 配置不可用」。 */
        let failing = "config";
        try {
          if (configNeeded === true) {
            const next = await call("/config", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(patch),
            });
            // 用户又改过：只刷新服务端状态，草稿保留给下一次 flush。
            if (seq === editSeqRef.current) applyServerState(next);
            else setStatus(next);
          }
          failing = "decisions";
          if (decisionsBody !== null) {
            const next = await call("/decisions", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(decisionsBody),
            });
            setDecisions(next);
            // 期间又有改动时不清草稿：那些改动还没落盘，清掉就等于吞了。
            if (seq === editSeqRef.current) {
              setPointsDraft({});
            }
          }
          if (seq !== editSeqRef.current) {
            // 期间的改动由 finally 接着发，这里保持「保存中」。
            setSaveState("saving");
          } else if (configDeferred === true) {
            // 决策点存了，配置那一半还欠着（等地址补全或配置就绪）：**保持 dirty**，
            // 否则原因消失之后没人会再发请求，改动就悄悄丢了。
            dirtyRef.current = true;
            setSaveState({ error: t("配置未保存：{problem}", { problem }) });
          } else {
            dirtyRef.current = false;
            if (keyWritten === true) {
              keyCommitRef.current = null;
              // 存完就清空输入框：与旧版「粘贴 → 保存 → 框变空」一致，
              // 也让「已配置」的提示能立刻反映新值。
              setKeyInputs({ ...values.keyInputs, [keyCommit]: "" });
            }
            setSaveState("saved");
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          // 校验失败（非法 URL / 请求头格式）走这里：保留用户已填内容，
          // 只把原因显示出来——清空表单会让用户重填一遍。
          // dirty 保持 true：失败的那一半（可能是决策点）还没落盘，
          // 重试按钮与后续编辑都要能把它带上。
          dirtyRef.current = true;
          setSaveState({ error: text });
          if (failing === "config") setProviderError(text);
        } finally {
          savingRef.current = false;
          // 保存期间用户又改过：立刻再发一次，不等防抖（他已经停手了）。
          if (dirtyRef.current === true && seq !== editSeqRef.current) void flush();
        }
      };
      flushRef.current = flush;

      /** 状态行的「重试」：把上一次失败的值原样再发一遍。 */
      const retrySave = () => {
        dirtyRef.current = true;
        void flushRef.current();
      };

      const runTest = react.useCallback(async () => {
        setBusy("test");
        setMsg(null);
        setProviderError("");
        try {
          const result = await call("/test", { method: "POST" });
          // 服务端返回的整段诊断（provider / 端点 / HTTP 码 / 请求 id / 响应体）
          // 原样展示：只报「失败」而不给细节，用户无法判断该改地址还是改 key。
          setMsg({
            ok: result.ok === true,
            text: result.ok === true
              ? t("端点连通 ✅\n{text}", { text: result.text ?? "" })
              : tr(result.text ?? "") || t("端点返回失败"),
          });
          if (result.ok !== true) setProviderError("端点不可用：请对照上方诊断检查 provider、base URL 与 API key");
        } catch (error) {
          setMsg({ ok: false, text: error.message });
          setProviderError(error.message);
        } finally {
          setBusy("");
        }
      }, []);

      /**
       * 「重新获取」（DEC-030）：强制服务端刷新一次下发值。
       *
       * 为什么要一条单独的路由：保存配置时服务端按缓存与过期时间决定拉不拉
       * （没过期就复用），而用户点这个按钮表达的是「现在就要一份新的」。
       * 返回形状与 `/status` 相同，所以直接走 `applyServerState`——草稿与
       * 服务端状态一次对齐，不会出现「界面显示旧值、服务端已是新值」。
       */
      const reloadServerProvider = async () => {
        setBusy("serverProvider");
        setMsg(null);
        try {
          const next = await call("/server-provider", { method: "POST" });
          applyServerState(next);
        } catch (error) {
          setMsg({ ok: false, text: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy("");
        }
      };

      /**
       * 删除当前 provider 的 API Key（DEC-080）。
       *
       * 先确认再发请求：密钥正在被使用时误删会让守卫全部降级放行，而界面上
       * 只少了一把 key——那是最难自查的故障形态。服务端按当前 keyStorage
       * 删对应位置的那一把，其它 provider 与模型 / 地址配置都不动。
       */
