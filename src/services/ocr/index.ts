// OCR 门面：使用 @paddleocr/paddleocr-js 官方包（PP-OCRv5，WASM 本地推理）
// 全局单例，避免重复加载 WASM 模型；图片全程本地处理，不上传任何服务器
import type { OcrResult, OcrLine } from '../../types'

export type OcrEngineState = 'idle' | 'loading' | 'ready' | 'error'

// 官方包类型（用 any 避免类型导入问题）
type PaddleOCRInstance = any

let ocrInstance: PaddleOCRInstance | null = null
let engineState: OcrEngineState = 'idle'
let engineText = '尚未加载模型'

const listeners = new Set<(state: OcrEngineState, text: string) => void>()

export function getEngineState(): { state: OcrEngineState; text: string } {
  return { state: engineState, text: engineText }
}

export function onEngineStateChange(fn: (state: OcrEngineState, text: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  listeners.forEach((fn) => fn(engineState, engineText))
}

function setState(s: OcrEngineState, text: string) {
  engineState = s
  engineText = text
  emit()
}

/** 预加载 OCR 引擎（静默加载，失败不打扰） */
export async function preloadEngine(): Promise<void> {
  if (engineState === 'ready' && ocrInstance) return
  if (engineState === 'loading') return
  await initEngine()
}

async function initEngine(): Promise<void> {
  if (engineState === 'ready' && ocrInstance) return
  setState('loading', '正在加载 OCR 引擎…')
  try {
    // 动态导入，避免首屏加载过大
    const paddleModule: any = await import('@paddleocr/paddleocr-js')
    const PaddleOCR = paddleModule.PaddleOCR || paddleModule.default?.PaddleOCR
    if (!PaddleOCR) throw new Error('无法加载 PaddleOCR 模块')

    // 检测是否在 Tauri Android WebView 中（多线程 WASM 支持不稳定，降级单线程）
    const isAndroidWebView =
      typeof navigator !== 'undefined' &&
      /Android/i.test(navigator.userAgent) &&
      /; wv\)/i.test(navigator.userAgent)

    const useWorker = !isAndroidWebView
    const threadCount = isAndroidWebView ? 1 : 4

    setState('loading', isAndroidWebView ? '正在初始化（兼容模式）…' : '正在初始化 WASM 运行时…')
    ocrInstance = await PaddleOCR.create({
      lang: 'ch',
      ocrVersion: 'PP-OCRv5',
      worker: useWorker,
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: isAndroidWebView ? 3 : 6,
      ortOptions: {
        backend: 'wasm',
        numThreads: threadCount,
        simd: true,
      },
    })

    setState('loading', '正在加载中文识别模型…')
    // 显式初始化（加载模型），添加超时保护
    if (typeof ocrInstance.initialize === 'function') {
      await Promise.race([
        ocrInstance.initialize(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('模型加载超时（90秒），请检查网络后重试')), 90000),
        ),
      ])
    }

    setState('ready', '模型就绪')
  } catch (err) {
    console.error('OCR 初始化失败:', err)
    const e = err as Error
    setState('error', e?.message || 'OCR 引擎初始化失败')
    ocrInstance = null
    throw err
  }
}

const MAX_SRC_SIDE = 2048 // 超大照片先等比缩小，控制 WASM 内存

async function decodeToCanvas(source: Blob | File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(source)
  const scale = Math.min(1, MAX_SRC_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvas
}

/** 识别一张图片，全程本地完成 */
export async function recognizeImage(
  source: Blob | File,
  onProgress?: (msg: string) => void,
): Promise<{ result: OcrResult; dataUrl: string }> {
  const t0 = performance.now()

  // 确保引擎已初始化
  if (!ocrInstance || engineState !== 'ready') {
    await initEngine()
  }

  const canvas = await decodeToCanvas(source)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)

  onProgress?.('正在识别文字…')
  setState('loading', '正在识别文字…')

  try {
    const results: any[] = await ocrInstance!.predict(canvas, {
      textDetLimitSideLen: 960,
      textRecScoreThresh: 0.45,
    })

    const elapsedMs = Math.round(performance.now() - t0)

    // 转换结果格式
    const lines: OcrLine[] = []
    if (results && results.length > 0 && results[0].items) {
      for (const item of results[0].items) {
        // poly 是四个角点 [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]
        const poly: number[][] = item.poly
        const xs = poly.map((p) => p[0])
        const ys = poly.map((p) => p[1])
        const x0 = Math.min(...xs)
        const y0 = Math.min(...ys)
        const x1 = Math.max(...xs)
        const y1 = Math.max(...ys)
        lines.push({
          text: item.text || '',
          score: item.score || 0,
          box: [x0, y0, x1, y1] as [number, number, number, number],
        })
      }
    }

    // 按 y 坐标排序，然后按 x 坐标排序，还原阅读顺序
    lines.sort((a, b) => {
      const ay = (a.box[1] + a.box[3]) / 2
      const by = (b.box[1] + b.box[3]) / 2
      if (Math.abs(ay - by) > 15) return ay - by
      const ax = (a.box[0] + a.box[2]) / 2
      const bx = (b.box[0] + b.box[2]) / 2
      return ax - bx
    })

    const fullText = lines.map((l) => l.text).join('\n')
    const result: OcrResult = { lines, fullText, elapsedMs }

    setState('ready', `识别完成，共 ${lines.length} 行，耗时 ${(elapsedMs / 1000).toFixed(1)}s`)
    return { result, dataUrl }
  } catch (err) {
    const e = err as Error
    setState('error', e?.message || '识别失败')
    throw err
  }
}
