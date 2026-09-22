/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_SIGNAL_URL?: string
  readonly VITE_STUN_URL?: string
  readonly VITE_OCR_DEMO?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
