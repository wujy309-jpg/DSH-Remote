/**
 * dsh web 浏览器会话 cookie 的「陈旧名单」清理。
 *
 * 背景：dsh web（>= 0.1.2-alpha.1）给浏览器会话发的是 `dsh-auth-<tokenId>=v1.<...>`。
 * `<tokenId>` 跟着 dsh web 进程走——桌面端一重启就换一套，而 cookie 的 Max-Age 是 30 天。
 *
 * 手机上留着的旧 cookie 名字永远对不上新 token；偏偏 dsh-pocket 只要在 Cookie 头里
 * 看到 `dsh-auth-` 前缀就认为「浏览器已经握过手」，不再给上游补 `?token=<launch token>`
 * （见 dsh-pocket 的 upstreamPathWithLaunchToken）。结果就是每次 DSH 重启后手机白屏一行：
 *
 *   dsh web authentication required; reopen the URL printed by dsh web.
 *
 * 这里做的事很小：记住上游最近一次下发的 cookie 名，转发时把名字对不上的 `dsh-auth-*`
 * 丢掉。pocket 看不到任何 `dsh-auth-` 就会重新握手、发一份新 cookie，页面自己就回来了。
 */

export const DSH_AUTH_PREFIX = 'dsh-auth-'

/** `dsh-auth-xxx=value` → `dsh-auth-xxx`；解析不出来返回 ''。 */
export function cookieNameOf(pair) {
  const text = String(pair ?? '').trim()
  const eq = text.indexOf('=')
  if (eq <= 0) return ''
  return text.slice(0, eq).trim()
}

/**
 * 维护「当前会话的 dsh-auth cookie 名」。上游每次下发新的 dsh-auth cookie，旧名字就作废
 * （dsh web 同一进程只会用一个名字，换名字只可能发生在重启/换 token 之后）。
 *
 * @param {{ maxNames?: number }} [options]
 */
export function createDshAuthFilter({ maxNames = 8 } = {}) {
  /** @type {Set<string>} */
  let names = new Set()

  return {
    /** 当前认可的 cookie 名（诊断用）。 */
    names: () => [...names],

    /**
     * 忘掉学到的名字。上游真的 401 了（dsh web 换了 tokenId，或手机端的值已作废）就调它：
     * 名字清空后，下一次 strip 会把所有 `dsh-auth-*` 摘掉，pocket 重新握手发新 cookie。
     */
    reset() {
      names = new Set()
    },

    /**
     * 从上游响应的 set-cookie 里认出当前会话的 cookie 名。
     * @param {string | string[] | undefined} setCookie
     */
    note(setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
      /** @type {Set<string>} */
      const next = new Set()
      for (const raw of list) {
        const name = cookieNameOf(String(raw).split(';')[0])
        if (name && name.startsWith(DSH_AUTH_PREFIX)) next.add(name)
      }
      // 只有真的看到 dsh-auth-* 才更新；同一响应里出现多个名字（理论上不会）都留着。
      if (next.size > 0) names = new Set([...next].slice(0, Math.max(1, maxNames)))
    },

    /**
     * 摘掉名字对不上当前会话的 `dsh-auth-*`。
     * @param {string | undefined} cookieHeader
     * @returns {string | null} 清理后的 Cookie 头；没有需要摘的返回 null（调用方保持原样）。
     */
    strip(cookieHeader) {
      if (!cookieHeader) return null
      const parts = String(cookieHeader)
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      const kept = parts.filter((pair) => {
        const name = cookieNameOf(pair)
        if (!name || !name.startsWith(DSH_AUTH_PREFIX)) return true
        return names.has(name)
      })
      if (kept.length === parts.length) return null
      return kept.join('; ')
    },
  }
}
