<script setup lang="ts">
// 设置页：统一保存目录、字体大小、深浅色、信令服务器、风险说明、关于
import { ref } from 'vue'
import { useAppStore } from '../stores/app'
import { RISK_PARAGRAPHS, APP_VERSION } from '../constants'

const app = useAppStore()
const showRisk = ref(false)
const signalDraft = ref(app.signalUrl)
const stunDraft = ref(app.stunUrl)
const toast = ref('')
let timer: number | undefined

function flash(msg: string) {
  toast.value = msg
  clearTimeout(timer)
  timer = window.setTimeout(() => (toast.value = ''), 3000)
}

async function changeDir() {
  try {
    const ok = await app.chooseCustomDir()
    flash(ok ? '保存目录已更新，后续文件立即写入新目录' : '已取消选择')
  } catch (e) {
    flash((e as Error).message)
  }
}

function saveSignal() {
  app.setSignalUrl(signalDraft.value)
  app.stunUrl = stunDraft.value.trim()
  app.persist()
  flash('已保存；请在互传页重新发起连接以使用新配置')
}
</script>

<template>
  <section>
    <!-- 统一保存路径 -->
    <div class="card">
      <h3>文件保存目录（统一出口）</h3>
      <p class="muted">OCR 导出文件、互传接收的文件全部保存到此目录，不会随机散落。</p>
      <div class="notice mono" style="margin: 8px 0; word-break: break-all">
        {{ app.effectiveDirDisplay || '尚未设置' }}
        <div v-if="app.useDefaultDir" class="muted">当前：系统默认（下载 / Download）</div>
      </div>
      <div class="grid-2">
        <button class="btn btn-primary btn-lg" @click="changeDir">更改保存目录</button>
        <button class="btn btn-lg" @click="app.backToDefault(); flash('已恢复为系统默认下载目录')">
          恢复默认目录
        </button>
      </div>
      <p class="muted" style="margin-bottom: 0">
        安卓通过系统存储访问框架（SAF）选择目录，兼容 Android 11+，无需"所有文件"权限。
      </p>
    </div>

    <!-- 显示 -->
    <div class="card">
      <h3>字体大小</h3>
      <div class="seg">
        <button :class="{ active: app.fontScale === 'sm' }" @click="app.setFontScale('sm')">小</button>
        <button :class="{ active: app.fontScale === 'md' }" @click="app.setFontScale('md')">标准</button>
        <button :class="{ active: app.fontScale === 'lg' }" @click="app.setFontScale('lg')">大</button>
        <button :class="{ active: app.fontScale === 'xl' }" @click="app.setFontScale('xl')">特大</button>
      </div>
      <div class="row" style="justify-content: space-between; margin-top: 14px">
        <span>深色模式</span>
        <label class="switch">
          <input
            type="checkbox"
            :checked="app.theme === 'dark'"
            @change="app.setTheme(($event.target as HTMLInputElement).checked ? 'dark' : 'light')"
          />
          <i></i>
        </label>
      </div>
    </div>

    <!-- 服务器（高级） -->
    <div class="card">
      <h3>互联服务器（私有部署）</h3>
      <label class="muted">信令服务器地址（WebSocket）</label>
      <input class="input" v-model="signalDraft" placeholder="wss://你的域名/ws" style="margin: 6px 0 10px" />
      <label class="muted">STUN 服务器（多个用英文逗号分隔）</label>
      <input class="input" v-model="stunDraft" placeholder="stun:stun.l.google.com:19302" style="margin: 6px 0 10px" />
      <button class="btn btn-primary" @click="saveSignal">保存服务器配置</button>
      <p class="muted" style="margin-bottom: 0">
        TURN 中转凭据由你的信令服务器在连接时自动下发，无需手动填写。
      </p>
    </div>

    <!-- 合规与关于 -->
    <div class="card">
      <h3>合规与关于</h3>
      <div class="col">
        <button class="btn btn-lg btn-block" @click="showRisk = true">再次查看风险与使用说明</button>
        <button class="btn btn-block" @click="app.restartOnboarding()">重新进入首次引导</button>
      </div>
      <div class="muted" style="margin-top: 12px; line-height: 1.8">
        版本：v{{ APP_VERSION }}<br />
        OCR：PaddleOCR PP-OCRv4 模型，ONNX Runtime Web（WASM）本地推理，图片不出设备。<br />
        传输：WebRTC DataChannel（DTLS/SCTP 加密）+ 私有信令 + Coturn 兜底。<br />
        <b>本工具禁止公开分发、禁止上架应用商店、禁止商用，仅限个人与小范围朋友点对点私下使用。</b>
      </div>
    </div>

    <div v-if="toast" class="notice info" style="position: sticky; bottom: 12px">{{ toast }}</div>

    <!-- 风险说明 -->
    <div v-if="showRisk" class="modal-mask" @click.self="showRisk = false">
      <div class="modal">
        <h2>风险与使用说明</h2>
        <div class="col" style="gap: 8px">
          <p v-for="(p, i) in RISK_PARAGRAPHS" :key="i" class="notice" :class="{ warn: i > 0 }">
            {{ p }}
          </p>
        </div>
        <button class="btn btn-primary btn-lg btn-block" style="margin-top: 12px" @click="showRisk = false">
          我知道了
        </button>
      </div>
    </div>
  </section>
</template>
