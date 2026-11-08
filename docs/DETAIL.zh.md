给 DeepSeek Harness 的**决策层**：在主模型动手前，把「当前状态 + 一组结构化问题」发给一个便宜的决策小模型，据此放行、询问或拦截，也可改道（换模型）或跳过一次昂贵调用。八个决策点各自独立开关；默认只观察不拦截，任何异常一律自动放行。

可接任意提供决策端点的服务：内置 system one / bamboonode / 硅基流动 / Perplexity Decider / OpenRouter 预设，或自定义 base URL。

完整文档：<https://dsh.zuos.us/dsh-decision-engine/>
