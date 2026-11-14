// 英文版页面内容。结构与 content（build.mjs 中的中文段落）逐节对应，
// 章节 id 保持一致（#what / #install / #config / #points / #providers /
// #tokens / #failopen / #verify），中文页的锚点链接可以直接复用。
import { codeBlock, table, figure, fact, DECISION_ICON, FLATMAP_ICON } from "./partials.mjs";

// 页面不展示版本号：版本随时会更新，不显示以免挂旧号。

/* ------------------------------------------------------------------ *
 * Home (en)
 * ------------------------------------------------------------------ */

export const indexBodyEn = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness plugin index</span>
  <h1>A small set of <span class="grad">plugins</span><br>for DeepSeek Harness</h1>
  <p class="lede">
    <strong>dsh.zuos.us</strong> collects DeepSeek Harness (DSH) plugins.
    All free, open source, MIT, ready to use — pick one below for its guide
    and install steps.
  </p>
</div>

<div class="wrap"><hr class="rule"></div>

<section class="wrap">
  <h2>Plugins</h2>
  <p class="sub">Two so far. Click a title to open its page.</p>

  <div class="projects">
    <a class="project" href="/en/dsh-decision-engine/">
      ${DECISION_ICON}
      <div>
        <h3>dsh-decision-engine</h3>
        <p>
          Before the main model acts, a cheap small model judges — allow, ask,
          block, switch to a cheaper model, or skip an expensive call. Eight
          decision points, individually switchable.
        </p>
        <div class="toc">
          <span class="badge green">Observe-only by default</span>
          <span class="badge blue">Any decision endpoint</span>
          <span class="badge gray">MIT</span>
        </div>
      </div>
      <span class="go">Read more →</span>
    </a>

    <a class="project" href="/en/dsh-model-flatmap/">
      ${FLATMAP_ICON}
      <div>
        <h3>dsh-model-flatmap</h3>
        <p>
          Replaces the model picker with one flat panel: every model and
          reasoning level at once, no submenus, with search and grouping.
          Disabling restores the native control.
        </p>
        <div class="toc">
          <span class="badge green">Flat, no submenus</span>
          <span class="badge blue">Theme-aware</span>
          <span class="badge gray">MIT</span>
        </div>
      </div>
      <span class="go">Read more →</span>
    </a>
  </div>
</section>

<section class="wrap">
  <h2>Shared rules</h2>
  <p class="sub">Every plugin here follows these, so they are safe to leave installed.</p>
  <div class="facts">
    ${fact("fail-open", "<strong>Uncertainty passes through.</strong>Any error falls back to native behavior; a failing guard never blocks a tool call.")}
    ${fact("shadow first", "<strong>Observe, then enforce.</strong>Records judgments by default; switch to enforce only once they hold up.")}
    ${fact("cheap by design", "<strong>Spend less, never more.</strong>Intervene only to replace or prevent a more expensive call.")}
  </div>
