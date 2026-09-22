// npm postinstall：把 onnxruntime-web 的 WASM 运行时复制到 public/wasm
// 前端通过 ort.env.wasm.wasmPaths = './wasm/' 加载，避免打包器路径问题
import { cp, mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'node_modules', 'onnxruntime-web', 'dist')
const dst = path.join(root, 'public', 'wasm')

await mkdir(dst, { recursive: true })

if (!existsSync(src)) {
  console.warn('[setup-runtime] 未找到 node_modules/onnxruntime-web，请先执行 npm install')
  process.exit(0)
}

await cp(src, dst, {
  recursive: true,
  filter: (s) => {
    let isDir = false
    try {
      isDir = statSync(s).isDirectory()
    } catch {
      isDir = false
    }
    return isDir || /\.(wasm|mjs)$/.test(s)
  },
})

console.log('[setup-runtime] ONNX Runtime Web WASM 运行时已复制到 public/wasm')
