/**
 * 作用域边界：哪些决定**不属于本插件**，遇到时必须让位给用户。
 *
 * ## 为什么要单独一层
 *
 * 本插件的定位是「便宜的判断层」：在主模型动手之前，用一个小模型回答
 * 几个结构化问题，然后放行 / 询问 / 拦下，或者换个更省的模型去做。
 *
 * 但有几类决定**天然不属于**这个定位——它们要么关系到不可逆的后果，
 * 要么需要人的偏好，要么需要真实的事实：
 *
 *   1. **写入非工作区**（能不能写到工作区外面去）
 *   2. **在模型给出的几套方案里替用户选一个**
 *   3. **模型有关键问题没问清楚，需要人来定**
 *
 * 这三类一旦由插件的决策模型替用户拍板，就是**用一个小模型的猜测代替人的
 * 意思**。用户以为是自己决定的，其实是模型猜的；而且事后从记录里看不出来
 * （记录只写「放行」，不写「这是我替你选的」）。这类错误比插件什么都不做更糟。
 *
 * ## 「能不能分清」的诚实答案：分两种
 *
 * 用户问的是「能不能分辨这些问题」。答案不是简单的「能」或「不能」，而是
 * 按**可观测性**分成两类（核对宿主的结论见 DEC-045）：
 *
 *   - **能确定性分辨的：越出工作区。**
 *     写根集合由宿主的 `ctx.sandboxPolicy` 给出（`workspaceRoot` +
 *     `additionalWritableRoots`），目标路径是工具参数里的字面量。两者都是
 *     数据，**不需要模型、也不需要猜**。
 *
 *   - **不能确定性分辨的：模型是不是在等用户。**
 *     「这一轮是在问你事实 / 让你从几套方案里挑一个」与「这一轮是在接着
 *     干活」的区别，**只存在于模型的意图里**。宿主没有「本轮在等用户」
 *     这个状态位：`turn/end` 的 reason 是一个封闭集合（completed / blocked /
 *     max-tokens / interrupted / aborted / error），**没有 ask / question 成员**；
 *     `agent/turn-stopping` 的载荷里也没有 reason 字段。
 *
 * 所以本模块的做法是：**能用确定性判的用确定性判；判不了的，交给模型判，
 * 但模型判出来的结果只能用来「让位」（停止干预），不能用来「代替用户做决定」**。
 *
 * ## 让位与代替的区别
 *
 * 这是本模块最核心的一条界线：
 *
 *   让位（defer）  插件不介入，把决定权原样交还用户 / 主模型。
 *                 代价是「没省下来」，收益是「没有人被小模型越权代替」。
 *   代替（decide） 插件替用户做决定。这条路本模块**不存在**。
 *
 * 因此「模型判断这是敏感场景」的结果**只有一个方向**：
 * `敏感 → 插件退出这个决定`。它**不会**变成「所以我替你选了方案 A」或
 * 「所以我替你回答了这个问题」。
 *
 * @module dsh-decision-engine/scope
 */

/**
 * 敏感场景的几种类型。
 *
 * 用字符串而非枚举对象：这几个词会直接进遥测的 `scope` 字段与统计口径，
 * 字符串更便于跨版本对齐，也不会在遍历时多出一层。
 */
export const SCOPE_KINDS = {
  /** 写入目标落在工作区写根之外。 */
  outsideWorkspace: "outside-workspace",
  /** 这一轮在等用户决定（澄清问题 / 让你从几套方案里挑一个）。 */
  awaitingUser: "awaiting-user",
};

/** 插件自己决定的范围（没有落到上面任何一种敏感场景）。 */
export const SCOPE_NONE = "none";

/**
 * 判定一个路径是否落在给定的写根集合之内。
 *
 * 刻意**只做词法判断**，不做 realpath：
 *
 *   - realpath 需要 IO，而这个判断发生在**每次工具调用**的热路径上；
 *   - 宿主**自己**在写入前会做 realpath + dev/ino 的祖先链校验
 *     （`dsh-fs-sandbox` 的 `checkedTarget`），插件再做一遍只会得到
 *     「宿主会拦」这个我们本来就知道的结论；
 *   - 词法判断漏掉的符号链接逃逸，宿主那一层仍然会拦——插件不需要比宿主
 *     更严，只需要**不比宿主更松**。
 *
 * 词法判断漏掉的**唯一**危险方向是「看起来在工作区内、实际通过符号链接
 * 指向外面」。这一条由宿主兜住：写入真的发生前，`checkedTarget` 会重新解析
 * 目标并检查它是否落在写根之下。本模块的职责是**不要在越界时替用户拍板**，
 * 而不是**替代沙箱**。
 *
 * @param target - 待判定的路径（绝对或相对于 `cwd` 的路径）。
 * @param roots - 允许写入的根目录（绝对路径）。
 * @param cwd - 相对路径的基准目录。
 * @returns 是否落在某个根之内。无法判断（路径非法、根为空）时返回 true——
 *   **宁可漏判也不误判**：误判会把一次正常写入挡下来（用户白挨一次询问），
 *   漏判只是让宿主那一层去拦，而宿主是**确定性地**拦得住的。
 */
