<script setup lang="ts">
// 本地 OCR 页：选图/拍照 -> 本地 WASM 识别 -> 文本预览 -> 复制或导出到统一保存目录
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { useOcrStore } from '../stores/ocr'
import { recognizeImage, preloadEngine, getEngineState, onEngineStateChange } from '../services/ocr'
import { copyText, exportOcrResult, buildExportFile } from '../services/exporters'
import { saveSmallFile } from '../services/files'
import { isPeerConnected, sendBytesToPeer } from '../services/peer-session'
import type { ExportFormat, OcrLine } from '../types'

const app = useAppStore()
const ocrStore = useOcrStore()

const albumInput = ref<HTMLInputElement | null>(null)
const cameraInput = ref<HTMLInputElement | null>(null)
const previewUrl = ref('')
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const imageName = ref('ocr')
const recognizing = ref(false)
const progressText = ref('')
const resultText = ref('')
const resultLines = ref<OcrLine[]>([])
const elapsedMs = ref(0)
const toast = ref('')
const engineText = ref(getEngineState().text)
const sendFmt = ref<ExportFormat>('txt')
const peerReady = ref(isPeerConnected())

let currentBlob: Blob | null = null
let toastTimer: number | undefined
let peerPollTimer: number | undefined
let imgNaturalW = 0
let imgNaturalH = 0

const offEngine = onEngineStateChange((_s, text) => (engineText.value = text))

watch(
  () => ocrStore.seq,
  () => consumePending(),
)

onMounted(() => {
  // 静默预加载模型，失败不打扰（点识别时会再次尝试并展示错误）
  void preloadEngine().catch(() => {})
  consumePending()
  // 轮询对端连接状态，用于"导出并直接发送"按钮可用性
  peerPollTimer = window.setInterval(() => (peerReady.value = isPeerConnected()), 1500)
})

onBeforeUnmount(() => {
  offEngine()
  if (peerPollTimer) clearInterval(peerPollTimer)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

function consumePending() {
  const p = ocrStore.consume()
  if (p) void loadBlob(p.blob, p.name)
}

function pickAlbum() {
  albumInput.value?.click()
}
function pickCamera() {
  cameraInput.value?.click()
}

async function onFileChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await loadBlob(file, file.name)
  input.value = ''
}

async function loadBlob(blob: Blob, name: string) {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  currentBlob = blob
  imageName.value = name.replace(/\.[^.]+$/, '') || 'ocr'
  previewUrl.value = URL.createObjectURL(blob)
  resultText.value = ''
  resultLines.value = []
}

async function runRecognize() {
  if (!currentBlob) {
    showToast('请先选择或拍摄一张图片')
    return
  }
  recognizing.value = true
  progressText.value = '准备中…'
  try {
    const { result } = await recognizeImage(currentBlob, (m) => (progressText.value = m))
    resultLines.value = result.lines
    resultText.value = result.fullText
    elapsedMs.value = result.elapsedMs
    if (!result.lines.length) progressText.value = '未检测到清晰文本，请尝试更平整、光线更好的图片'
    else progressText.value = `识别完成，共 ${result.lines.length} 行，耗时 ${result.elapsedMs / 1000}s`
  } catch (e) {
    progressText.value = (e as Error).message
  } finally {
    recognizing.value = false
  }
}

async function doCopy() {
  if (!resultText.value) return showToast('暂无可复制的文本')
  await copyText(resultText.value)
  showToast('已复制到剪贴板')
}

async function doExport(fmt: ExportFormat) {
  if (!resultLines.value.length) return showToast('请先完成识别')
  if (!app.effectiveDir) return showToast('尚未设置保存目录，请到设置页选择')
  try {
    const display = await exportOcrResult(fmt, resultLines.value, app.effectiveDir, imageName.value)
    showToast(`已保存：${display}`)
  } catch (e) {
    showToast((e as Error).message)
  }
}

/** 生成导出文档 -> 先存入统一保存目录 -> 再直接发给已连接对端 */
async function exportAndSend() {
  if (!resultLines.value.length) return showToast('请先完成识别')
  try {
    const built = await buildExportFile(sendFmt.value, resultLines.value, imageName.value)
    if (app.effectiveDir) {
      await saveSmallFile(app.effectiveDir, built.name, built.bytes, built.mime)
    }
    await sendBytesToPeer(built.name, built.bytes, built.mime)
    showToast('已保存到本地，并已加入发送队列，可到「互传」页查看进度')
  } catch (e) {
    showToast((e as Error).message)
  }
}

function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 4000)
}

