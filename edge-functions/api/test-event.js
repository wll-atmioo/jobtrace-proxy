// JobTrace Proxy · POST /api/test-event（Tencent EdgeOne Makers · Edge Functions）
//
// Round 6 日志闭环：收集 Tester 端结构化诊断（BadCase 元数据），供 Owner 排查错误分布。
// 与 extract-job 并列：**不调用 LLM、不计入提取预算**，独立限流防刷。
//
// 链路：
//   Extension SW → POST /api/test-event { demoToken, events: TestEvent[] }
//     → [1] Demo Access Guard（constant-time）
//     → [2] 独立 Rate Limit（按 token × 小时，EVENT_RATE_LIMIT_PER_WINDOW）
//     → [3] 结构化校验（只接受 kind/at/message/detail；忽略任何 rawText/图片字段）
//     → [4] console.log 写入 EdgeOne 平台日志（控制台可查）
//     → 返回 { ok, received }
//
// 隐私红线（Round 6 对齐）：
//   - 客户端绝不发送原始招聘文字 / 截图；服务端也拒绝处理 events[].rawText 等字段。
//   - 日志不喂 LLM，仅用于人工/脚本排查错误分布。

import {
  checkDemoToken,
  rateLimitHit,
  rateLimitKey,
  createMemoryKV,
  utcDateKey,
} from './_guards.js'

const MAX_BODY_BYTES = 256 * 1024 // 结构化诊断很小，256KB 足够
const MAX_EVENTS = 50 // 单次上报上限，防批量灌入
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

let guardStorageMode = 'memory'

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

// 只抽取白名单字段（kind/at/message/detail），显式丢弃其他一切（含 rawText）。
function sanitizeEvent(e) {
  if (!e || typeof e !== 'object') return null
  const kind = typeof e.kind === 'string' ? e.kind.slice(0, 40) : ''
  if (!kind) return null
  return {
    kind,
    at: typeof e.at === 'number' ? e.at : Date.now(),
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : undefined,
    detail: typeof e.detail === 'string' ? e.detail.slice(0, 500) : undefined,
  }
}

export default async function onRequest(context) {
  const { request, env } = context
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (method !== 'POST') {
    return fail('method_not_allowed', `不支持 ${method}，仅允许 POST`, 405)
  }

  try {
    let body
    try {
      body = await request.json()
    } catch {
      return fail('bad_request', '请求体必须是合法 JSON', 400)
    }
    const { demoToken, events } = body ?? {}
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length
    if (bodyBytes > MAX_BODY_BYTES) return fail('payload_too_large', '请求体过大', 413)
    if (!Array.isArray(events) || events.length === 0) {
      return fail('bad_request', 'events 必须是非空数组', 400)
    }

    // [1] Demo Access Guard
    if (!checkDemoToken(demoToken, env.DEMO_TOKEN)) {
      return fail('invalid_token', '无效的访问令牌', 401)
    }

    // [2] 独立限流（test-event 不走提取预算）
    const kv = createMemoryKV()
    const now = new Date()
    const key = `rl-event:${demoToken}:${utcDateKey(now)}:${String(now.getUTCHours()).padStart(2, '0')}`
    const limit = Number(env.EVENT_RATE_LIMIT_PER_WINDOW ?? 100)
    if (await rateLimitHit(kv, key, limit)) {
      return fail('rate_limited', '上报过于频繁，请稍后再试', 429)
    }

    // [3] 结构化校验 + 白名单抽取
    const clean = events.slice(0, MAX_EVENTS).map(sanitizeEvent).filter(Boolean)
    if (clean.length === 0) {
      return fail('bad_request', '没有可用的结构化事件（需要 kind 字段）', 400)
    }

    // [4] 写平台日志（不调 LLM、不落库业务数据）
    for (const e of clean) {
      // eslint-disable-next-line no-console
      console.log(`[test-event] ${JSON.stringify(e)}`)
    }

    return json({ ok: true, received: clean.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail('internal_error', msg.slice(0, 300), 500)
  }
}
