// 守卫逻辑（纯函数）：不依赖 EdgeOne 运行时，KV 通过参数注入，便于本地单元测试。
// 职责（确定性程序，见 PROXY_HOSTING_DECISION.md §3）：
//   [1] Demo Access Guard（constant-time 比对）
//   [2] Rate Limit（KV 计数，按 token × 小时窗口）
//   [3] Daily Budget Guard（KV 计数，按日累计估算成本）

// constant-time 字符串比较：长度不等直接 false；等长则逐字节 XOR 累计。
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

// [1] Demo Access Guard：token 与期望值 constant-time 比对。
// token 为空 / 未配置 DEMO_TOKEN（expected 空）→ 一律拒绝（fail-closed）。
export function checkDemoToken(token, expected) {
  if (!token || !expected) return false
  return safeEqual(token, expected)
}

// [2] Rate Limit：读当前窗口计数；达到 limit → 拦截；否则计数 +1（TTL 后自动过期）。
// kv 接口：{ get(key), put(key, value, ttlSeconds) }。
export async function rateLimitHit(kv, key, limit) {
  const cur = Number(await kv.get(key)) || 0
  if (cur >= limit) return true
  await kv.put(key, String(cur + 1), 7200) // 2 小时 TTL（覆盖整点窗口）
  return false
}

// [3] Daily Budget Guard：判断"下次调用后"是否超预算。
// 只判断、不写回；由调用方在 LLM 成功后 commitBudget，避免失败也计入预算。
export async function budgetExceeded(kv, key, costUsd, budgetUsd) {
  const cur = Number(await kv.get(key)) || 0
  const next = cur + 1
  return next * costUsd > budgetUsd
}

// LLM 调用成功后落账：计数 +1，TTL 覆盖跨天窗口。
export async function commitBudget(kv, key, ttlSeconds = 172800) {
  const cur = Number(await kv.get(key)) || 0
  await kv.put(key, String(cur + 1), ttlSeconds) // 48 小时
}

// UTC 日期键：rl:{token}:{YYYYMMDD}:{HH} / budget:{YYYYMMDD}
export function utcDateKey(d = new Date()) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

export function rateLimitKey(token, d = new Date()) {
  return `rl:${token}:${utcDateKey(d)}:${String(d.getUTCHours()).padStart(2, '0')}`
}

export function budgetKey(d = new Date()) {
  return `budget:${utcDateKey(d)}`
}

// 内存 KV：临时降级用（GUARD_STORAGE=memory）。
// 注意：仅单实例内存计数，多边缘节点不共享、进程重启清零——
// 只适合 KV 审批未通过的临时 Demo 场景，不等于正式限流保护。
export function createMemoryKV() {
  const map = new Map()
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => map.set(k, v),
  }
}
