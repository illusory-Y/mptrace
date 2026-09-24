<script setup lang="ts">
// 首次启动强制流程：① 风险与使用说明（必须勾选确认） ② 保存目录引导（必须选择）
import { onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { RISK_PARAGRAPHS } from '../constants'
import { fetchEnvInfo } from '../services/tauri'

const emit = defineEmits<{ done: [] }>()
const app = useAppStore()

const step = ref<1 | 2>(1)
const agreed = ref(false)
const busy = ref(false)
const androidSubdirDraft = ref(app.androidDownloadSubdir)
const errorMsg = ref('')

onMounted(async () => {
  if (!app.defaultDir) {
    try {
      app.setEnvInfo(await fetchEnvInfo())
    } catch (e) {
      errorMsg.value = (e as Error).message
    }
  }
})

function goStep2() {
  if (!agreed.value) return
  step.value = 2
}

async function chooseDir() {
  busy.value = true
  errorMsg.value = ''
  try {
    const ok = await app.chooseCustomDir()
    if (!ok) errorMsg.value = '未选择目录，可直接使用默认路径'
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function saveAndroidSubdir() {
  app.setAndroidDownloadSubdir(androidSubdirDraft.value)
  androidSubdirDraft.value = app.androidDownloadSubdir
}

function enterApp() {
  // 必须有有效目录（默认目录或自定义目录）才能进入
  if (!app.effectiveDir) {
    errorMsg.value = '请先选择文件保存目录，或点击"使用默认路径"'
    return
  }
  app.finishOnboarding()
  emit('done')
}
</script>

<template>
  <div class="onboard-mask">
    <div class="onboard-card">
      <!-- 第一步：风险与使用说明 -->
      <template v-if="step === 1">
        <h2>使用前必读 · 风险与说明</h2>
        <div class="col" style="gap: 8px; margin-bottom: 16px">
          <p v-for="(p, i) in RISK_PARAGRAPHS" :key="i" class="notice" :class="{ warn: i > 0 }">
            {{ p }}
          </p>
        </div>
        <label class="row" style="cursor: pointer; margin-bottom: 16px">
          <input type="checkbox" v-model="agreed" style="width: 20px; height: 20px" />
          <span>我已阅读并理解以上内容，承诺仅个人/小范围私下使用</span>
        </label>
        <button class="btn btn-primary btn-lg btn-block" :disabled="!agreed" @click="goStep2">
          我已阅读，下一步
        </button>
      </template>

      <!-- 第二步：保存目录引导 -->
      <template v-else>
        <h2>请选择文件保存目录</h2>
        <p class="muted">
          所有 OCR 导出文件、互传接收的文件都将保存到此目录，不会随机放置；之后可随时在设置中修改。
        </p>
        <div class="card" style="margin: 12px 0">
          <div class="muted" style="margin-bottom: 6px">当前将使用</div>
          <div class="mono" style="word-break: break-all">
            {{ app.effectiveDirDisplay || '尚未选择（默认：系统下载文件夹）' }}
          </div>
        </div>
        <p v-if="errorMsg" class="notice warn">{{ errorMsg }}</p>
        <div class="col">
          <template v-if="app.platform === 'android'">
            <label class="muted" for="onboard-android-subdir">Download 子目录（可选）</label>
            <div class="row">
              <input id="onboard-android-subdir" class="input" v-model="androidSubdirDraft" placeholder="例如：MPTrace" />
              <button class="btn btn-primary" @click="saveAndroidSubdir">保存</button>
            </div>
            <p class="muted" style="margin: 0">
              Android 安装版默认保存到公共 Download；填写子目录后会保存到 Download/子目录。
            </p>
          </template>
          <button v-else class="btn btn-primary btn-lg btn-block" :disabled="busy" @click="chooseDir">
            选择目录
          </button>
          <button class="btn btn-lg btn-block" @click="app.backToDefault()">
            使用默认路径（系统下载文件夹 / 公共 Download）
          </button>
          <button
            class="btn btn-ghost btn-block"
            :disabled="!app.effectiveDir"
            @click="enterApp"
          >
            进入主界面
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
