// 英文版页面内容。结构与 content（build.mjs 中的中文段落）逐节对应，
// 章节 id 保持一致（#what / #install / #config / #points / #providers /
// #tokens / #failopen / #verify），中文页的锚点链接可以直接复用。
import { codeBlock, table, ICON } from "./partials.mjs";

const VERSION = "0.7.1";

/* ------------------------------------------------------------------ *
 * Home (en)
 * ------------------------------------------------------------------ */

export const indexBodyEn = `
<div class="wrap hero">
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness plugins</span>
  <h1>A <span class="grad">cheap judgement layer</span><br>for DeepSeek Harness</h1>
  <p class="lede">
    dsh.zuos.us is the home of <strong>DeepSeek Harness (DSH)</strong> plugin
    projects. Every plugin here follows one principle: <strong>one tiny model
    call to replace or prevent a much larger LLM expense</strong> — and by
    default they only observe, never interrupt your work.
  </p>
  <div class="cta-row">
    <a class="btn btn-primary" href="/en/dsh-decision-engine/">Read the dsh-decision-engine guide →</a>
    <a class="btn" href="https://github.com/zuosus/dsh-decision-engine">Source code</a>
  </div>
</div>

<div class="wrap">
  <hr class="rule">
</div>

<section class="wrap">
  <h2>Projects</h2>
  <p class="sub">One plugin so far.</p>

  <div class="grid">
    <a class="project" href="/en/dsh-decision-engine/">
      <div class="project-head">
        ${ICON}
        <div>
          <h3>dsh-decision-engine</h3>
        </div>
        <div class="nav-spacer"></div>
        <span class="ver">v${VERSION}</span>
      </div>
      <p>
        A System-1 decision guard for DSH: before every tool call it asks the
        model four questions — risk, reversibility, task relevance, injection
        suspicion — and allows, asks, or blocks accordingly. All eight decision
        points (tool authorization, model routing, delegation, compaction, turn
        continuation, retrieval necessity, skill selection, COT translation)
        are implemented and individually switchable.
      </p>
      <div class="toc">
        <span class="badge green">Shadow mode by default</span>
        <span class="badge blue">Any system-one API</span>
        <span class="badge gray">MIT</span>
      </div>
    </a>
  </div>
</section>

<section class="wrap">
  <h2>Shared design rules</h2>
  <p class="sub">Every plugin here obeys the same three rules — the reason they are safe to leave installed.</p>
  <div class="grid grid-3">
    <div class="card">
      <span class="kicker">fail-open</span>
      <h4>Uncertainty passes through</h4>
      <p>Timeouts, network errors, auth failures, malformed answers — all fall back to native behavior with one telemetry line. A failing guard never blocks a tool call.</p>
    </div>
    <div class="card">
      <span class="kicker">shadow first</span>
      <h4>Observe, then enforce</h4>
      <p>Every decision point has off / observe / enforce. New points run in observe until their judgments match human review — only then switch to enforce.</p>
    </div>
    <div class="card">
      <span class="kicker">cheap by design</span>
      <h4>Spend less, never more</h4>
      <p>Intervene only where a cheap call replaces a more expensive one, or prevents a bigger expense — never just to add one more check.</p>
    </div>
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
  <span class="eyebrow"><span class="dot"></span> DeepSeek Harness plugin · v${VERSION} · MIT</span>
  <h1>dsh-decision-engine</h1>
  <p class="lede">
    The <strong>System-1 decision guard</strong> for DeepSeek Harness: before
    every tool call it asks the model four questions — <strong>risk,
    reversibility, task relevance, injection suspicion</strong> — then allows,
    asks, or blocks. Defaults to <code>shadow</code>: it records judgments and
    never interrupts your work.
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

<div class="wrap">
  <hr class="rule">
</div>

<section class="wrap" id="what">
  <h2>What it is</h2>
  <p class="sub">
    Not a tool-call risk gate — <strong>a cheap judgement layer</strong>: one
    ~1.9k-token small-model call replacing or preventing far more expensive
    LLM work.
  </p>

  <div class="stats">
    <div class="stat"><span class="n">8</span><span class="l">decision points, all implemented</span></div>
    <div class="stat"><span class="n">~1.9k</span><span class="l">tokens per decision</span></div>
    <div class="stat"><span class="n">0.5s</span><span class="l">p50 latency</span></div>
    <div class="stat"><span class="n">shadow</span><span class="l">default mode: record only</span></div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">Four questions</span>
      <h4>Risk · reversibility · task relevance · injection suspicion</h4>
      <p>
        Every judgment asks exactly these four. The answer is parsed into an
        outcome: <code>allow</code>, <code>ask</code> or <code>deny</code> —
        plus, where the point demands it, swapping the model, injecting a hint,
        or skipping a retrieval.
      </p>
    </div>
    <div class="card">
      <span class="kicker">Restrained intervention</span>
      <h4>Only where it pays for itself</h4>
      <p>
        Intervention must be restrained: <strong>only replace a more expensive
        call, or prevent a bigger expense</strong> — never add a check for its
        own sake. Hot-path points all carry explicit trigger gates.
      </p>
    </div>
  </div>

  <div class="note">
    <strong>Works with any system-one style API.</strong>
    Built-in presets for <code>system one</code> and <code>bamboonode</code>,
    SiliconFlow (CN + intl), or any <code>custom</code> base URL (self-hosted
    llama.cpp / vLLM, corporate gateways, third-party relays). Request path,
    auth and response shape follow the system-one protocol, so switching
    providers never changes how answers are parsed.
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="install">
  <h2>Install</h2>
  <p class="sub">From npm (recommended), or from source for local development.</p>

  <h3>From npm</h3>
  ${codeBlock("dsh plugin add dsh-decision-engine")}
  <p style="color:var(--fg-dim);font-size:14.5px;margin-top:-4px">
    Or add it to a profile manually:
  </p>
  ${codeBlock("cd ~/.dsh/profiles/desktop && pnpm add dsh-decision-engine")}
  <p style="color:var(--fg-dim);font-size:14.5px">
    Then add <code>"dsh-decision-engine"</code> to
    <code>package.json</code> → <code>dsh.profile.bundles</code> and restart DSH.
  </p>

  <h3>Local development</h3>
  ${codeBlock("git clone https://github.com/zuosus/dsh-decision-engine.git")}
  <p style="color:var(--fg-dim);font-size:14.5px">
    The repo ships a migration script (preview-only by default;
    <code>--write</code> applies it and keeps a backup):
  </p>
  ${codeBlock("node scripts/migrate-profile.mjs --write")}

  <div class="note ok">
    <strong>No re-configuration needed.</strong> On startup the plugin
    auto-migrates config and telemetry from old directories into
    <code>~/.dsh/dsh-decision-engine/</code>. It <strong>runs only
    once</strong>: if a <code>config.yml</code> already exists there, nothing is
    touched — your later edits are never overwritten.
  </div>

  <div class="note warn">
    <strong>Since 0.5.0 the config file is <code>config.yml</code>, renamed from
    <code>startlux.yml</code></strong> — the plugin serves more than one provider
    now. Old files are renamed automatically on migration; if renaming fails the
    plugin still reads the old name as a fallback.
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="config">
  <h2>Configuration</h2>
  <p class="sub">
    Open <strong>Plugins → Installed → dsh-decision-engine</strong>; a Decision
    Engine card appears in the config area. Edits save immediately — there is no
    save button and no restart needed.
  </p>

  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">Tri-state</span>
      <h4>off / observe / enforce</h4>
      <p>
        <span class="badge gray">off</span> no request at all — saves tokens and the ~2s delay;
        <span class="badge blue">observe</span> judges and records what would have happened, changes nothing;
        <span class="badge green">enforce</span> executes the outcome for that point.
      </p>
    </div>
    <div class="card">
      <span class="kicker">Key storage</span>
      <h4>Two places</h4>
      <p>
        By default keys go into the <code>refs:</code> section of
        <code>~/.dsh/.credentials.yaml</code> (managed alongside other services,
        no plaintext in the plugin dir); or keep the config self-contained.
        All five providers keep their own key slots and never overwrite each other.
      </p>
    </div>
    <div class="card">
      <span class="kicker">Key precedence</span>
      <h4>Explicit &gt; storage &gt; environment</h4>
      <p>
        The provider's explicit key field &gt; the matching entry in the chosen
        storage location &gt; environment variables. Switching providers flips
        exactly one config key; other providers keep their saved URL, model and key.
      </p>
    </div>
    <div class="card">
      <span class="kicker">Model</span>
      <h4>A dropdown fed by the server</h4>
      <p>
        The model list comes live from the current provider's
        <code>/v1/models</code>, plus an "auto (server default)" option — the
        default. In auto mode the field is simply not sent, so a provider
        renaming its model cannot break your config.
      </p>
    </div>
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="points">
  <h2>Eight decision points</h2>
  <p class="sub">
    All eight are <strong>fully implemented</strong> — you decide which ones the
    decision model joins. Hooks are implementation details; the config page
    lists the points defined here.
  </p>
  ${pointsTableEn}

  <div class="note">
    <strong>Why not switch every hook on:</strong> a decision costs ~1.9k
    tokens at p50 ≈ 0.5s. <code>agent/pre-step</code> and
    <code>agent/request</code> fire <strong>every step</strong>; both open
    without gates would add over a second per step. So hot-path points carry
    explicit trigger gates and can never be called unconditionally.
  </div>

  <h3>Thresholds were calibrated on real endpoints</h3>
  <p style="color:var(--fg-dim)">
    Every threshold was validated with paired samples ("should judge A" vs
    "should judge B") against a real endpoint — only where the two inputs
    actually separate did the gate stay. Calibration surfaced and fixed three
    problems:
  </p>
  <div class="grid grid-3">
    <div class="card">
      <span class="kicker">01</span>
      <h4>confidence is the probability of the picked option</h4>
      <p>With three equally likely choices it is naturally 0.33, so the delegation floor can never be 0.6 or <code>advise</code> would be unreachable. Now it requires "clearly above a uniform split" — 0.5.</p>
    </div>
    <div class="card">
      <span class="kicker">02</span>
      <h4>The question decides everything</h4>
      <p>Asking "is this information already known?" produced 0.30 / 0.12 — no separation at all. Asking "does the recent context cover this fact verbatim — answer only from that text" flipped it to 0.92 / 0.01.</p>
    </div>
    <div class="card">
      <span class="kicker">03</span>
      <h4>Check order changes outcomes</h4>
      <p>If turn continuation tests <code>closed</code> first, the "clearly unfinished" group fell through to the default <code>stop</code> at 0.28 — exactly the case that should continue. Now <code>unfinished</code> is checked first.</p>
    </div>
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="providers">
  <h2>Providers: any system-one style service</h2>
  <p class="sub">
    The request shape is identical across providers (that is the system-one
    protocol). A response only needs <code>answers</code>, so a provider
    decides exactly three things: <strong>where to send, whose key to use,
    which model by default</strong>.
  </p>

  ${codeBlock("POST <base>/decisions  or  POST <base>/systemone")}

  ${providersTableEn}

  <div class="note ok">
    <strong>Ready to use:</strong> for <code>siliconflow</code> /
    <code>siliconflow-intl</code> you only paste one API key — base URL, path
    (<code>/systemone</code>) and default model (<code>Kev-4B</code>) are
    preconfigured. The two sites are separate accounts with separate keys.
  </div>

  <h3>The endpoint is decided by the provider, not the model</h3>
  <p style="color:var(--fg-dim)">
    This is the easiest trap to fall into, so it was verified on real endpoints
    with real keys (2026-10-25):
  </p>
  ${table(
    ["Provider", "Model", "<code>/v1/decisions</code>", "<code>/v1/systemone</code>"],
    [
      ["SiliconFlow", "<code>Kev-4B</code>", "<strong>404 Not Found</strong>", '<span class="badge green">200 ✓</span>'],
      ["bamboonode", "<code>startlux-decision-27b-autothink</code>", '<span class="badge green">200 ✓</span>', '<span class="badge green">200 ✓</span>'],
    ]
  )}
  <p style="color:var(--fg-dim)">
    So <code>Kev-4B</code> is not "a model that only speaks /systemone" —
    <strong>the path belongs to the provider</strong>. That is why endpoint
    style is only the <em>preferred</em> path: send to it first; on a
    <strong>404</strong> (path does not exist) automatically retry the other
    one; remember whichever worked (keyed by base URL) so the next call skips
    the extra round-trip. Only 404 triggers the switch — 400, 401 and 5xx have
    nothing to do with the path, and switching would just burn another request.
  </p>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="tokens">
  <h2>Token-saving design</h2>
  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">Two-layer cache</span>
      <h4>Exact layer on; soft layer off</h4>
      <p>
        <strong>Exact</strong>: reused only when the full state + question set
        match — the only layer enabled by default. <strong>Soft reuse</strong>
        deliberately drops argument content from its key, so it ships
        <strong>off (fail-closed)</strong> and is <strong>permanently disabled
        for authorization</strong>: a security decision is either bound to the
        full call context, or not cached at all.
      </p>
    </div>
    <div class="card">
      <span class="kicker">thinkMode</span>
      <h4>Default <code>never</code></h4>
      <p>
        Measured effect is mainly on <strong>latency</strong> (~1.9s vs 7.2s).
        <code>never</code> / <code>auto</code> / <code>always</code> are switchable
        in the config page; illegal values are normalized to <code>never</code>
        and never sent to the server.
      </p>
    </div>
    <div class="card">
      <span class="kicker">Trigger gates</span>
      <h4>Read-only tools pass through</h4>
      <p>
        <code>read</code> / <code>grep</code> / <code>glob</code> /
        <code>todo_write</code> and friends never send a request. The state is
        truncated too: <code>args</code> is a head/tail digest and
        <code>recent</code> carries only the last 4 entries at 240 chars each.
      </p>
    </div>
    <div class="card">
      <span class="kicker">Cooldown</span>
      <h4>3 failures → 60s off</h4>
      <p>
        Inside cooldown calls pass through in 0ms instead of burning money on a
        broken endpoint. Each request also has a hard timeout (default 8000ms;
        measured p50 ≈ 0.7s, cold-start p95 ≈ 6.4s).
      </p>
    </div>
  </div>
</section>

<div class="wrap"><hr class="rule"></div>

<section class="wrap" id="failopen">
  <h2>Fail-open degradation</h2>
  <p class="sub">
    The design rule is <strong>any uncertainty falls back to native
    behavior</strong> — a guard failure must never wedge a tool call. All cases
    below pass through and record one <code>action=degraded</code> line in
    <code>telemetry.jsonl</code>.
  </p>
  ${degradeTableEn}
  <div class="note ok">
    In the default <code>shadow</code> mode, even a judged <code>deny</code> is
    only recorded, never executed.
  </div>
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
      ["<code>pnpm verify:wiring</code>", "Wiring check: loads the plugin with the real schemastery and confirms the host actually provides the service"],
      ["<code>pnpm verify:endpoint</code>", "Hits the real endpoint once per decision point, validating question shape and answer parsing"],
    ]
  )}
  <div class="note warn">
    <strong>Do not skip <code>verify:endpoint</code>.</strong> A malformed
    question type 400s at runtime and degrades silently — from the logs alone
    it is nearly impossible to notice "this point never actually worked".
  </div>

  <h3>Manual check</h3>
  <p style="color:var(--fg-dim)">
    Switch a point to observe, trigger its action, then read
    <code>~/.dsh/dsh-decision-engine/telemetry.jsonl</code>:
  </p>
  <div class="grid grid-2">
    <div class="card">
      <span class="kicker">detail</span>
      <h4>Reading one record</h4>
      <p>
        <code>no-key</code> → the key was not found;
        <code>http-404</code> / <code>http-400</code> → wrong URL or model;
        <code>answer-shape-mismatch</code> → that point's question set needs a
        second look.
      </p>
    </div>
    <div class="card">
      <span class="kicker">point</span>
      <h4>Which point, what verdict</h4>
      <p>
        <code>point=route, action=switch</code> means the point judged "this
        step should sink to a cheaper model". Every line carries its
        <code>point</code> and raw <code>scores</code>.
      </p>
    </div>
  </div>

  <h3>Data directory</h3>
  <p style="color:var(--fg-dim)">
    The data directory is <code>$DSH_HOME/dsh-decision-engine/</code>;
    <code>~/.dsh</code> is only the fallback when <code>DSH_HOME</code> is
    unset. A blank value counts as unset (it can never resolve into the current
    working directory), <code>~</code> expansion is supported, and relative
    paths are normalized to absolute ones.
  </p>
</section>
`;