function onImgLoad(ev: Event) {
  const img = ev.target as HTMLImageElement
  imgNaturalW = img.naturalWidth
  imgNaturalH = img.naturalHeight
  drawBoxes()
}

function drawBoxes() {
  const canvas = previewCanvas.value
  if (!canvas || !imgNaturalW || !resultLines.value.length) return
  const wrap = canvas.parentElement
  if (!wrap) return
  const img = wrap.querySelector('img')
  if (!img) return
  const rect = img.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  canvas.width = rect.width
  canvas.height = rect.height
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const sx = rect.width / imgNaturalW
  const sy = rect.height / imgNaturalH
  ctx.strokeStyle = '#ef4444'
  ctx.lineWidth = 2
  for (const line of resultLines.value) {
    const [x0, y0, x1, y1] = line.box
    ctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy)
  }
}

watch(resultLines, () => setTimeout(drawBoxes, 50))
</script>

<template>
  <section>
    <p class="notice warn">
      本地模型仅擅长<b>清晰印刷中文</b>；手写体、模糊、倾斜照片错字率高，重要内容请人工核对。识别全程在本机完成，图片不上传任何服务器。
    </p>

    <div class="card">
      <h3>1. 选择图片</h3>
      <div class="grid-2">
        <button class="btn btn-lg" @click="pickAlbum">相册 / 文件选图</button>
        <button class="btn btn-lg" @click="pickCamera">相机拍照</button>
      </div>
      <input
        ref="albumInput"
        type="file"
        accept="image/*"
        hidden
        @change="onFileChosen"
      />
      <input
        ref="cameraInput"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        @change="onFileChosen"
      />
      <div v-if="previewUrl" class="preview-wrap" style="margin-top: 12px; position: relative; display: inline-block">
        <img :src="previewUrl" class="preview-img" alt="待识别图片预览" @load="onImgLoad" />
        <canvas ref="previewCanvas" class="preview-canvas" style="position: absolute; left: 0; top: 0; pointer-events: none"></canvas>
      </div>
    </div>

    <div class="card">
      <h3>2. 开始识别</h3>
      <button class="btn btn-primary btn-lg btn-block" :disabled="recognizing" @click="runRecognize">
        {{ recognizing ? '识别中…' : '开始本地识别' }}
      </button>
      <p class="muted" style="margin: 8px 0 0">{{ recognizing ? progressText : engineText }}</p>
    </div>

    <div class="card" v-if="resultText || resultLines.length">
      <h3>
        3. 识别结果
        <span class="muted" style="font-weight: 400">（可直接编辑修正）</span>
      </h3>
      <textarea v-model="resultText" class="input" placeholder="识别文本将显示在这里"></textarea>
      <div class="row" style="margin-top: 12px">
        <button class="btn" @click="doCopy">复制文本</button>
        <button class="btn" @click="doExport('txt')">导出 TXT</button>
        <button class="btn" @click="doExport('docx')">导出 Word</button>
        <button class="btn" @click="doExport('pdf')">导出可检索 PDF</button>
        <button class="btn" @click="doExport('csv')">导出 CSV</button>
      </div>
      <p class="muted" style="margin-bottom: 0">
        CSV 仅输出简单文本，复杂表格会排版错乱，无法还原完整 Excel；PDF 中文可检索、可复制。
      </p>

      <div class="row" style="margin-top: 12px; align-items: center; gap: 10px; flex-wrap: wrap">
        <select v-model="sendFmt" class="input" style="width: auto; min-height: 48px">
          <option value="txt">TXT 文档</option>
          <option value="docx">Word 文档</option>
          <option value="pdf">可检索 PDF</option>
          <option value="csv">CSV 文本</option>
        </select>
        <button class="btn btn-primary" :disabled="!peerReady" @click="exportAndSend">
          导出并直接发送给对端
        </button>
        <span class="muted">{{
          peerReady ? '对端已连接，可直接发送' : '请先到「互传」页完成配对连接'
        }}</span>
      </div>
    </div>

    <div v-if="toast" class="notice info" style="position: sticky; bottom: 12px">{{ toast }}</div>
  </section>
</template>
