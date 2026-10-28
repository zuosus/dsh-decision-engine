/**
 * Workers Builds 的「root directory not found」= 配置指向的路径在仓库里不存在。
 *
 * 2026-10-28 实测（Cloudflare Workers Builds，Worker `dsh-worker`）：
 *
 *   提交            check run          结果
 *   ──────────────  ─────────────────  ────────────────────────
 *   047c3283 (前)   （无）             不触发构建
 *   4ef171f         （无）             不触发构建
 *   755fd28a        Workers Builds     failure
 *   d1ea5c3e        Workers Builds     failure
 *   8dd4e7c4        Workers Builds     failure
 *   f7c2ac94        Workers Builds     failure
 *
 *   四次失败都是同一个错：
 *
 *     Initializing build environment...
 *     Success: Finished initializing build environment
 *     Cloning repository...
 *     Failed: root directory not found
 *
 * 判读要点（这三条决定了怎么定位）：
 *
 *   1. **错在 clone 之后、build 之前**。所以不是依赖装不上、不是构建脚本写错、
 *      不是 wrangler 配置有语法错误——构建根本没开始跑。往「检查 package.json /
 *      改 build command」方向找是白找。
 *
 *   2. **Root directory 是建站时设的，不会跟着仓库长出来**。本例里 site/ 目录
 *      是在连好 Workers Builds 之后才提交进仓库的（4ef171f），而 Root directory
 *      指向的正是 site/。连的时候路径不存在，Cloudflare 不报错，只是每次构建
 *      到 clone 阶段就失败。
 *
 *   3. **「没有 check run」和「失败的 check run」是两回事**，前者说明构建压根没
 *      触发（路径不存在时直接跳过），后者才是触发了但失败。别把「历史提交没有
 *      check run」当成「历史提交构建成功了」。
 *
 * 另一个坑：**Root directory 改成仓库根也不一定对**。Workers Builds 会在
 * Root directory 及其仓库根执行自动依赖安装（npm ci）。本仓库根 package.json
 * 的 peerDependencies 里有 @deepseek-ai/dsh-session，它依赖的
 * @deepseek-ai/dsh-type-meta 不在公共 npm registry 上（实测 E404），
 * 自动安装会直接失败。宿主自带的包不该由插件仓库去装。
 *
 * 定位手法（没有权限读构建配置时也能用）：
 *
 *   - GitHub check run 的 name（"Workers Builds: <worker>"）区分是哪个 Worker；
 *   - started_at 与用户看到的构建日志时间戳对得上，确认是同一次构建；
 *   - details_url 里有 build UUID；
 *   - 同一仓库里哪些提交「有 check run」、哪些「没有」，能反推配置变更的时点；
 *   - 本地 clone 后手动跑一遍 build + wrangler deploy --dry-run，
 *     把「代码有问题」和「配置有问题」分开。
 */
