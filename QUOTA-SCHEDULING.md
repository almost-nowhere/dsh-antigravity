# Antigravity 额度与账号调度设计

## 额度模型分析

Google Antigravity / Cloud Code Assist 主要按以下窗口进行配额管理：

1. **5 小时动态窗口**：用于平滑短期并发与突发用量，滚动重置。
2. **每周固定窗口**：与订阅计划（如 Pro / Ultra / 免费计划）绑定的周额度上限。
3. **模型分组**：Gemini 系列与 3P 模型（Claude 4.6 / GPT）拥有独立的配额池。

## 常见号池的实际算法对比

| 项目及源码快照 | 实际实现 | 取舍 |
| --- | --- | --- |
| CLIProxyAPI | Round robin、Weighted round robin、Fill first、Session affinity | 轮询公平，单账号切换少，会话亲和适合多步任务 |
| Antigravity-Manager | Balance 会话粘性；新选号用 P2C（二选优），考虑健康过滤、优先级、在途数、额度和重置时间 | 兼顾连续性与并发分散 |
| jabezpauls/antigravity-api-proxy | 策略工厂 round-robin，跳过无效、禁用、冷却账号 | 简单快速 |

参考来源：
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)
- [antigravity-api-proxy](https://github.com/jabezpauls/antigravity-api-proxy)

---

## 本插件调度设计：透明混合调度算法

1. **按账号全约束判定**：周、五小时、模型及显式分组约束须在同一账号内满足，支持跨分组独立计算。
2. **新会话优选分配**：按已知可用、未知、受限分档排序。同档内按 `有效余额 / (1 + 在途请求数)` 降序分配，并结合低负载与最近最少使用进行平局仲裁。
3. **会话亲和（Session Affinity）**：利用会话标识尽量保持同一任务使用同一账号，保证代码上下文连贯。
4. **低额平滑让出**：当前账号有效余额低于 10% 且存在更高余额账号时，在会话间隙平滑让出给新账号。
5. **并发生命周期管理**：请求排序、预绑定、占用与释放全周期精确跟踪。
6. **有界重试与故障转移**：遇到 429 或配额耗尽时，自动转移至备用账号继续完成流式生成。
7. **手动选择优先级**：用户手动指定账号时优先执行手动选择，同时保留限流保护。
