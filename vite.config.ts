import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const SHA_RE = /^[0-9a-f]{7,40}$/i

/** SHA corto del commit, inyectado en tiempo de build. En desarrollo vale `dev`. */
function resolveBuildSha(command: 'build' | 'serve'): string {
  if (command === 'serve') return 'dev'
  const candidates = [
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
    process.env.COMMIT_REF, // Netlify
    process.env.GITHUB_SHA,
  ]
  for (const c of candidates) if (c && SHA_RE.test(c)) return c.slice(0, 7).toLowerCase()
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (SHA_RE.test(sha)) return sha.slice(0, 7).toLowerCase()
  } catch {
    /* sin git: se usa dev */
  }
  return 'dev'
}

/**
 * Publica /.well-known/lumon-verification.txt a partir de LUMON_VERIFICATION_TOKEN (variable de build, sin prefijo
 * VITE_ para que nunca llegue al bundle) y genera `_headers` para Netlify / Cloudflare Pages con la CSP calculada
 * desde las variables de entorno. En Vercel los headers vienen de vercel.json.
 */
function lumonDeployFiles(env: Record<string, string>): Plugin {
  return {
    name: 'lumon-deploy-files',
    apply: 'build',
    generateBundle() {
      const token = (env.LUMON_VERIFICATION_TOKEN ?? '').trim()
      const publicFile = resolve(process.cwd(), 'public/.well-known/lumon-verification.txt')
      if (token) {
        this.emitFile({ type: 'asset', fileName: '.well-known/lumon-verification.txt', source: token })
      } else if (!existsSync(publicFile)) {
        this.warn('LUMON_VERIFICATION_TOKEN no está definido: /.well-known/lumon-verification.txt no se publicará.')
      }
      const origin = (u: string | undefined) => {
        try {
          return u ? new URL(u).origin : ''
        } catch {
          return ''
        }
      }
      const api = origin(env.VITE_API_BASE_URL)
      const ws = origin(env.VITE_WS_BASE_URL)
      const storage = origin(env.VITE_SUPABASE_URL)
      const connect = ["'self'", api, ws, storage, env.VITE_CLOUDINARY_CLOUD_NAME ? 'https://api.cloudinary.com' : '']
        .filter(Boolean)
        .join(' ')
      const img = ["'self'", 'data:', 'blob:', storage, env.VITE_CLOUDINARY_CLOUD_NAME ? 'https://res.cloudinary.com' : '']
        .filter(Boolean)
        .join(' ')
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `img-src ${img}`,
        "font-src 'self'",
        `connect-src ${connect}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
      const headers = [
        '/*',
        `  Content-Security-Policy: ${csp}`,
        '  X-Content-Type-Options: nosniff',
        '  Referrer-Policy: strict-origin-when-cross-origin',
        '  X-Frame-Options: DENY',
        '/.well-known/*',
        '  Content-Type: text/plain; charset=utf-8',
        '',
      ].join('\n')
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers })
      // SPA fallback para Netlify / Cloudflare Pages (Vercel usa vercel.json).
      this.emitFile({ type: 'asset', fileName: '_redirects', source: '/*    /index.html   200\n' })
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const sha = resolveBuildSha(command)
  if (command === 'build') console.log(`[lumon] X-Lumon-Build = ${sha}`)
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
  return {
    plugins: [react(), tailwindcss(), lumonDeployFiles(env)],
    define: {
      __BUILD_SHA__: JSON.stringify(sha),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      modulePreload: { polyfill: false },
    },
  }
})
