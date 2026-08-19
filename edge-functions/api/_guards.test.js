// 守卫逻辑单元测试：KV 用内存 mock，不依赖 EdgeOne 运行时。
// 运行：node --test api/edge-functions/api/_guards.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  safeEqual,
  checkDemoToken,
  rateLimitHit,
  budgetExceeded,
  commitBudget,
  utcDateKey,
  rateLimitKey,
  budgetKey,
  createMemoryKV,
} from './_guards.js'

// 内存 KV（兼容 _guards 使用的 get/put 接口；put 带 TTL 仅记录）
function memoryKV() {
  const map = new Map()
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => map.set(k, v),
  }
}

describe('safeEqual', () => {
  it('等长相同 → true', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
  })
  it('等长不同 → false', () => {
    assert.equal(safeEqual('abc', 'abd'), false)
  })
  it('长度不同 → false', () => {
    assert.equal(safeEqual('a', 'ab'), false)
  })
  it('非字符串 → false', () => {
    assert.equal(safeEqual(123, '123'), false)
    assert.equal(safeEqual(null, ''), false)
    assert.equal(safeEqual(undefined, 'x'), false)
  })
})

describe('checkDemoToken（Access Guard）', () => {
  it('正确 token → 通过', () => {
    assert.equal(checkDemoToken('demo-123', 'demo-123'), true)
  })
  it('错误 token → 拒绝', () => {
    assert.equal(checkDemoToken('demo-999', 'demo-123'), false)
  })
  it('空 token → 拒绝（fail-closed）', () => {
    assert.equal(checkDemoToken('', 'demo-123'), false)
    assert.equal(checkDemoToken(null, 'demo-123'), false)
  })
  it('未配置 expected → 拒绝（fail-closed）', () => {
    assert.equal(checkDemoToken('demo-123', ''), false)
    assert.equal(checkDemoToken('demo-123', undefined), false)
  })
})

describe('rateLimitHit（Rate Limit）', () => {
  let kv
  beforeEach(() => {
    kv = memoryKV()
  })
  it('窗口内未达上限 → 放行并计数', async () => {
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 3), false)
    assert.equal(kv.map.get('rl:t:1:10'), '1')
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 3), false)
    assert.equal(kv.map.get('rl:t:1:10'), '2')
  })
  it('达到上限 → 拦截', async () => {
    kv.map.set('rl:t:1:10', '3')
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 3), true)
  })
  it('limit=0 → 立即拦截', async () => {
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 0), true)
  })
  it('不同窗口独立计数', async () => {
    await rateLimitHit(kv, 'rl:t:1:10', 1)
    assert.equal(await rateLimitHit(kv, 'rl:t:1:11', 1), false)
  })
})

describe('budgetExceeded + commitBudget（Daily Budget Guard）', () => {
  let kv
  beforeEach(() => {
    kv = memoryKV()
  })
  it('未超预算 → 放行', async () => {
    assert.equal(await budgetExceeded(kv, 'budget:20260818', 0.005, 1), false)
  })
  it('将超预算 → 拦截（不落账）', async () => {
    kv.map.set('budget:20260818', '200') // 已 200 次，next=201 → 201*0.005=1.005 > 1
    assert.equal(await budgetExceeded(kv, 'budget:20260818', 0.005, 1), true)
    assert.equal(kv.map.get('budget:20260818'), '200') // 拦截不写回
  })
  it('边界：next*cost == budget → 不拦截', async () => {
    kv.map.set('budget:20260818', '199')
    // 199+1 = 200, 200*0.005 = 1.0，不超预算
    assert.equal(await budgetExceeded(kv, 'budget:20260818', 0.005, 1), false)
  })
  it('commit 落账 + 后续累计', async () => {
    await commitBudget(kv, 'budget:20260818')
    await commitBudget(kv, 'budget:20260818')
    assert.equal(kv.map.get('budget:20260818'), '2')
  })
  it('vision 更高单价更快触顶', async () => {
    assert.equal(await budgetExceeded(kv, 'budget:20260818', 0.02, 1), false)
    kv.map.set('budget:20260818', '50')
    // 51*0.02 = 1.02 > 1 → 拦截
    assert.equal(await budgetExceeded(kv, 'budget:20260818', 0.02, 1), true)
  })
})

describe('KV key 生成', () => {
  const d = new Date('2026-08-18T08:30:00Z')
  it('utcDateKey 格式 YYYYMMDD', () => {
    assert.equal(utcDateKey(d), '20260818')
  })
  it('rateLimitKey 含 token/日期/小时', () => {
    assert.equal(rateLimitKey('tok', d), 'rl:tok:20260818:08')
  })
  it('budgetKey 按日期', () => {
    assert.equal(budgetKey(d), 'budget:20260818')
  })
})

describe('createMemoryKV（临时降级存储）', () => {
  it('get/put 基本读写', async () => {
    const kv = createMemoryKV()
    assert.equal(await kv.get('k1'), null)
    await kv.put('k1', '5')
    assert.equal(await kv.get('k1'), '5')
  })
  it('与守卫逻辑可组合使用', async () => {
    const kv = createMemoryKV()
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 2), false)
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 2), false)
    assert.equal(await rateLimitHit(kv, 'rl:t:1:10', 2), true)
    await commitBudget(kv, 'budget:20260818')
    assert.equal(await budgetExceeded(kv, 'budget:20260818', 0.005, 0.005), true)
  })
})
