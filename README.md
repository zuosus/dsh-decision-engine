# dsh-decision-engine

![dsh-decision-engine — decision engine for DeepSeek Harness](docs/assets/hero.jpeg)

**Free decision model usage provided**

[website](https://dsh.zuos.us/dsh-decision-engine/) ·
[config.example.yml](config.example.yml) · [DECISIONS.md](DECISIONS.md)

[简体中文](./README.zh.md)

A judgement layer for DeepSeek Harness: a cheap decision model judges before the
main model acts.

## Features

**Eight decision points**

- tool authorization
- model routing
- delegation
- compaction
- turn continuation
- retrieval necessity
- skill selection
- COT translation gate

**Modes**: off · observe · enforce

**Providers**: system one · bamboonode · 硅基流动 SiliconFlow (CN / Global) ·
Perplexity · OpenRouter · custom base URL

**Review tolerance**: autonomous · relaxed · default · cautious

**UI**: config page with collapsible sections · Decisions tab · stats ·
readable approval card

| Config page | Decisions tab |
|---|---|
| ![config page](docs/assets/config-page.png) | ![decisions tab](docs/assets/decisions-tab.png) |

> Screenshots predate the collapsible-section layout (DEC-051).

**Token saving**: exact cache · read-only tools bypass · state trimming

**Reliability**: shadow by default · fail open on any error · timeout degrades ·
stats can be turned off

## License

MIT
