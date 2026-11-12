# [P0] 端点静默忽略输出上限，10 万 token 目标实烧 16 万

状态：已处理（2026-11-12）。类型：预算精度缺陷。发现日期：2026-11-12。发现方式：真实运行（DeepSeek，用户实测）。

## 位置

`src/protocols/openai.js` 的 `buildVariants()`；`src/engine.js` 的 `#plan()`、`#settle()`、`#handleError()`。

## 证据

真实运行：目标 100,000 token、并发 4、模型 `deepseek-v4-flash`、9 个请求全部成功，最终 `total = 160,230`，超出目标 **60.2%**。

逐条日志（`/api/run/logs`）：

| # | 输入 | 输出 | 合计 | 耗时 |
|---|---|---|---|---|
| 1 | 17,881 | 528 | 18,409 | 4.7s |
| 2 | 7,802 | 3,883 | 11,685 | 15.3s |
| 3 | 10,221 | 5,358 | 15,579 | 38.6s |
| 4 | 5,272 | 4,566 | 9,838 | 34.2s |
| 5 | 3,846 | 7,860 | 11,706 | 46.9s |
| 6 | 2,489 | 9,817 | 12,306 | 51.8s |
| 7 | 999 | 5,946 | 6,945 | 23.5s |
| 8 | 13,479 | **25,988** | **39,467** | 141.2s |
| 9 | 7,108 | **27,187** | **34,295** | 140.4s |

第 8、9 个的 `latency ≈ 141s`，与整轮运行时长相同，说明它们是最早放出的四个请求之一。两者单独贡献 7.4 万 token。

## 原因与影响

请求走的是第一个参数变体 `{ max_completion_tokens, reasoning_effort }`。DeepSeek 官方 API 只接受 `max_tokens`，**没有 `max_completion_tokens`**，且对未知字段静默忽略、照常返回 200。于是：

- 我们算出的输出上限（约 8K）从未生效；
- `reasoning_effort: 'high'` 生效，thinking 模式开启，默认输出上限为 64K；
- 模型按 64K 自由生成，单请求输出达到 2.6 万，是规划值的 3 倍以上。

变体探测只能识别**被拒绝**的形状（4xx），识别不了**被忽略**的形状——后者对客户端而言是一次成功。因此这个缺陷在任何端点上都不可见，直到账单出现。

放大因素：四个请求同时在途，每一个都可能按 3 倍超发，目标在任何一个请求结算之前就已经失守。旁证：`reasoning 37,982` 占输出 42%，是 thinking 模式的典型特征，也是 p90 延迟 141 秒的来源。

## 复现步骤

1. 选 DeepSeek（或任何只认 `max_tokens` 的兼容端点），策略 max-output，目标 10 万 token，并发 4。
2. 运行至结束。
3. 对比 `total` 与 `limits.tokens`，并检查 `/api/run/logs` 中各请求的 `out` 是否超过规划值。

`scripts/selftest.js` 的 `runaway-model` / `strict-maxcompletion-model` 两个 mock 分支固化了这两条路径。

## 优化或修复建议

1. 把 `max_tokens` 形状排到 `max_completion_tokens` 之前。绝大多数兼容端点只认前者；OpenAI 推理模型会以 400 拒绝并回退，代价是每个端点最多一次探测。
2. 对"被忽略的上限"做观测与补偿：结算时若 `usage.output > maxOutput * 1.15`，学习实际倍率（上限 6×），后续预扣按该倍率计算，从源头压掉同时在途的超发请求。
3. 结算发现已越过目标时立即停止并中止在途请求，而不是等 worker 循环自己发现。
4. 主动中止的请求不应计入 `failed`，否则一次正常收敛会显示"1 次失败"。

## 验收标准

- 只认 `max_tokens` 的端点首次请求即命中，每个成功只消耗一次 HTTP 调用。
- 拒绝 `max_tokens` 的端点仍能回退到 `max_completion_tokens` 并被记住。
- 识别出被忽略的上限后，不再继续发出同规模请求。
- 越过目标的那次结算后立即以 `token target reached` 结束，不产生假的失败计数。
- 超额时进度条显示真实百分比（160.2%）而非钳制后的 100.0%。

## 处理记录

`buildVariants()` 重排为 `max_tokens` 优先，`max_completion_tokens` 作为回退；`#plan()` 用学习到的 `outputOvershoot` 计算 `reservedOutput` 与 `estTokens`/`estUsd`（`ctx` 物理上限仍按请求值判断）；`#settle()` 检测超限并在越过目标时调用 `stop()`；`#handleError()` 把 `stopping` 状态下的 AbortError 归入 `unknownUsage` 而非 `failed`；`updateProgress()` 去掉 100% 钳制并加 `.over` 警示条纹。

新增 3 条测试：只认 `max_tokens` 的端点首次命中（`wire == ok`）、拒绝 `max_tokens` 的端点仍能回退并复用、忽略上限的端点被识别后停止发同规模请求。测试总数 62 → 65。
