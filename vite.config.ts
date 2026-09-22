import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// dev 模式下直接服务 public/wasm/*.mjs，绕过 Vite 6 的"public 文件不可 import"限制
// onnxruntime-web 运行时会动态 import 这些胶水文件，它们不需要转换
const wasmMjsDevPlugin = {
  name: 'wasm-mjs-dev',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url = (req.url || '').split('?')[0]
      if (url.startsWith('/wasm/') && url.endsWith('.mjs')) {
        const file = path.join(__dirname, 'public', url)
        if (fs.existsSync(file)) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          fs.createReadStream(file).pipe(res)
          return
        }
      }
      next()
    })
  },
}

// Tauri 2 期望固定端口；base 必须为相对路径，Android WebView 才能正确加载资源
export default defineConfig({
  plugins: [vue(), wasmMjsDevPlugin],
  base: './',
  clearScreen: false,
  // 处理 wasm 包中可能引用的 Node.js 全局变量
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    'process.env': JSON.stringify({}),
    'process.platform': JSON.stringify('browser'),
    global: 'globalThis',
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
    // 多线程 WASM 需要 COOP/COEP 头
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // 真机 Android 调试时可用 `npm run dev -- --host 0.0.0.0`
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 10000,
    assetsInlineLimit: 0,
  },
  // onnxruntime-web / paddleocr-js 以 ESM/WASM/Worker 方式加载，不做预打包
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@paddleocr/paddleocr-js'],
    // 强制预构建 CommonJS 依赖，解决默认导出问题（Vite 6 需显式声明）
    include: [
      'clipper-lib',
      '@techstark/opencv-js',
      'vue',
      'pinia',
      'qrcode',
      'docx',
      'pdf-lib',
      '@pdf-lib/fontkit',
    ],
    esbuildOptions: {
      target: 'es2020',
      define: {
        global: 'globalThis',
      },
    },
  },
  // Worker 配置
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
