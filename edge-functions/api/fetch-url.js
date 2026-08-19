// JobTrace Proxy · POST /api/fetch-url（Tencent EdgeOne Makers · Edge Functions）
//
// 用途：Web Demo / Tester 端无法直接抓取第三方网页（浏览器 CORS 限制），
// 由 Proxy 代抓招聘网页正文，作为提取的第二来源。
//
// 链路：
//   Web Demo → POST /api/fetch-url { demoToken, url }
//     → [1] Demo Access Guard
//     → [2] URL 校验（http/https + SSRF 防护：拒绝内网/回环地址）
//     → [3] fetch 目标页（限时、限大小）
//     → [4] HTML → 正文文本（复用 extractor 端 htmlToText 同一套规则）
//     → 返回 { ok, text, domain, siteName? }
//
// 安全设计：
//   - SSRF 防护：拒绝内网 IP/回环/保留段，仅放行公网 http/https。
//   - 不跟随重定向到非 http(s) 协议。
//   - 正文上限 8KB，防止目标页超大拖垮本次请求。
//   - CORS 放开，访问控制由 Demo Token 承担。

import { checkDemoToken } from './_guards.js'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_TEXT = 8000
const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 512 * 1024 // 512KB 页面上限

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  })
}

function fail(code, error, status) {
  return json({ ok: false, code, error }, status)
}

// 把 HTML 粗略转成纯文本（与 src/services/url/fetch-page.ts 同规则）：
// 1) 提取 <title> 与 meta description/og:* 摘要（SPA 空壳页也有这些）
// 2) 去掉 script/style/noscript、去标签、折叠空白，得到正文
function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
  const metas = []
  const metaRe = /<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description|keywords|og:site_name)["'][^>]*>/gi
  for (const m of html.matchAll(metaRe)) {
    const c = m[0].match(/content=["']([^"']*)["']/i)?.[1]
    if (c && c.trim()) metas.push(c.trim())
  }
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const noTags = noScript.replace(/<[^>]+>/g, ' ')
  const body = noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return [title, ...metas, body].filter(Boolean).join('\n')
}

function extractDomain(url) {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return null
  }
}

// SSRF 防护：仅允许公网 http/https；拒绝回环/内网/保留段。
function isSsrBlocked(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return true
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const host = u.hostname.toLowerCase()
  if (host === 'localhost') return true
  if (/\.local$/.test(host) || host.endsWith('.internal')) return true
  // IPv4 内网段
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  if (isIpv4) {
    const [a, b] = host.split('.').map(Number)
    if (a === 127 || a === 10) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 0 || a >= 224) return true // 保留/组播
  }
  return false
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
    const { demoToken, url } = body
    if (!url || typeof url !== 'string') {
      return fail('bad_request', '缺少 url 参数', 400)
    }
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length
    if (bodyBytes > MAX_BODY_BYTES) {
      return fail('payload_too_large', '请求体过大', 413)
    }

    // [1] Demo Access Guard
    if (!checkDemoToken(demoToken, env.DEMO_TOKEN)) {
      return fail('invalid_token', '无效的访问令牌', 401)
    }

    // [2] URL 校验 + SSRF 防护
    if (isSsrBlocked(url)) {
      return fail('invalid_url', '仅支持公网 http/https 链接', 400)
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal })
      if (!res.ok) {
        return fail('upstream_error', `页面返回 HTTP ${res.status}`, 502)
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('html') && !contentType.includes('text')) {
        return fail('not_text', `非文本响应(${contentType.slice(0, 40)})`, 415)
      }
      // 限大小读取：防止目标页超大
      const reader = res.body?.getReader()
      let html = ''
      let total = 0
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            html += new TextDecoder().decode(value)
            if (total > MAX_HTML_BYTES) {
              await reader.cancel()
              return fail('too_large', '页面内容过大', 413)
            }
          }
        }
      } else {
        html = await res.text()
      }
      const text = htmlToText(html).slice(0, MAX_TEXT)
      if (!text) {
        return fail('no_content', '页面未提取到正文', 422)
      }
      return json({
        ok: true,
        text,
        domain: extractDomain(url),
        url: url.slice(0, 300),
      })
    } catch (e) {
      const isAbort = e && e.name === 'AbortError'
      return fail('upstream_error', isAbort ? '读取页面超时' : `读取失败：${(e?.message ?? e).toString().slice(0, 120)}`, 502)
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail('internal_error', msg.slice(0, 200), 500)
  }
}
