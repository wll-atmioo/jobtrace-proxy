// JobTrace Proxy · POST /api/extract-job（Tencent EdgeOne Makers · Edge Functions）
//
// 链路（PROXY_HOSTING_DECISION.md §3 冻结）：
//   Web Demo / Tester Extension
//     → POST /api/extract-job { demoToken, messages, jsonMode }
//     → [1] Demo Access Guard（constant-time）
//     → [2] Rate Limit（KV 计数，按 token × 小时窗口）
//     → [3] Daily Budget Guard（KV 计数，按日估算成本）
//     → [4] LLM 转发（OpenAI-compatible /chat/completions，messages 原样透传，含 image_url）
//     → 返回 { ok, content }（前端复用 extractor 做 Schema / Evidence）
//
// 安全设计：
//   - 任一守卫拦截直接返回，不调用 LLM（不消耗额度）。
//   - Proxy 不保存任何业务内容（无业务日志、无正文落库）。
//   - API Key / Token 全部来自环境变量（控制台配置），源码零 Secret。
//   - CORS 放开（Access-Control-Allow-Origin:*），访问控制由 Demo Token 承担。
//
// 入口使用默认导出 onRequest(context)（Edge Functions 官方推荐形式），
// 内部按 request.method 分派，避免具名 handler 的兼容性差异。

import {
  checkDemoToken,
  rateLimitHit,
  budgetExceeded,
  commitBudget,
  rateLimitKey,
  budgetKey,
  createMemoryKV,
} from './_guards.js'

// 请求体上限：Edge Functions 平台限制 1MB（见 Makers 文档"请求 body 大小 1 MB"），
// 截图必须压缩到 ≤1MB 内（Tester/Web 端 image-compress 需调小目标体积）。
const MAX_BODY_BYTES = 1024 * 1024 // 1MB（平台硬上限）

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

// 守卫计数存储模式（初始化后保持不变）：kv（默认，正式）| memory（临时降级）。
let guardStorageMode = 'kv'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-guard-storage': guardStorageMode,
      ...CORS_HEADERS,
    },
  })
}

function fail(code, error, status) {
  return json({ ok: false, code, error }, status)
}

// OpenAI-compatible 转发：messages 原样透传（文本 + 图片均支持）。
// 模型分轨：
//   - 纯文本 → 文本模型（默认 DeepSeek，env.LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）
//   - 含图片 → 视觉模型（默认智谱 glm-4.6v，env.LLM_VISION_BASE_URL/LLM_VISION_API_KEY/LLM_VISION_MODEL，未配置则回退文本配置）
async function forwardLLM(env, messages, jsonMode, hasImage) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60000) // LLM 慢 + 截图需要更长超时
  try {
    const baseURL = hasImage ? (env.LLM_VISION_BASE_URL ?? env.LLM_BASE_URL) : env.LLM_BASE_URL
    const apiKey = hasImage ? (env.LLM_VISION_API_KEY ?? env.LLM_API_KEY) : env.LLM_API_KEY
    const model = hasImage
      ? (env.LLM_VISION_MODEL ?? env.LLM_MODEL ?? 'glm-4.6v')
      : (env.LLM_MODEL ?? 'deepseek-chat')
    const body = {
      model,
      messages,
      temperature: 0,
    }
    if (jsonMode) {
      body.response_format = { type: 'json_object' }
      // DeepSeek 要求：使用 response_format=json_object 时，prompt 必须包含 "json" 字样，
      // 否则直接 400 拒绝。智谱无此要求。这里做兜底：缺失时在最后一条消息追加说明。
      const textOf = (m) => (typeof m?.content === 'string' ? m.content : '')
      const joined = messages.map(textOf).join(' ')
      if (!/json/i.test(joined)) {
        const note = ' 请严格以 JSON 格式输出结果，不要输出多余文字。'
        const last = messages[messages.length - 1]
        if (last && typeof last.content === 'string') {
          last.content += note
        } else {
          messages.push({ role: 'user', content: note })
        }
      }
    }
    const res = await fetch(
      `${baseURL ?? 'https://api.deepseek.com/v1'}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`上游模型错误(${res.status}): ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('模型返回为空')
    return content
  } finally {
    clearTimeout(timer)
  }
}

