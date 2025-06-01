import { defineConfig, loadEnv, type ConfigEnv, type UserConfig } from 'vite'

export default ({ mode }: ConfigEnv): UserConfig => {
  const dirname = process.cwd()
  const env = loadEnv(mode, dirname)
  Object.assign(process.env, env)

  return defineConfig({
    plugins: [],
    root: '.',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    clearScreen: false,
    server: {
      host: '0.0.0.0',
      hmr: {
        host: 'localhost',
      },
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    },
  })
}
