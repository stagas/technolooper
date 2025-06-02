import { defineConfig, loadEnv, type ConfigEnv, type Plugin, type UserConfig } from 'vite'
import { ViteAssemblyScript } from './vite-plugin-assemblyscript.ts'
import { BundleUrl } from './vite-plugin-bundle-url.ts'
import { HexLoader } from './vite-plugin-hex-loader.ts'

type Plugins = (Plugin | Plugin[])[]

export default ({ mode }: ConfigEnv): UserConfig => {
  const dirname = process.cwd()
  const env = loadEnv(mode, dirname)
  Object.assign(process.env, env)

  const buildPlugins: Plugins = [
    HexLoader(),
  ]

  return defineConfig({
    plugins: [
      ...buildPlugins,
      BundleUrl({
        plugins: buildPlugins
      }),
      ViteAssemblyScript({
        configFile: 'asconfig-delay.json',
        projectRoot: '.',
        srcMatch: 'as/assembly/delay',
        srcEntryFile: 'as/assembly/delay/index.ts',
        mapFile: './as/build/delay.wasm.map',
      }),
    ],
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
