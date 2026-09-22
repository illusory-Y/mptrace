// OCR 页面状态：互传接收到的图片自动进入待识别队列（仅内存，不持久化）
import { defineStore } from 'pinia'

interface IncomingImage {
  blob: Blob
  name: string
  from: string
}

export const useOcrStore = defineStore('ocr', {
  state: () => ({
    /** 由互传模块推入，OCR 页面消费后清空 */
    pending: null as IncomingImage | null,
    /** 每次自增，用于 OCR 页面 watch 到"新图片到达" */
    seq: 0,
  }),
  actions: {
    pushIncoming(blob: Blob, name: string, from = '对端发送') {
      this.pending = { blob, name, from }
      this.seq++
    },
    consume(): IncomingImage | null {
      const v = this.pending
      this.pending = null
      return v
    },
  },
})