</section>
`;

/* ------------------------------------------------------------------ *
 * Plugin page (en)
 * ------------------------------------------------------------------ */

const pointsTableEn = table(
  ["#", "Decision point", "Hook", "Trigger gate", "What it saves"],
  [
    [
      "1",
      "<strong>Tool authorization</strong>",
      "<code>tools/pre-execute</code>",
      "Read-only tools / auto presets / excluded tools pass straight through",
      "Replaces auto-review: ~60k tokens saved per call",
    ],
    [
      "2",
      "<strong>Model routing</strong>",
      "<code>agent/request</code>",
      "First N steps per turn only; skip if route unchanged or new user input",
      "~20–40% of main-channel tokens",
    ],
    [
      "3",
      "<strong>Subtask delegation</strong>",
      "<code>agent/pre-step</code>",
      "Only the first step of a turn, and only with new user input",
      "One avoided spawn = one whole context saved",
    ],
    [
      "4",
      "<strong>Context compaction</strong>",
      "<code>agent/pre-step</code> → <code>ctx.compaction</code>",
      "Only when measured tokens reach 70% of the trigger line",
      "Skips one summarisation call",
    ],
    [
      "5",
      "<strong>Turn continuation</strong>",
      "<code>agent/turn-stopping</code>",
      "At most one steer per turn",
      "Avoids a wasted full turn",
    ],
    [
      "6",
      "<strong>Retrieval necessity</strong>",
      "<code>tools/pre-execute</code>",
      "Retrieval tools only; zero overhead for everything else",
      "Saves search and result tokens",
    ],
    [
      "7",
      "<strong>Skill selection</strong>",
      "<code>tools/pre-execute</code>",
      "Only the <code>skill</code> tool, and only with a non-empty candidate list",
      "Saves 2–5k per wrong load",
    ],
    [
      "8",
      "<strong>COT translation gate</strong>",
      "<code>cotTranslation.translate()</code>",
      "Local pre-filter + same-text cache",
      "Saves per-message translation calls",
    ],
  ]
);

const providersTableEn = table(
  ["Provider", "Default base URL", "Endpoint", "Key variable", "Default model"],
  [
    [
      "<code>system one</code>",
      "<code>https://api.typesafe.ai/v1</code>",
      "<code>/v1/systemone</code>",
      "<code>TYPESAFE_API_KEY</code>",
      "server default",
    ],
    [
      "<code>bamboonode</code>",
      "<code>https://api.bamboonode.dev/v1</code>",
      "<code>/v1/decisions</code>",
      "<code>BAMBOO_API_KEY</code>",
      "server default",
    ],
    [
      "<code>siliconflow</code><br><span class='badge gray'>CN site</span>",
      "<code>https://api.siliconflow.cn/v1</code>",
      "<code>/v1/systemone</code>",
      "<code>SILICONFLOW_API_KEY</code>",
      "<code>Kev-4B</code>",
    ],
    [
      "<code>siliconflow-intl</code><br><span class='badge gray'>intl site</span>",
      "<code>https://api.siliconflow.com/v1</code>",
      "<code>/v1/systemone</code>",
      "<code>SILICONFLOW_INTL_API_KEY</code>",
      "<code>Kev-4B</code>",
    ],
    [
      "<code>perplexity</code><br><span class='badge gray'>unverified</span>",
      "<code>https://api.perplexity.ai</code>",
      "auto (404 fallback)",
      "<code>PERPLEXITY_API_KEY</code>",
      "<code>sonar</code> (placeholder)",
    ],
    [
      "<code>openrouter</code><br><span class='badge gray'>unverified</span>",
      "<code>https://openrouter.ai/api/v1</code>",
      "auto (404 fallback)",
      "<code>OPENROUTER_API_KEY</code>",
      "<code>openai/gpt-4o-mini</code> (placeholder)",
    ],
    [
      "<code>custom</code>",
      "user-provided (required)",
      "per endpoint style",
      "<code>DECISION_ENGINE_CUSTOM_KEY</code>",
      "<code>customModel</code>",
    ],
  ]
);

const degradeTableEn = table(
  ["Situation", "Degradation code"],
  [
    ["Plugin disabled / read-only tool / auto preset / excluded", "no judgement, passes through"],
    ["No API key", "<code>no-key</code>"],
    ["Failure cooldown active", "<code>cooldown</code>"],
    ["Endpoint 4xx / 5xx", "<code>http-404</code> / <code>http-500</code> … (with endpoint, body)"],
    ["Network unreachable", "<code>network-error</code>"],
    ["Timeout", "<code>timeout</code> (with timeoutMs)"],
    ["Non-JSON / non-object response", "<code>invalid-json</code> / <code>invalid-response</code>"],
    ["Missing <code>answers</code> field", "<code>missing-answers</code>"],
    ["Provider unusable (e.g. invalid custom base URL)", "<code>invalid-base-url</code>"],
    ["Auth rejected (401/403)", "<code>auth-failed</code>"],
    ["Answer shape mismatch", "<code>answer-shape-mismatch</code>"],
    ["Caller aborted the request", "<code>caller-aborted</code>"],
  ]
);

export const pluginBodyEn = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness plugin · MIT</span>
  <h1>dsh-decision-engine</h1>
  <p class="lede">
    Before the main model acts, a <strong>cheap small model</strong> answers four
    questions — <strong>risk, reversibility, task relevance, injection
    suspicion</strong> — and the result is to allow, ask, block, switch to a
    cheaper model, or skip an expensive call entirely. Defaults to
    <code>shadow</code>: record only, never interrupt.
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="#install">Install</a>
    <a class="btn" href="#points">Eight decision points</a>
    <a class="btn" href="https://github.com/zuosus/dsh-decision-engine">GitHub</a>
  </div>
  ${codeBlock("dsh plugin add dsh-decision-engine")}
  <div class="toc">
    <a href="#what">What it is</a>
    <a href="#install">Install</a>
    <a href="#config">Configuration</a>
    <a href="#points">Decision points</a>
    <a href="#providers">Providers</a>
    <a href="#tokens">Token savings</a>
    <a href="#failopen">Fail-open</a>
    <a href="#verify">Verification</a>
  </div>
</div>

${figure("/assets/promo.jpeg", "dsh-decision-engine promo image", "A small model judges before the main model acts")}

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="what">
  <h2>What it is</h2>
  <p class="sub">
    A cheap <strong>judgement layer</strong>: one ~1.9k-token small-model call
    replacing or preventing far more expensive LLM work. All eight decision
    points are implemented and individually switchable.
  </p>

  <div class="stats">
    <div class="stat"><span class="n">8</span><span class="l">decision points, all implemented</span></div>
    <div class="stat"><span class="n">~1.9k</span><span class="l">tokens per decision</span></div>
    <div class="stat"><span class="n">0.5s</span><span class="l">p50 latency</span></div>
    <div class="stat"><span class="n">shadow</span><span class="l">default: record only</span></div>
  </div>

  ${figure("/assets/shot-config.png", "Config page: eight decision points with tri-state toggles", "Config page: each decision point has off / observe / enforce; edits save immediately")}

  <div class="facts">
    ${fact("Four questions", "Risk · reversibility · task relevance · injection suspicion. The answer is parsed into <code>allow</code> / <code>ask</code> / <code>deny</code>, plus swapping the model, injecting a hint, or skipping a retrieval where needed.")}
    ${fact("Restrained", "Only replace a more expensive call, or prevent a bigger expense. Hot-path points all carry trigger gates — never a check for its own sake.")}
    ${fact("Any endpoint", "One request shape: <code>{ model, state, questions, think_mode }</code> in, <code>answers</code> out. Built-in provider presets, or any <code>custom</code> base URL.")}
  </div>

  <div class="note">
    <strong>Free channel.</strong> Toggle "use free model" to use the project's
    decision model with no key of your own; the quota is paid by the project and
    may be withdrawn or changed at any time — the UI says so plainly.
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="install">
  <h2>Install</h2>
  <p class="sub">From npm (recommended), or from source for local development.</p>

  ${codeBlock("dsh plugin add dsh-decision-engine")}
  <p class="sub">Or add it to a profile manually, then add <code>"dsh-decision-engine"</code> to <code>package.json</code> → <code>dsh.profile.bundles</code> and restart DSH:</p>
  ${codeBlock("cd ~/.dsh/profiles/desktop && pnpm add dsh-decision-engine")}

  <div class="facts">
    ${fact("No re-config", "On startup config and telemetry are auto-migrated into <code>~/.dsh/dsh-decision-engine/</code>, once only — later edits are never overwritten.")}
    ${fact("Local dev", "After <code>git clone</code>, run <code>node scripts/migrate-profile.mjs --write</code> (preview-only by default; <code>--write</code> applies with a backup).")}
    ${fact("Since 0.5.0", "Config file renamed from <code>startlux.yml</code> to <code>config.yml</code>; old files migrate automatically, no need to re-enter keys.")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="config">
  <h2>Configuration</h2>
  <p class="sub">
    Open <strong>Plugins → Installed → dsh-decision-engine</strong>; a Decision
    Engine card appears. Edits save immediately — no save button, no restart.
  </p>
  <div class="facts">
    ${fact("Tri-state", "<span class='badge gray'>off</span> sends no request; <span class='badge blue'>observe</span> judges and records what would have happened; <span class='badge green'>enforce</span> executes the outcome.")}
    ${fact("Key storage", "By default in the <code>refs:</code> section of <code>~/.dsh/.credentials.yaml</code> — no plaintext in the plugin dir — or self-contained in <code>config</code>. Each provider keeps its own slot.")}
    ${fact("Precedence", "Explicit key &gt; matching entry in storage &gt; environment variables. Switching providers flips one key; the others keep their saved values.")}
    ${fact("Model", "Dropdown fed live by <code>/v1/models</code>, default \"auto\" — the field is not sent, so a provider renaming its model cannot break your config.")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="points">
  <h2>Eight decision points</h2>
  <p class="sub">All implemented — you decide which ones the decision model joins. Hooks are implementation details.</p>
  ${pointsTableEn}

  ${figure("/assets/shot-decisions.png", "Decision history tab", "Decision history: every judgement, score and degradation is inspectable")}

  <div class="note">
    <strong>Why not switch every hook on:</strong> a decision costs ~1.9k tokens
    at p50 ≈ 0.5s, and <code>agent/pre-step</code> / <code>agent/request</code>
    fire every step. Hot-path points carry trigger gates and can never be called
    unconditionally.
  </div>

  <h3>Thresholds calibrated on real endpoints</h3>
  <p class="sub">Validated with paired samples ("should judge A" vs "should judge B"); a gate stayed only where the inputs separate. Three issues were fixed:</p>
  <div class="facts">
    ${fact("01 · confidence", "With three equally likely choices it is naturally 0.33, so the delegation floor is 0.5 (clearly above a uniform split), never 0.6 — or <code>advise</code> would be unreachable.")}
    ${fact("02 · wording", "Asking \"is this already known\" gave 0.30 / 0.12 (no separation); asking \"is it covered verbatim in recent\" gave 0.92 / 0.01.")}
    ${fact("03 · check order", "If turn continuation tests <code>closed</code> first, \"clearly unfinished\" falls through to the default <code>stop</code>; now <code>unfinished</code> is checked first.")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="providers">
  <h2>Providers: which decision service</h2>
  <p class="sub">
    The request shape is identical across providers; a response only needs
    <code>answers</code>. A provider decides exactly three things:
    <strong>where to send, whose key, which model by default</strong>.
  </p>
  ${codeBlock("POST <base>/decisions  or  POST <base>/systemone")}
  ${providersTableEn}

  <div class="note ok">
    <strong>Ready to use:</strong> <code>siliconflow</code> /
    <code>siliconflow-intl</code> need only one API key — base URL, path
    (<code>/systemone</code>) and default model (<code>Kev-4B</code>) are
    preconfigured. The two sites are separate accounts with separate keys.
  </div>

  <h3>The endpoint is decided by the provider, not the model</h3>
  <p class="sub">Verified on real endpoints with real keys (2026-10-25):</p>
  ${table(
    ["Provider", "Model", "<code>/v1/decisions</code>", "<code>/v1/systemone</code>"],
    [
      ["SiliconFlow", "<code>Kev-4B</code>", "<strong>404 Not Found</strong>", '<span class="badge green">200 ✓</span>'],
      ["bamboonode", "<code>startlux-decision-v1.1-27b-autothink</code>", '<span class="badge green">200 ✓</span>', '<span class="badge green">200 ✓</span>'],
    ]
  )}
  <p class="sub">
    So endpoint style is only the <strong>preferred</strong> path: send there
    first, on a <strong>404</strong> automatically retry the other one, and
    remember whichever worked (keyed by base URL). Only 404 triggers the switch
    — 400 / 401 / 5xx have nothing to do with the path, and switching would just
    burn another request.
  </p>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="tokens">
  <h2>Token-saving design</h2>
  <div class="facts">
    ${fact("Two-layer cache", "<strong>Exact</strong> reuses only when full state + question set match — the only layer on by default. <strong>Soft reuse</strong> drops argument content from its key, so it is off (fail-closed) and permanently disabled for authorization.")}
    ${fact("thinkMode", "Default <code>never</code> — measured effect is mainly latency (~1.9s vs 7.2s). <code>never</code> / <code>auto</code> / <code>always</code> switchable; illegal values normalize to <code>never</code>.")}
    ${fact("Trigger gates", "<code>read</code> / <code>grep</code> / <code>glob</code> / <code>todo_write</code> and friends never send a request. State is truncated: <code>recent</code> carries only the last 4 entries at 240 chars each.")}
    ${fact("Cooldown", "3 consecutive failures → 60s off; inside cooldown calls pass through in 0ms. Each request has a hard timeout (default 8000ms; measured p50 ≈ 0.7s, cold-start p95 ≈ 6.4s).")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="failopen">
  <h2>Fail-open degradation</h2>
  <p class="sub">
    <strong>Any uncertainty falls back to native behavior</strong> — a guard
    failure must never wedge a tool call. All cases below pass through and
    record one <code>action=degraded</code> line in
    <code>telemetry.jsonl</code>.
  </p>
  ${degradeTableEn}
  <div class="note ok">In default <code>shadow</code> mode, even a judged <code>deny</code> is only recorded, never executed.</div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="verify">
  <h2>Verification</h2>
  <p class="sub">Three automated acceptance runs — all repeatable.</p>
  ${codeBlock("pnpm test && pnpm verify:wiring && pnpm verify:endpoint")}
  ${table(
    ["Command", "Covers"],
    [
      ["<code>pnpm test</code>", "209 unit tests: pure functions + adapter wiring + providers + config round-trip + settings UI rendering + cache regressions"],
      ["<code>pnpm verify:wiring</code>", "Loads the plugin with the real schemastery and confirms the host provides the service"],
      ["<code>pnpm verify:endpoint</code>", "Hits the real endpoint once per decision point, validating question shape and answer parsing"],
    ]
  )}
  <div class="note warn">
    <strong>Do not skip <code>verify:endpoint</code>.</strong> A malformed
    question type 400s at runtime and degrades silently — from the logs alone it
    is nearly impossible to notice "this point never actually worked".
  </div>

  <h3>Reading one record</h3>
  <p class="sub">Switch a point to observe, trigger its action, then read <code>~/.dsh/dsh-decision-engine/telemetry.jsonl</code>:</p>
  <div class="facts">
    ${fact("detail", "<code>no-key</code> → key not found; <code>http-404</code> / <code>http-400</code> → wrong URL or model; <code>answer-shape-mismatch</code> → question set needs a second look.")}
    ${fact("point", "<code>point=route, action=switch</code> means \"this step should sink to a cheaper model\". Every line carries its <code>point</code> and raw <code>scores</code>.")}
    ${fact("Data dir", "<code>$DSH_HOME/dsh-decision-engine/</code>; <code>~/.dsh</code> is only the fallback. Blank counts as unset, <code>~</code> expansion works, relative paths normalize to absolute.")}
  </div>
</section>
`;

