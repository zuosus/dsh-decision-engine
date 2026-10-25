# 本地开发：把仓库链进 DSH profile

改代码 → 重启 DSH → 生效。

## 做法

profile 的 `node_modules/dsh-decision-engine` 是**软链**指向本仓库：

```
~/.dsh/profiles/desktop/node_modules/dsh-decision-engine -> /Users/chi/Code/dsh-decision-engine
```

profile 的 `package.json` 里对应声明必须是 `link:` 形式：

```json
"dsh-decision-engine": "link:/Users/chi/Code/dsh-decision-engine"
```

**为什么不能只是手动建软链**：profile 用 pnpm 管理（`nodeLinker: hoisted`），
而 `package.json` 里若仍写 `"0.6.0"`，下一次 `pnpm install` 会照 lockfile
把 registry 版本装回去，**软链被覆盖**。改成 `link:` 后 pnpm 认得它是
本地链接，重装也保留。

已验证：`pnpm install` 之后软链仍是符号链接。

## 回退到 registry 版本

```sh
cd ~/.dsh/profiles/desktop
# 1. 改回版本号
#    "dsh-decision-engine": "0.6.0"
# 2. 重装
pnpm install
```

## 注意

- **改配置是热加载**（`config.yml` 改了立刻生效，不用重启）。
- **改代码必须重启 DSH**：插件在启动时加载。
- `pnpm install` 第一次把 `link:` 接上时，会把仓库 `package.json` 的版本号
  从 `0.6.0` 改写成 `0.6.1`（pnpm 的行为）。这是**一次性**的，之后
  `Already up to date` 不再动它。版本号被改了直接 `git checkout package.json` 还原。

## 测试

```sh
cd /Users/chi/Code/dsh-decision-engine
node --test test/          # 190 项
node scripts/verify-wiring.mjs
```

> Node 24（DSH 自带 runtime）不支持 `node --test test/` 这种目录参数，
> 会报 `Cannot find module '.../test'`。用显式 glob 即可：
> `node --test "test/*.test.js"`。Node 26（homebrew）两种写法都行。
