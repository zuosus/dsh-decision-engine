                                // 三态分段是离散控件：点一下就落盘。
                                scheduleSave({ pointsDraft: next }, true);
                              },
                              // 选中态与框线都交给 client.config.css 的
                              // `.de-cfg__seg-item[aria-pressed]` 规则（DEC-085）：
                              // 内联色会被 DEC-070 的 `!important` 规则覆盖。
                            },
                            mode === "off" ? "关闭" : mode === "observe" ? "观察" : "生效",
                          ),
                        ),
                      ),
                  changed ? h("span", { style: { ...S.badge, borderStyle: "solid", opacity: 0.9 } }, "保存中") : null,
                );
              }),
              // 缓存命中：0 命中说明白名单外的调用每次都真发请求，是主要浪费。
              // 只展示精确命中——「同类复用」软层已改为显式启用（默认关闭，
              // 授权点永久禁用），命中率里若含软层命中，通常是某个点显式开了。
              h(
                "div",
                { style: S.pointMeta, key: "cache" },
                t("缓存 {size} 条 · 精确命中 {hits} · 命中率 {rate}%", {
                  size: decisions.cache?.size ?? 0,
                  hits: decisions.cache?.exactHits ?? 0,
                  rate: Math.round((decisions.cache?.hitRate ?? 0) * 100),
                }),
              ),
            ),
      ];

      const recordItems = [
        // ③ 记录与展示：决策历史记不记，审批卡长什么样。
        //   与「判不判」是两件事——观察模式下往往才是用户真正想要的。
        // 3c) 决策历史（DEC-022 / DEC-026）：会话里的那个标签页。
        //
        // 放在「真正拦截」之后、「人工审核比例」之前：它与守卫的开关是**两件事**
        // ——守卫决定「判不判」，这个决定「记不记」，后者在观察模式下往往
        // 才是用户真正想要的。
        //
        // **一个开关管全部**（DEC-026 / DEC-029）：曾经这里还有一个「决策内容」
        // 子开关，只在上面这个开着时出现。两个开关表达的是同一件事（「这个功能
        // 要不要用」），却要求用户先做一次「记不记」的决策、再做一次「记多细」的
        // 决策——而后者根本不是日常选择。现在合成一个：开 = 记录明细（含内容）
        // 并挂标签页；关 = 完全不写文件。
        //
        // DEC-029 把这个合并做彻底了：那个「只存元数据」的隐藏档位（`config.yml`
        // 的 `decisionsCapture`）已退役。它不在配置页出现，却能在暗处把每一条
        // 记录降级成元数据——用户看到的开关和真实行为不一致，这正是缺陷本身。
        // 现在没有第二个档位：开关开着就一定带内容，不想要内容就把功能关掉。
        //
        // 关闭时服务端**完全不写**明细文件（不是「写了藏起来」）：用户说不
        // 记录，就该真的不落盘。
        row(
          "决策历史",
          draft.decisionsTabEnabled === true
            ? t("把本会话里经本插件做出的每次决策按时间记下来，并在会话里新增一个「决策历史」标签页")
            : t("关闭后不写任何明细文件（不采集内容、不占磁盘）"),
          toggle(draft.decisionsTabEnabled === true, () => {
            const next = draft.decisionsTabEnabled !== true;
            setDraft({ ...draft, decisionsTabEnabled: next });
            scheduleSave({ draft: { ...draft, decisionsTabEnabled: next } }, true);
          }),
          "decisionsTabEnabled",
        ),
        // 3c2) 审批卡正文可读化（DEC-042，DEC-043 起默认开启）。
        //
        // 放在「决策历史」之后、「人工审核比例」之前：它与上面那些是**同一类**
        // 用户可见体验（审批卡长什么样），而不是守卫的判据。
        //
        // 默认开启：宿主把命令原文塞进一个会折叠换行的块里，heredoc 脚本读不出
        // 结构，而「读得懂」正是本插件的用途。仍可关掉——关掉就回到宿主渲染，
