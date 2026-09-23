<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAppStore } from './stores/app'
import { fetchEnvInfo } from './services/tauri'
import OnboardingView from './views/OnboardingView.vue'
import OcrView from './views/OcrView.vue'
import TransferView from './views/TransferView.vue'
import SettingsView from './views/SettingsView.vue'

const app = useAppStore()
const tab = ref<'ocr' | 'transfer' | 'settings'>('ocr')

onMounted(async () => {
  app.applyLook()
  // 拿到平台默认下载目录（浏览器调试模式返回占位描述）
  try {
    const info = await fetchEnvInfo()
    app.setEnvInfo(info)
    // Android：状态栏物理像素换算为 CSS px，注入全局安全区变量做刘海避让
    if (info.statusBarHeight > 0) {
      const dpr = window.devicePixelRatio || 1
      const cssPx = info.statusBarHeight / dpr
      document.documentElement.style.setProperty('--sat', `${cssPx}px`)
    }
  } catch {
    /* 忽略，进入引导时还会再试 */
  }
})
</script>

<template>
  <OnboardingView v-if="!app.onboarded" />
  <div v-else class="app-shell">
    <header class="app-header">
      <span>私传助手</span>
      <span class="muted" style="font-weight: 400; font-size: 0.82rem">
        本地 OCR · 全网通点对点互传
      </span>
    </header>

    <main class="app-content">
      <!-- v-show 保持互传页的连接状态不被销毁 -->
      <OcrView v-show="tab === 'ocr'" />
      <TransferView v-show="tab === 'transfer'" />
      <SettingsView v-show="tab === 'settings'" />
    </main>

    <nav class="tabbar">
      <button :class="{ active: tab === 'ocr' }" @click="tab = 'ocr'">
        <span class="tab-ico">文</span>识别
      </button>
      <button :class="{ active: tab === 'transfer' }" @click="tab = 'transfer'">
        <span class="tab-ico">传</span>互传
      </button>
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">
        <span class="tab-ico">设</span>设置
      </button>
    </nav>
  </div>
</template>