/* ------------------------------------------------------------------ *
 * flatmap plugin page (en)
 * ------------------------------------------------------------------ */

export const flatmapBodyEn = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness plugin · MIT</span>
  <h1>dsh-model-flatmap</h1>
  <p class="lede">
    Replaces the composer model picker with <strong>one flat panel</strong>:
    every model, reasoning level and teamwork switch on the same surface,
    visible at once — no nested popovers. Search, grouping and theme-awareness
    all live in that one panel.
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="#install">Install</a>
    <a class="btn" href="#what">What it is</a>
    <a class="btn" href="https://github.com/zuosus/dsh-model-flatmap">GitHub</a>
  </div>
  <div class="toc">
    <a href="#what">What it is</a>
    <a href="#features">Features</a>
    <a href="#install">Install</a>
    <a href="#layout">Layout</a>
    <a href="#dev">Development</a>
  </div>
</div>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="what">
  <h2>What it is</h2>
  <p class="sub">
    A <strong>browser-only</strong> DSH plugin. It swaps the composer's
    <code>conversation.input.model</code> control for a searchable flat grid.
  </p>

  <div class="stats">
    <div class="stat"><span class="n">0</span><span class="l">submenus</span></div>
    <div class="stat"><span class="n">320px</span><span class="l">panel height cap</span></div>
    <div class="stat"><span class="n">2</span><span class="l">grouping modes</span></div>
    <div class="stat"><span class="n">shadow</span><span class="l">disabling restores native</span></div>
  </div>

  ${figure("/assets/shot-flatmap.jpeg", "The flat model picker in action", "The panel: model grid, reasoning levels and teamwork switch on one surface")}

  <div class="facts">
    ${fact("One surface", "The trigger opens one panel capped at 320px. Header, reasoning row and teamwork row stay fixed; only the model grid scrolls — see everything at once instead of drilling through popovers.")}
    ${fact("Public APIs only", "Reads and writes through public Client APIs only — the per-Session model directory, teamwork setting and host locale. The host half <code>index.js</code> contributes no service, tool or event; the UI lives in <code>client.js</code> and shadows the native <code>ModelSelect</code> with a negative priority.")}
    ${fact("Disable to restore", "Turning the bundle off touches no native control and restores <code>ModelSelect</code> with no residue. Plain ES modules, no build step.")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="features">
  <h2>Features</h2>
  <p class="sub">No nested submenus — instead, one searchable, groupable, theme-aware surface.</p>
  <div class="facts">
    ${fact("Global search", "Across every provider and family; empty groups are dropped, so no stray headings. Ranking: prefix &gt; substring &gt; ordered character matches.")}
    ${fact("Word-wise search", "Whitespace splits the query into tokens; every token must land in the name. A hit ranks by its weakest token.")}
    ${fact("Provider-wide", "A query matching a provider (id / catalog name / section label) keeps that provider's entire catalogue in the grid.")}
    ${fact("Two groupings", "A segment control switches between By provider and By family. Grouping and search are independent and combine freely.")}
    ${fact("Model families", "Dictionary recognises DeepSeek, Grok, Claude, Qwen, GLM, Kimi, GPT, Gemini, Llama and more; registered brands split by generation (HY3 / HY4 / HY), unrecognised models infer from their id, anything unjudgeable falls into Others (always last). Families stay flat.")}
    ${fact("Reasoning effort", "The current model's reasoning levels render as an exclusive, keyboard-operable group (radio semantics). They share a line with the teamwork switch when it fits, else wrap — decided by CSS flex.")}
    ${fact("Strike-through", "A model whose call failed on insufficient balance keeps a <code>line-through</code> until a later call for that same model returns anything else; a plain rate-limit 429 never strikes.")}
    ${fact("Theme-aware · no build", "Styled with host theme tokens only, correct in light and dark; plain ES modules. Tests read <code>client.js</code> directly and drive the real component to catch crashes, missing sections and wrong column counts.")}
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="install">
  <h2>Install</h2>
  <p class="sub">This package is a DSH <strong>bundle</strong>. Install it from the plugin manager, or drop it into the profile's bundle directory.</p>
  ${codeBlock("dsh plugin add dsh-model-flatmap")}
  <p class="sub">Or copy it into a profile manually (paths vary by install):</p>
  ${codeBlock('cp -r . "<profile>/bundles/dsh-model-flatmap"')}
  <div class="note ok">
    <strong>Disable to restore.</strong> Enable/disable from the plugin list;
    the <code>dsh</code> loader reads <code>cordis.patch.yml</code> to mount it,
    and turning it off restores the native control with no residue.
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="layout">
  <h2>Project layout</h2>
  <p class="sub">The plugin is light: the host half is almost nil, and all of the UI lives in <code>client.js</code>.</p>
  ${table(
    ["Path", "Purpose"],
    [
      ["<code>index.js</code>", "Host half — bundle entry, contributes nothing at runtime."],
      ["<code>client.js</code>", "Browser half — the entire flat picker UI."],
      ["<code>cordis.patch.yml</code>", "Cordis patch applied by the <code>dsh</code> bundle loader."],
      ["<code>locale/en.json</code> / <code>locale/zh.json</code>", "English / Simplified-Chinese copy and metadata."],
      ["<code>docs/DETAIL.md</code>", "Detailed behaviour specification."],
      ["<code>test/</code>", "Render-path tests driven through a minimal hook runtime."],
    ]
  )}
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="dev">
  <h2>Development</h2>
  <p class="sub">Plain ES modules, no build step.</p>
  ${codeBlock("node --test test/")}
  <p class="sub">
    The full behaviour spec is in <a href="https://github.com/zuosus/dsh-model-flatmap/blob/main/docs/DETAIL.md">docs/DETAIL.md</a>,
    and the design decisions in <a href="https://github.com/zuosus/dsh-model-flatmap/blob/main/DECISIONS.md">DECISIONS.md</a>.
  </p>
</section>
`;
