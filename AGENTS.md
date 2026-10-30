# AGENTS.md

给在这个仓库里干活的 agent（以及三个月后忘了细节的我）看的上下文文件。
产品说明在 `README.md`，这里只记**为什么**和**别踩什么**。

## 这个项目是什么

一个创意/讽刺性质的工程玩具：用户填入自己的 LLM API 凭证，工具用最大并发、
最大上下文、最大输出额度持续请求，把 token 烧掉，并在界面上实时显示烧钱速度。
**模型输出全部丢弃**，没有任何产出。

目标是发社交媒体博眼球，同时技术上真的做到"在服务商限制内最大化消耗"。
后续开源到 GitHub。

## 它为什么不是"恶意工具"

- 只能用用户自己的 key，费用自负。
- 服务端只监听 `127.0.0.1`，没有远程攻击面。
- 强制硬上限，拒绝无上限运行。
- 没有隐藏行为：所有请求都发往用户自己填的 endpoint。

这些不是装饰，是**功能边界**。任何改动都不能削弱它们。

## 结构

```
server.js            HTTP 服务 / 参数校验 / SSE；零依赖，手写路由
src/config.js        服务商目录（协议、端点、上下文、输出上限、价格）
src/engine.js        Burner：worker 池、预扣账本、配额闭环、熔断、急停
src/prompts.js       随机填充文本、强制长输出指令、缓存穿透 nonce
src/images.js        手写 PNG 编码器（zlib + CRC32）
src/protocols/       openai | anthropic | gemini | http(SSE/错误分类)
public/              index.html / app.js / styles.css，无构建步骤
scripts/selftest.js  离线测试，自带 mock 厂商
```

## 硬规则

1. **零运行时依赖。** 不要引入 express / axios / openai SDK。Node 20+ 内置的
   `fetch`、`http`、`zlib`、`AbortController` 够用。理由：用户要在这个进程里
   放 API key，依赖树越小越好审。`package.json` 的 `dependencies` 必须保持 `{}`。
2. **API key 绝不落盘、绝不进日志、绝不进错误信息。** 错误只保留状态码 +
   响应体片段。
3. **不允许出现"没有上限就能跑"的路径。** `server.js` 的 `buildConfig()`
   里那段 `finite === 0` 检查是安全底线，任何情况下不要绕过。
4. **不要为了"更好看"牺牲可读性。** 火焰是背景，日志和停止按钮必须绝对清晰。
   Canvas 用 `mix-blend-mode: screen` + 低 opacity，永远不要盖在文字上。
5. **不要把服务绑到 `0.0.0.0`。**
6. 改完跑 `node scripts/selftest.js`，全部通过再提交（当前 46 项）。

## 三个容易改坏的地方

### 预扣账本（engine.js `#plan` / `#settle`）

并发下 `reservedTokens` / `reservedUsd` 必须成对增减。曾经踩过的坑：
worker 拿到 `null` plan 时直接 `stop()`，导致**并发预扣把后面的 worker 误判成
"预算用完"**，整个运行 2 个请求就停了。正确行为是：`inflight > 0` 时等一轮
结算再判断。

固定提示、图片、最低输出和预扣余量必须先计入计划，剩余额度不足最小请求时不要发送。
中断调用只把已确认用量计入消耗，未知部分留在独立预留中；重试必须重新取得足额预扣。
`activeRequests` / `peakActiveRequests` 才是实际发送数，`inflight` 是工作许可占用数。

### 参数变体回退（protocols/openai.js `buildVariants`）

"OpenAI 兼容"没有标准。现代模型要 `max_completion_tokens`，老端点只认
`max_tokens`，有的连 `stream_options` 都不认。变体是有序的，遇到 400/422
往下走一格，遇到 401/402/403 直接放弃。**不要**因为一次 400 就判定 key 有问题。

### 图片尺寸与 token 上限

Anthropic 会把长边压到 1568，传更大的图只是浪费上传时间。Gemini 不压，
分辨率越大越贵。`estimateImageTokens()` 里按协议分支是对的，别统一。

## 协议层三条硬规矩

1. **`isShapeError()`（protocols/http.js）只回答一个问题：这个 400 是说字段名不认识，还是取值太大？**
   前者才值得换参数组合重试。分不清的后果很具体——`max_tokens too large` 曾让四套变体各撞一次，
   把调用配额烧光，调度器连"该减半"这个错误都收不到。
2. **所有实际 HTTP 调用必须经过 `beforeSend`。** 它由引擎注入（`#reserveCall()`），是次数上限的
   唯一计数点。成功取得发送许可后，退出时必须成对调用 `afterSend`。新增适配器、新增重试路径时忘了调用它，上限就形同虚设。
3. **适配器只返回字符数和一小段样本，不返回正文。** 引擎和报告都不读正文，保留它只是给 GC 找事
   （`makeSink()`）。只有 `probe` 需要 `sample`，且它会被截断到 160 字符。

HTTP 200 后仍可能出现流内错误。协议层必须识别并附上已确认的部分用量；SSE 读取器只能捕获 JSON 解析失败，不能吞掉业务回调的异常。

## 等待必须可取消

`sleep()` 是禁止的。用 `#sleep()`——它挂在共享 `AbortSignal` 上。普通的 `setTimeout` 会让
「停止」按钮在退避期间失效：服务商要求等 60 秒，用户点了停止，界面就要僵在那里 60 秒。

## 数据可信度

`src/config.js` 里的价格和上下文窗口是 2026-10-29 手工抄的，**一定会过时**，
而且部分标了 `est: true` 的是估的。

- 引擎在计费上只信 API 返回的 `usage`，不信价格表。
- 价格表只用于**预扣估算**和界面展示。
- 界面上每个字段都可覆盖，这是设计上的兜底，不要移除。

## 命令

```bash
node server.js              # 起服务，默认 127.0.0.1:8791，PORT 可覆盖
node scripts/selftest.js    # 离线自测（46 项）
node scripts/review-throughput.js # 本轮吞吐与预算回归（15 项，已包含在完整自测中）
```

审查记录在 `docs/issues/`，三轮共记录 29 次问题（含重开），均已处理。改调度器或协议层之前建议先扫一眼——
那里面的每一条都能复现，且大多数是"不报错但结果是错的"那种。

## 风格

- 中文界面，注释和标识符用英文。
- 注释解释**为什么**，不解释**是什么**。
- 文案可以损，但要诚实：不要承诺它做不到的事（比如"精确到个位"）。
