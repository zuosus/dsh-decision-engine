    /**
     * 参数化文案表：中文模板 → 英文模板，占位写成 `{name}`。
     *
     * 与静态表分开，是因为模板里带着变量hole，整段永远不可能命中；
     * 调用点必须显式写 `t("按「{label}」排序", { label })`。
     */
    /** i18n:templates:config */
    const T_CONFIG = {
      "配置未保存：{problem}": "Configuration not saved: {problem}",
      "端点连通 ✅\n{text}": "Endpoint reachable ✅\n{text}",
      "已验证可用：{endpoint}": "Verified working: {endpoint}",
      "该端点 model 必填；留空 = 用预设默认 {model}": "This endpoint requires a model; leaving it empty uses the preset default {model}",
      "默认（{model}）": "Default ({model})",
      "{model}（当前值）": "{model} (current)",
      "（已配置 {hint}）": "(configured {hint})",
      "存到插件配置 config.yml 的 {field}（明文）": "Stored in the plugin config config.yml under {field} (plaintext)",
      "存到 .credentials.yaml 的 {ref}": "Stored in .credentials.yaml as {ref}",
      "存进插件配置 config.yml 的 {field}（自包含，便于随目录备份；注意是明文）": "Stored in the plugin config config.yml under {field} (self-contained, easy to back up with the directory; note it is plaintext)",
      " · 已判 {requests} 次，缓存 {cached}，{tokens} token，均 {latency}ms": " · {requests} judged, {cached} cached, {tokens} tokens, avg {latency}ms",
      "触发闸：{gate}": "Gate: {gate}",
      "缓存 {size} 条 · 精确命中 {hits} · 命中率 {rate}%": "{size} cached · {hits} exact hits · hit rate {rate}%",
      "提供方 {provider} · 端点 {endpoint}": "Provider {provider} · endpoint {endpoint}",
      "模型 {model} · 超时 {timeout}ms · 请求 {requests} 次（缓存 {cached}）": "Model {model} · timeout {timeout}ms · {requests} requests ({cached} cached)",
      "密钥来源 {source}": "API key from {source}",
      // —— 使用免费模型（DEC-030，原名「跟随服务端下发」，DEC-037 改名） ——
      "服务端下发：{baseUrl} · 模型 {model} · 密钥 {hint}": "Server-issued: {baseUrl} · model {model} · key {hint} (in memory only, never written to disk)",
      "服务端不可用：{error}；已回落到本地手动配置": "Server unavailable: {error}; fell back to the local manual configuration",
      " · 获取于 {time}": " · fetched at {time}",
      "；当前生效的是服务端下发的密钥": "; the API key currently in effect comes from the server",
      // —— 人工审核比例（DEC-035） ——
      "校准中 {samples}/{min} 次授权决策（当前用冷启动阈值 {fallback}）": "Calibrating {samples}/{min} authorization decisions (using the cold-start threshold {fallback})",
      "已按这个模型校准：最前的 {percent}% ≈ 严重度 {threshold}（{samples} 个样本）": "Calibrated for this model: top {percent}% ≈ severity {threshold} ({samples} samples)",
      "人工审核比例已设为「{level}」": "Review tolerance set to \"{level}\"",
      "保存失败：{error}": "Save failed: {error}",
      "确定删除 {provider} 的 API Key 吗？此操作不可撤销。": "Delete the API key for {provider}? This cannot be undone.",
      "已删除 {provider} 的 API Key": "Deleted the API key for {provider}",
    };

    /** i18n:templates:stats */
    const T_STATS = {
      "按「{label}」排序": "Sort by “{label}”",
      "本区间共 {count} 条记录，但没有一条来自观察模式——现在看到的节省量 0 是「没有可比对的数据」，不是「一点也没省」。把相关决策点切到「观察」后即可看到对比。": "{count} records in this range, but none from observe mode — the 0 savings you see means \"no comparable data\", not \"nothing was saved\". Switch the relevant decision points to \"observe\" and the comparison will appear.",
      "实际区间：{start} → {end}": "Actual range: {start} → {end}",
      "统计读取失败：{error}": "Failed to load statistics: {error}",
      "有 {count} 条裁决未归类：": "{count} unclassified verdicts: ",
      "本节只统计「观察」模式的记录（本次 {count} 条）。": "This section counts observe-mode records only ({count} this time).",
      "这段时间没有观察模式的记录，无法对比普通 LLM 路径与决策模型路径。把相关决策点切到「观察」后，这里才会出现可比对的节省量。": "No observe-mode records in this period, so the ordinary LLM path and the decision-model path cannot be compared. Switch the relevant decision points to \"observe\" and comparable savings will appear here.",
      "{verdict}（{count}）": "{verdict} ({count})",
      "、": ", ",
      "本区间按模式分账：观察 {observe} 条": "This range by mode: observe {observe}",
      " · 生效 {enforce} 条": " · enforce {enforce}",
      " · 关闭 {off} 条": " · off {off}",
      " · 未知模式（历史） {unknown} 条。": " · unknown mode (legacy) {unknown}.",
      "含 {count} 条由旧遥测推算的历史记录：": "Includes {count} legacy records inferred from old telemetry: ",
      "统计文件：{path}": "Stats file: {path}",
      " · 已写 {count} 条": " · written {count}",
      " · 写盘失败 {count} 条": " · write failures {count}",
      " · 队列溢出丢弃 {count} 条": " · dropped on queue overflow {count}",
      // —— 图表（统计页）——
      "{label}：本区间没有数据": "{label}: no data in this range",
      "{label}随时间变化": "{label} over time",
      "{label}：没有可对比的基线": "{label}: no baseline to compare against",
      "{label}：本区间没有可对比的变化": "{label}: no comparable change in this range",
      "{label}：{value}": "{label}: {value}",
      "{label}：实际 {real}，基线 {base}": "{label}: actual {real}, baseline {base}",
      "{label}（实际 vs 基线）": "{label} (actual vs baseline)",
      "裁决构成：放行 {allow}、询问 {ask}、拦截 {reject}": "Verdict mix: allow {allow}, ask {ask}, reject {reject}",
      "按{bucket}分桶，共 {count} 个桶；空桶补 0，掉到零就是真的没有请求。": "Bucketed by {bucket}, {count} buckets; empty buckets are zero-filled, so a drop to zero really means no requests.",
      "前 {count} 个组合的请求次数对比": "Requests for the top {count} combinations",
      "按决策点分账：{parts}": "Breakdown by decision point: {parts}",
      "{label}对比：{parts}": "{label} compared: {parts}",
      "把鼠标移到图上看某一格的具体值": "Hover the chart to read a single point",
      // 走势图无障碍摘要的补充：读屏用户看不见线型，虚线的含义只能写进摘要。
      // 英文值前面那个空格是**拼接**用的——它跟在摘要后面，中文用全角括号自带间隔。
      "（虚线为未来 {count} 个桶，尚未发生）": " (the dashed segment covers {count} buckets that have not happened yet)",
      "统计页渲染失败": "Stats page failed to render",
      "数字本身没有丢：切回「配置」再切回来，或在 Console 里看完整堆栈。这条提示是为了让异常不再表现为整页空白。": "The numbers are not lost: switch back to \"Config\" and return, or read the full stack in the console. This notice exists so a failure is no longer a blank page.",
      "完整堆栈": "Full stack",
      "已隐藏": "hidden",
      "所有决策点都被隐藏了，点击下面的图例可以重新显示。": "All decision points are hidden. Click a legend item below to show one again.",
      "点击重新显示「{label}」": "Click to show \"{label}\" again",
      "点击隐藏「{label}」，方便查看其他决策点的比例": "Click to hide \"{label}\" so the other decision points' shares are easier to compare",
      "已隐藏 {count} 个决策点（占全量 {share}），图中的比例按剩余部分重新计算。": "{count} decision points hidden ({share} of the total); the shares in the chart are recalculated from what remains.",
    };


    /** i18n:templates:misc */
    const T_MISC = {
      "（{detail}）": "({detail})",
      "· {tool}": "· {tool}",
      // —— 决策历史（DEC-022）——
      "记录文件：{path}": "Records file: {path}",
      "读取决策历史失败：{error}": "Failed to load decision history: {error}",
      "只落本地，永不外传": "Stored locally only, never sent anywhere",
      "把本会话里经本插件做出的每次决策按时间记下来，并在会话里新增一个「决策历史」标签页": "Record every decision this plugin made in this session, and add a \"Decisions\" tab to the session",
      "关闭后不写任何明细文件（不采集内容、不占磁盘）": "When off, no detail file is written at all (no content is captured, no disk is used)",
      // —— 人工审核比例（DEC-035）：当前档位的比例说明 ——
      // 落点标签只用档位名（宽度所限，见 toleranceShortLabel 的注释），
      // 比例放轨道下方那一行，所以这里是**整句**而不是肢解的片段。
      "当前档位只问最前 {percent}% 的调用": "This level asks only on the top {percent}% of calls",
      "分位数窗口按 provider × model 分开，换模型会重新校准；高风险调用一律直接拦下（四档一致）": "The percentile window is kept per provider × model, so switching models re-calibrates; high-risk calls are always blocked outright (the same in all four levels)",
      // —— 审批卡正文可读化（DEC-042）：带数字的摘要行 ——
      "命令摘要：{summary}": "Command summary: {summary}",
      "{steps} 个步骤": "{steps} steps",
      " · 含 {count} 个危险动作": " · {count} risky actions",
      " · 另有 {count} 个步骤未展开": " · {count} more steps not expanded",
      "执行一段脚本（{lines} 行）": "Runs a script ({lines} lines)",
      "执行一段内联脚本（{lines} 行）": "Runs an inline script ({lines} lines)",
      "：{summary}": ": {summary}",
      // —— 连续慢调用（DEC-090）：tab 图标的悬浮说明 + 内容顶部横幅 ——
      "连续 {count} 次决策调用超过 {seconds} 秒": "{count} consecutive decision calls took longer than {seconds}s",
      "最近连续 {count} 次决策调用都超过 {seconds} 秒（最近一次 {last}）。服务商可能正在变慢：工具授权这类判断会拖慢每一步操作。可以降低「人工审核比例」、换一个 provider，或先把耗时最高的决策点关掉。": "The last {count} decision calls in a row each took longer than {seconds}s (most recent: {last}). Your provider may be slowing down: judgements like tool authorization now delay every step. You can lower the review tolerance, switch providers, or turn off the decision points that cost the most time.",
    };

    const T = Object.assign(Object.create(null), T_CONFIG, T_STATS, T_MISC);

