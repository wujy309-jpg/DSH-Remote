/**
 * Web Client half of dsh-file-share.
 *
 * Adds a "分享" action to the file context menu. The action is only offered when the
 * page runs inside the DSH Remote Android shell, which exposes `window.DSHRemote.sharePath`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-share',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-file-share'

    /** Share glyph drawn in `currentColor` so the host theme owns the color. */
    function ShareIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 18, cy: 5, r: 2.6 }),
        h('circle', { cx: 6, cy: 12, r: 2.6 }),
        h('circle', { cx: 18, cy: 19, r: 2.6 }),
        h('path', { d: 'M8.3 10.7 15.7 6.4M8.3 13.3l7.4 4.3' }),
      )
    }

    function isAbsolute(path) {
      return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
    }

    /** Menu targets carry a workspace-relative path; the app wants an absolute one. */
    function resolvePath(cwd, path) {
      if (typeof path !== 'string' || path.length === 0) return path
      if (isAbsolute(path)) return path
      if (typeof cwd !== 'string' || cwd.length === 0) return path
      return cwd.replace(/[\\/]+$/, '') + '/' + path.replace(/^(?:\.?[\\/])+/, '')
    }

    return {
      inject: ['contextMenus', 'sessions', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: { 'menu.share': '分享' },
              en: { 'menu.share': 'Share' },
            }),
          'file share: dictionaries',
        )
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register(
            { name: 'contextMenu.icon', key: 'dsh-file-share.icon' },
            ShareIcon,
          ),
        )

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'dsh-file-share.file',
              target: 'file',
              order: 250,
              resolve: ({ sessionId, path }) => {
                const bridge = window.DSHRemote
                if (!bridge || typeof bridge.sharePath !== 'function') return []

                let cwd
                try {
                  const snapshot = ctx.sessions.list.getSnapshot()
                  cwd = snapshot && snapshot.byId ? snapshot.byId[sessionId]?.cwd : undefined
                } catch (error) {
                  cwd = undefined
                }

                const absolute = resolvePath(cwd, path)
                return [
                  {
                    id: 'share',
                    label: t('menu.share'),
                    icon: { key: 'dsh-file-share.icon' },
                    run: () => {
                      try {
                        bridge.sharePath(absolute)
                      } catch (error) {
                        // An older shell without sharePath keeps the menu but cannot run it.
                      }
                    },
                  },
                ]
              },
            }),
          'file share: file context menu',
        )
      },
    }
  },
})