// 默认导出：Edge Functions 主入口。
// 处理方法分派：OPTIONS 预检 / POST 业务 / 其他 405。
export default async function onRequest(context) {
  const { request, env } = context
  const method = request.method.toUpperCase()

  // CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // 仅允许 POST
  if (method !== 'POST') {
    return fail('method_not_allowed', `不支持 ${method}，仅允许 POST`, 405)
  }

  try {
    // ---------- 解析与基础校验 ----------
    let body
    try {
      body = await request.json()
    } catch {
      return fail('bad_request', '请求体必须是合法 JSON', 400)
    }
    if (!body || typeof body !== 'object') {
      return fail('bad_request', '请求体无效', 400)
    }
    const { demoToken, messages, jsonMode } = body
    if (!Array.isArray(messages) || messages.length === 0) {
      return fail('bad_request', 'messages 必须是非空数组', 400)
    }
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length
    if (bodyBytes > MAX_BODY_BYTES) {
      return fail('payload_too_large', '请求体过大', 413)
    }

    // ---------- [1] Demo Access Guard ----------
    if (!checkDemoToken(demoToken, env.DEMO_TOKEN)) {
      return fail('invalid_token', '无效的访问令牌', 401)
    }

    // 守卫计数存储：env 注入在 EdgeOne 控制台配置后理论上应自动注入；
    // 但实测发现控制台配置 + 重新部署后 env 仍为空（疑似 Edge Functions 与
    // 控制台环境变量未打通），所以**默认改为 memory**兜底，保证 memory
    // 模式可用。LLM_API_KEY 仍依赖 env 注入（兜底无意义，绝不能进代码）。
    let kv
    const storageMode = (env.GUARD_STORAGE ?? 'memory').toLowerCase()
    if (storageMode === 'memory') {
      guardStorageMode = 'memory'
      kv = createMemoryKV()
    } else {
      guardStorageMode = 'kv'
      kv = env[env.KV_NAMESPACE]
      if (!kv || typeof kv.get !== 'function') {
        return fail('config_error', 'KV 存储未绑定：请在 EdgeOne Pages 项目绑定 KV 命名空间，或临时设置 GUARD_STORAGE=memory', 500)
      }
    }

    // ---------- [2] Rate Limit ----------
    const now = new Date()
    const limit = Number(env.RATE_LIMIT_PER_WINDOW ?? 20)
    if (await rateLimitHit(kv, rateLimitKey(demoToken, now), limit)) {
      return fail('rate_limited', '请求过于频繁，请稍后再试', 429)
    }

    // ---------- [3] Daily Budget Guard ----------
    const hasImage = JSON.stringify(messages).includes('"image_url"')
    const costUsd = hasImage
      ? Number(env.COST_PER_VISION_CALL_USD ?? 0.02)
      : Number(env.COST_PER_CALL_USD ?? 0.005)
    const budgetUsd = Number(env.DAILY_BUDGET_USD ?? 1)
    if (await budgetExceeded(kv, budgetKey(now), costUsd, budgetUsd)) {
      return fail('budget_exhausted', '今日用量已达上限，请明天再试', 429)
    }

    // ---------- [4] LLM 转发 ----------
    const content = await forwardLLM(env, messages, jsonMode, hasImage)
    await commitBudget(kv, budgetKey(now)) // 仅成功调用后落账

    return json({ ok: true, content })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg.includes('上游模型') ? 502 : 500
    return fail(status === 502 ? 'upstream_error' : 'internal_error', msg.slice(0, 300), status)
  }
}