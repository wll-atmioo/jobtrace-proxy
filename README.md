# JobTrace Proxy（EdgeOne Pages）

托管 `/api/extract-job` 的最小 Proxy：Web Demo 与 Tester Extension 共用。

## 职责

```text
POST /api/extract-job
  body: { demoToken, messages, jsonMode }
        （messages 为 OpenAI-compatible，含 image_url part 时可识别截图）
  → [1] Demo Access Guard     （constant-time token 比对）
  → [2] Rate Limit            （KV 计数，每 token × 小时窗口）
  → [3] Daily Budget Guard    （KV 计数，按日估算成本）
  → [4] LLM 转发              （messages 原样透传，不修改内容）
  → 返回 { ok, content }      （前端复用 extractor 做 Schema/Evidence）
```

- 任一守卫拦截直接返回，**不调用 LLM**。
- Proxy 不保存任何业务内容，不写业务日志。
- 无真实 Secret 在仓库中（全部走环境变量）。

## 目录

```text
api/
├─ edge-functions/
│   └─ api/
│       ├─ extract-job.js      # 函数入口（Edge Functions，onRequestPost）
│       ├─ _guards.js          # 守卫纯逻辑（可单测，不依赖运行时）
│       └─ _guards.test.js     # 守卫单元测试（mock KV）
├─ .env.example                # 环境变量占位示例
└─ README.md
```

## 本地测试（守卫逻辑）

无需 EdgeOne 环境，mock KV 即可：

```bash
npx vitest run api/edge-functions/api/_guards.test.js
```

## 部署（腾讯云 EdgeOne Pages）

前置：腾讯云账号已完成**实名认证**。

1. 安装 CLI：`npm install -g edgeone`
2. 登录：`edgeone login`（选择 China 中国站）
3. 在 EdgeOne 控制台**申请开通 KV 存储**（内测需审批，`https://console.cloud.tencent.com/edgeone/pages?tab=kv` → Apply now）→ 审批通过后创建命名空间（如 `jobtrace-kv`），记录命名空间 ID
4. 在控制台创建 **Pages 项目**，把本仓库的 `api/` 目录作为部署单元（Git 绑定可指定子目录，或用 CLI 部署）
   - CLI 方式：在本目录执行 `edgeone pages deploy .`（自动构建并部署，命名空间 ID 需在部署配置/控制台绑定）
5. 在项目「设置」配置**环境变量**（参考 `.env.example`）：
   - `DEMO_TOKEN`（必填，自己生成随机串）
   - `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（模型账户 Key，可复用智谱/DeepSeek）
   - `RATE_LIMIT_PER_WINDOW`（默认 20）
   - `DAILY_BUDGET_USD`（默认 1）
   - `COST_PER_CALL_USD` / `COST_PER_VISION_CALL_USD`
   - `KV_NAMESPACE`（填控制台创建时的**命名空间 ID**，代码经 `env[env.KV_NAMESPACE]` 访问）
6. 本地调试：`edgeone pages dev`（在 8088 端口启动，`fetch('/api/extract-job', ...)` 联调）

### KV 审批未通过时的临时部署（降级模式）

KV 存储目前为内测、需人工审批（可能 3-5 个工作日）。审批通过前可用**内存计数**临时跑通：

- 在环境变量中设置 **`GUARD_STORAGE=memory`**（跳过 KV 绑定；`KV_NAMESPACE` 可留空）
- 效果：Demo Token 完全生效；限流/预算改用**单实例内存计数**——多边缘节点不共享、进程重启清零，仅适合低流量临时 Demo，**不等于正式限流保护**
- 每次响应头带 `x-guard-storage: memory` 标记，方便识别当前模式
- KV 审批通过后：把 `GUARD_STORAGE` 改回 `kv`、绑定命名空间并填 `KV_NAMESPACE`，重新部署即切回正式模式（代码无需改动）

> 请求体限制：Edge Functions 平台硬上限 **1 MB**（代码层 `MAX_BODY_BYTES=1MB` 同步收紧）。截图 dataURL 必须压缩到 1MB 以内——Tester/Web 端 `image-compress` 的目标体积需按此调整（后续实现注意点）。

## 手动验证

```bash
curl -X POST https://<你的部署域名>/api/extract-job \
  -H 'Content-Type: application/json' \
  -d '{"demoToken":"<DEMO_TOKEN>","messages":[{"role":"user","content":"联想产品岗开始秋招了 https://talent.lenovo.com.cn"}],"jsonMode":true}'
```

- 令牌错误 → `401 invalid_token`
- 短时间连续调用超限 → `429 rate_limited`
- 当日预算耗尽 → `429 budget_exhausted`
- 正常 → `200 { ok:true, content }`