export function isUnderRoots(target, roots, cwd) {
  if (typeof target !== "string" || target.length === 0) return true;
  if (!Array.isArray(roots) || roots.length === 0) return true;
  const base = typeof cwd === "string" && cwd.length > 0 ? cwd : "";
  const absolute = isAbsolutePath(target) ? normalizePath(target) : joinPath(base, target);
  for (const root of roots) {
    if (typeof root !== "string" || root.length === 0) continue;
    const normalizedRoot = normalizePath(root);
    if (normalizedRoot === "/") return true;
    if (absolute === normalizedRoot) return true;
    if (absolute.startsWith(`${normalizedRoot}/`)) return true;
  }
  return false;
}

/** 是否是绝对路径（POSIX 与 Windows 两种拼写都认）。 */
function isAbsolutePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 词法归一：消掉 `.`、`..` 与重复分隔符。
 *
 * 刻意**不做**符号链接解析（理由见 `isUnderRoots` 的注释）。
 */
function normalizePath(path) {
  const unified = path.replace(/\\/g, "/");
  const isAbsolute = unified.startsWith("/");
  const parts = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // 绝对路径的 `..` 不能越过根；相对路径的 `..` 保留为一段（后面拼回）。
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!isAbsolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (isAbsolute) return `/${joined}`;
  return joined.length > 0 ? joined : ".";
}

/** 拼接基准目录与相对路径。 */
function joinPath(base, relative) {
  if (base.length > 0) {
    const normalizedBase = normalizePath(base);
    const normalizedRelative = normalizePath(relative);
    if (normalizedRelative.startsWith("/")) return normalizedRelative;
    return normalizePath(`${normalizedBase}/${normalizedRelative}`);
  }
  return normalizePath(relative);
}

/**
 * 从工具参数里取出一个「可能指向工作区外的路径」。
 *
 * 只认**明确的路径字段**与 `apply_patch` 的补丁头——不做任何猜测：
 *
 *   - `file_path` / `path` / `file`：写文件类工具的参数名；
 *   - `apply_patch` 的 `input`：`*** Update File: …` / `*** Add File: …` /
 *     `*** Delete File: …` / `*** Move File: …` 四种头。
 *
 * 刻意**不**从 `command`（bash）里解析路径：shell 命令里的路径形式没有边界
 * （引号、变量展开、子 shell、重定向、`cd`），词法判断在那个场景下只会
 * 给出**看似确定、实则随机**的结论——那比「不判」更糟。
 * bash 的越界写入由宿主沙箱（seatbelt / landlock / ACL）确定性地管着，
 * 不需要插件在这里猜。
 *
 * @param tool - 工具名。
 * @param args - 该次调用的参数对象。
 * @returns 路径字符串或 undefined；没有明确路径时返回 undefined。
 */
export function pathTargetOf(tool, args) {
  if (args === null || typeof args !== "object") return undefined;
  const direct = args.file_path ?? args.path ?? args.file;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (tool === "apply_patch" && typeof args.input === "string") {
    const match = args.input.match(/^\*\*\* (?:Update|Add|Delete|Move) File: (.+)$/m);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return undefined;
}

/**
 * 判断一次工具调用是否涉及「写入工作区之外」。
 *
 * @param options.tool - 工具名。
 * @param options.args - 工具参数。
 * @param options.roots - 工作区写根（绝对路径数组）。
 * @param options.cwd - 相对路径的基准目录（通常是会话工作目录）。
 * @returns
 *   `{ kind: "outside-workspace" }` —— 目标确定在写根之外；
 *   `{ kind: "none" }` —— 没有明确路径，或路径落在写根之内。
 */
export function classifyWorkspaceTarget(options) {
  const target = pathTargetOf(options.tool, options.args);
  if (target === undefined) return { kind: SCOPE_NONE };
  if (isUnderRoots(target, options.roots, options.cwd)) return { kind: SCOPE_NONE };
  return { kind: SCOPE_KINDS.outsideWorkspace };
}
