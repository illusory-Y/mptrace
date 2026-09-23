<script setup lang="ts">
// 运行日志查看弹窗：只读展示 + 一键复制 + 清空
import { computed, ref, watch } from 'vue'
import { logger } from '../services/logger'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const text = ref('')
const copied = ref(false)

watch(
  () => props.open,
  (v) => {
    if (v) {
      text.value = logger.exportText()
      copied.value = false
    }
  },
)

const count = computed(() => logger.all().length)

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    // clipboard 不可用时降级为全选，用户可手动 Ctrl+C
    const ta = document.getElementById('log-textarea') as HTMLTextAreaElement | null
    ta?.select()
  }
}

function clearLogs() {
  logger.clear()
  text.value = logger.exportText()
}
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="max-width: 560px">
      <h2>运行日志（{{ count }} 条）</h2>
      <p class="muted" style="font-size: 0.82rem">
        连接异常时，点「复制日志」把内容发出，即可定位是信令、穿透还是中继的问题。
      </p>
      <textarea
        id="log-textarea"
        class="input"
        readonly
        :value="text"
        style="
          height: 320px;
          font-family: ui-monospace, Menlo, Consolas, monospace;
          font-size: 0.72rem;
          line-height: 1.45;
          resize: vertical;
        "
      ></textarea>
      <div class="grid-2" style="margin-top: 10px">
        <button class="btn btn-lg" @click="clearLogs">清空日志</button>
        <button class="btn btn-primary btn-lg" @click="copy">
          {{ copied ? '已复制 ✓' : '复制日志' }}
        </button>
      </div>
      <button class="btn btn-block btn-lg" style="margin-top: 8px" @click="emit('close')">
        关闭
      </button>
    </div>
  </div>
</template>
