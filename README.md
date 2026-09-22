# 私传助手（LocalTransferSuite）

一套 **Vue 3 + Tauri 2** 代码，同时编译 **Windows 桌面 exe** 与 **Android APK**：
本地 OCR 扫描识别 + 全网通点对点文件互传 + 统一自定义保存目录。

> **使用边界（强制）**：仅供个人、小范围朋友点对点私下使用。**禁止公开分发、禁止上架任何应用商店、禁止商用。**

---

## 1. 项目简介

### 1.1 它能做什么

- **本地 OCR**：PaddleOCR PP-OCRv4 模型经 ONNX Runtime Web（WASM）在本机推理；相册选图 / 相机拍照 → 预览 → 识别 → 复制或导出 TXT / Word(docx) / 可检索 PDF / CSV。图片**不上传任何服务器**。
- **全网通互传**：无需同一 WiFi、无需找 IP、无需关 AP 隔离、无需账号好友。接收端生成 **6 位配对码 + 二维码**（5 分钟失效），发送端输码或扫码即连。
- **自动选路（用户无感知）**：同局域网 WebRTC 直连 → 公网 STUN 打洞直连 → 自建 TURN 加密中转兜底；界面只显示连接状态、实际路径徽标与传输进度。
- **双向传输**：PC↔手机互发文件；手机/对端发来的图片自动进入 OCR 预览页；OCR 导出的文档也可直接再发给对端。
- **统一保存目录**：首次启动强制完成「风险确认 → 选择保存目录」；OCR 导出与互传接收的所有文件都写入该目录；文件名一律 `时间戳_原名`，并做重名兜底，绝不覆盖、不散落。设置页随时改目录。

### 1.2 架构与数据流

```
┌──────────────┐     配对/SDP/ICE（极小消息，wss 加密）    ┌──────────────┐
│  发送端 App  │ ───────────────────────────────────────→ │  接收端 App  │
│ (Vue/Tauri) │          Node 信令服务（不存文件）         │ (Vue/Tauri) │
│             │ ←─────────────────────────────────────── │             │
│             │                                            │             │
│             │  WebRTC DataChannel（DTLS 加密分块传输）   │             │
│             │ ══════════ 直连 / TURN 兜底 ══════════════►│ 统一目录落盘 │
└──────────────┘                                          └──────────────┘
        OCR：图片 → WASM 模型本地推理 → 文本 → 本地导出，全程离线
```

- 信令服务：只转发配对与协商消息，看不到文件内容，不写盘。
- TURN（Coturn）：仅极端网络兜底，转发的是 DTLS/SCTP 加密后的数据包，无法还原文件，不存储。
- 前端与 Rust 侧职责：UI/传输/OCR 在前端；**所有文件写入收口到 Rust 命令**（桌面 `std::fs`，Android `MediaStore`/SAF），前端没有第二条写文件路径。

### 1.3 体验流程（最终用户视角）

1. 首次打开 → 必读风险说明（勾选同意）→ 选择保存目录（或用默认下载目录）→ 进入主界面。
2. 底部三个页签：**识别 / 互传 / 设置**，按钮均 ≥48px，支持四档字体与深色模式。
3. 互传：一端点「我要接收」得到 6 位码和二维码；另一端「我要发送」输码/扫码 → 接收端弹窗确认 → 连接成功 → 选文件/拍照/拖拽发送，双方都能看到文件名、实时进度、速度，可随时取消。
4. 收到的图片自动出现在「识别」页，点识别即可；识别结果导出后就在统一保存目录里。

---

## 2. 目录结构

```
local-transfer-suite/
├─ package.json                 # 前端/Tauri 依赖与脚本
├─ vite.config.ts  tsconfig*.json  index.html  .env.example
├─ scripts/
│  ├─ setup-runtime.mjs         # postinstall：复制 ORT WASM 运行时到 public/wasm
│  └─ fetch-models.mjs          # 下载 PP-OCRv4 ONNX 模型与字典
├─ public/
│  ├─ models/                  # det.onnx / rec.onnx / ppocr_keys.txt（脚本下载）
│  ├─ fonts/                   # SourceHanSans.ttf（PDF 导出用，手动放置）
│  └─ wasm/                    # onnxruntime-web 运行时（postinstall 自动复制）
├─ src/
│  ├─ main.ts  App.vue  style.css  types.ts  constants.ts
│  ├─ stores/                  # pinia：app（设置/引导）、ocr（接收图片暂存）
│  ├─ services/
│  │  ├─ tauri.ts              # Tauri 环境探测与命令封装（浏览器调试自动降级）
│  │  ├─ files.ts              # 【统一保存出口】时间戳命名/base64/流式写入器
│  │  ├─ exporters.ts          # TXT/CSV/docx/可检索PDF 本地生成
│  │  ├─ signaling.ts          # WebSocket 信令客户端
│  │  ├─ webrtc.ts             # DataChannel 分块/背压/进度/取消/选路探测
│  │  ├─ peer-session.ts       # 互传会话单例桥（OCR 页可直接把导出文档发给对端）
│  │  ├─ qr.ts                 # 配对二维码生成与解析
│  │  └─ ocr/engine.ts         # PP-OCR det+rec 全流水线（WASM）
│  │     └─ ocr/index.ts       # 引擎单例/图片解码
│  └─ views/                   # OnboardingView/OcrView/TransferView/SettingsView
├─ src-tauri/
│  ├─ Cargo.toml  build.rs  tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ src/main.rs  lib.rs  platform_android.rs   # 桌面/Android 文件落盘
│  ├─ android/                 # AndroidManifest 权限片段与完整参考
│  └─ icons/                   # tauri icon 生成
├─ server/                     # Node 信令服务（ws）+ Docker + 反代示例
└─ coturn/                     # Coturn 配置、docker-compose、部署说明
```

---

## 3. 环境准备（一次性）

### 3.1 通用

- **Node.js ≥ 20 LTS**、npm ≥ 10
- **Rust stable**（rustup，Windows 选 `x86_64-pc-windows-msvc`）
- Git（用于拉模型，浏览器手动下载亦可）

### 3.2 Windows 编译 exe 额外需要

- **Visual Studio 2022 Build Tools**，勾选「使用 C++ 的桌面开发」
- **WebView2 Runtime**（Win11 自带；Win10 一般也预装）

### 3.3 Android 编译 APK 额外需要

- **Android Studio**：SDK Platform **API 34**、NDK（Tauri 2 推荐 r27）、CMake
- **JDK 17**（Tauri 2 要求 17，Android Studio 内置 jbr 可直接用）
- 环境变量：
  - `ANDROID_HOME` 指向 Android SDK（如 `C:\Users\你\AppData\Local\Android\Sdk`）
  - `NDK_HOME` 指向具体 NDK 目录（如 `%ANDROID_HOME%\ndk\27.x.xxxxxx`）
- 真机：开启「开发者选项 → USB 调试」

---

## 4. 初始化与本地调试

```bash
# 1) 安装前端依赖（postinstall 会自动把 WASM 运行时复制到 public/wasm）
npm install

# 2) 下载本地 OCR 模型（约 15MB，只需一次）
npm run models:fetch

# 3) （仅“导出 PDF”需要）按 public/fonts/README.md 放入 SourceHanSans.ttf

# 4) 准备应用图标：准备一张 1024×1024 PNG，然后
npm run tauri icon ./logo.png

# 5) 前端界面调试（纯浏览器即可打开全部页面；文件保存走浏览器下载兜底）
npm run dev
# 浏览器打开 http://localhost:1420

# 6) Tauri 桌面调试（真实文件保存能力）
npm run tauri:dev
```

### 配置信令地址

复制 `.env.example` 为 `.env`，填入你部署的信令地址：

```ini
VITE_SIGNAL_URL=wss://signal.example.com/ws
VITE_STUN_URL=stun:stun.l.google.com:19302
```

> 没部署服务器前也能先调试 OCR 与全部界面；互传需要信令服务（第 5 节）。设置页里也可以临时改信令地址。

---

## 5. 部署信令服务（Node.js）

```bash
cd server
npm install
cp .env.example .env      # 编辑 TURN_URL/用户名/密码（第 6 节部署 Coturn 后回填）
npm start                 # 监听 ws://0.0.0.0:8787/ws，健康检查 /health
```

### 5.1 进程守护（pm2）

```bash
npm i -g pm2
pm2 start signaling.mjs --name lts-signaling
pm2 save && pm2 startup
```

### 5.2 Docker

```bash
cd server
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

### 5.3 wss 反代（必须，App 正式环境只连 wss）

- **Caddy（最省事，自动证书）**：改 `server/Caddyfile.example` 域名后 `caddy run`
- **Nginx**：参考 `server/nginx-wss.example.conf`

前端最终填写形如 `wss://signal.example.com/ws`。信令服务本身无状态、不入库、不写文件，可水平多开（注意配对双方需落到同一实例，单实例足够小圈子使用；多实例需引入 Redis 房间同步，本项目刻意保持简单未引入）。

---

## 6. 部署 Coturn（TURN 兜底）

详见 [`coturn/README.md`](coturn/README.md)，要点：

1. 一台有公网 IP 的 VPS，`apt install coturn`，使用 `coturn/turnserver.conf`（改 `external-ip`、`user`、`realm`、证书）。
2. 放行端口：**3478/tcp+udp、5349/tcp+udp、49152-65535/udp**（主机防火墙与云安全组两层都要放行）。
3. 用 [Trickle ICE 测试页](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) 验证能得到 `relay` 候选。
4. 把同样的 `TURN_URL / TURN_USERNAME / TURN_CREDENTIAL` 回填到 `server/.env` 并重启信令。客户端连接时自动收到，用户无需配置。

没有 Coturn 也能用：同 WiFi 与大多数公网直连场景只靠 STUN 即可；只有双方都是对称 NAT 时才必须 TURN。

---

## 7. 编译 Windows PC 桌面 exe

```bash
# 前置：第 3.2 节的 MSVC 构建工具、图标、模型、.env 均已就绪
npm run tauri:build
```

产物：

- NSIS 安装包：`src-tauri/target/release/bundle/nsis/LocalTransferSuite_1.0.0_x64-setup.exe`
- MSI：`src-tauri/target/release/bundle/msi/*.msi`
- 绿色单文件：`src-tauri/target/release/local-transfer-suite.exe`

NSIS 为当前用户安装（无需管理员权限）。安装后首次启动即进入风险确认与目录引导。

---

## 8. 编译 Android APK

### 8.1 初始化安卓工程（只需一次）

```bash
npm run android:init
# 生成 src-tauri/gen/android
```

### 8.2 合并最小权限

打开 `src-tauri/gen/android/app/src/main/AndroidManifest.xml`，把
`src-tauri/android/AndroidManifest.additions.xml` 中的权限块复制进 `<manifest>`
（完整目标形态见 `AndroidManifest.reference.xml`）：

- `INTERNET`：信令/中继（OCR 不需要联网）
- `CAMERA`：拍照、扫码
- `READ_MEDIA_IMAGES`（Android 13+）/ `READ_EXTERNAL_STORAGE`（maxSdkVersion=32）
- `WRITE_EXTERNAL_STORAGE` 仅 `maxSdkVersion=28`
- **不申请** `MANAGE_EXTERNAL_STORAGE`：Android 10+ 保存完全走 MediaStore 与 SAF

### 8.3 真机联调

```bash
npm run android:dev
# 手机用 USB 连接并授权调试；首次会安装 debug 包并热更新前端
```

### 8.4 打 release APK

```bash
npm run android:build -- --apk
```

产物路径：

```
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

release 签名：默认使用 debug keystore 时只能自用安装（符合本项目私下使用定位）。
若要生成正式 keystore：

```bash
keytool -genkey -v -keystore lts.keystore -alias lts -keyalg RSA -keysize 2048 -validity 36500
```

在 `gen/android/app/build.gradle.kts` 的 `android { signingConfigs { create("release"){...} } }` 中引用，或用 Android Studio → Build → Generate Signed APK 向导完成。**无论何种签名，都不得公开分发或上架。**

### 8.5 安装到手机

把 APK 发到手机（本工具自传到电脑再发回手机也行），允许「安装未知来源应用」后安装，首次启动同样强制走风险确认与目录引导（SAF 选择目录，无需所有文件权限）。

---

## 9. npm / Cargo 依赖清单

### 9.1 前端 dependencies（package.json）

| 依赖 | 用途 |
|---|---|
| vue 3.5 / pinia | 界面与状态 |
| @tauri-apps/api | Tauri 命令桥 |
| onnxruntime-web | WASM 本地推理（PP-OCR 模型） |
| docx | 导出 Word |
| pdf-lib + @pdf-lib/fontkit | 导出可检索 PDF（内嵌中文字体） |
| qrcode | 生成配对二维码 |
| @zxing/browser + @zxing/library | 摄像头扫配对码 |
| dev：vite 6 / @vitejs/plugin-vue / typescript / vue-tsc / @tauri-apps/cli | 构建与 Tauri 工具链 |

### 9.2 信令服务（server/package.json）

- `ws`：WebSocket；`dotenv`：环境变量。无数据库、无文件存储。

### 9.3 Rust（src-tauri/Cargo.toml）

- `tauri 2`、`tauri-plugin-dialog 2`（系统目录选择器）
- `serde / serde_json`、`base64`（IPC 字节编码）、`dirs`（桌面默认下载目录）
- Android 专属：`ndk-context`、`jni`（MediaStore/SAF 桥接）

---

## 10. 已知限制（请如实告知使用者）

1. **OCR 手写差**：PP-OCRv4 mobile 仅对清晰印刷中文效果好；手写、模糊、强反光、大角度透视错字率高，重要内容必须人工核对。
2. **CSV 只是简单文本**：每个识别行一个单元格，无法还原合并单元格、多层表头等复杂 Excel 排版；需要表格结构请用识别文本自行整理。
3. **极端网络走 TURN 有延迟**：双方都处于对称 NAT 时经服务器中转，速度受 VPS 带宽与线路影响；直连时不经过服务器。TURN 只转发密文，不存储，但能观测到"IP、连接时长、流量大小"这类元数据。
4. **Android 高版本存储限制**：
   - Android 10+ 不能也不再使用传统路径直写公共目录；默认走 `MediaStore.Downloads`，自定义目录走 SAF，用户必须通过系统选择器授权一次。
   - 个别定制 ROM 的 SAF「创建文档」行为有差异，已做重名重试，若仍失败请改选 Download 目录。
   - 接收超大文件（数 GB）时 Android 端先写应用缓存再导入目标目录，需要预留约 1 倍文件大小的临时空间，完成后自动清理。
5. **配对码安全模型**：6 位数字 + 5 分钟有效期 + 接收端人工确认，只适合小圈子；不要把配对码发给陌生人；服务端未做账号体系，无法追溯身份。
6. **浏览器调试模式**（`npm run dev` 直接开网页）没有真实目录写入能力，会走浏览器下载；完整能力以 Tauri 桌面/安卓为准。
7. **iOS 不在本项目范围**；macOS/Linux 桌面可编译但未做专门适配。
8. **模型体积与首启速度**：首次识别需加载约 15MB 模型，低端安卓机 det 阶段可能需要数秒；WASM 单线程以换取最好兼容性。
9. **信令单实例**：未做横向扩展与消息持久化（刻意保持最小化）；重启服务会断开进行中的配对，不影响已建立的 P2P 连接。

---

## 11. 分发与合规注意事项（强制阅读）

- 本工具定位为**个人与小范围朋友点对点私下使用**，**禁止公开分发、禁止上架应用商店、禁止任何形式商用**。
- 你部署的信令/TURN 服务器只对你认识的人开放；建议用防火墙安全组、`allowed-peer-ip`、强 TURN 密码收敛访问面，避免变成开放中继被滥用。
- OCR 模型（Apache-2.0）、思源/Noto 字体（OFL）、各开源依赖遵循其各自许可，私下自用合规；若未来用途变化，需自行重新评估许可与数据合规义务。
- 不得用于传输违法或侵权内容；端到端加密不改变发送者自身的法律责任。
- 建议在朋友群内同时发送「使用边界 + 风险说明」，应用内首次启动弹窗不可跳过，设置页可随时回看。

---

## 12. 常见问题排查

| 现象 | 排查 |
|---|---|
| 点识别提示"未找到模型" | 执行 `npm run models:fetch`，确认 `public/models` 下有 det.onnx/rec.onnx/ppocr_keys.txt |
| 导出 PDF 报缺字体 | 按 `public/fonts/README.md` 放入 TrueType 中文字体并命名 SourceHanSans.ttf |
| 一直停在"正在建立连接" | 信令地址是否 wss 可达；换网络测试；部署 TURN 并确认 Trickle ICE 有 relay 候选 |
| 安卓扫码打不开摄像头 | 确认已合并 CAMERA 权限，系统设置里给了相机权限；WebView 版本建议更新到最新 |
| 安卓保存找不到文件 | 默认在系统「下载/Download」；自定义 SAF 目录按设置页显示的路径查看；部分 ROM 文件管理器需刷新 |
| `tauri build` 报图标缺失 | 先执行 `npm run tauri icon ./logo.png` |
| Windows 编译报 link.exe/ MSVC 错误 | 安装 VS2022 Build Tools 的 C++ 桌面开发负载，并 `rustup default stable-msvc` |
| 手机与电脑始终 relay | 说明双方 NAT 均为对称型，属正常兜底；改善体验可换网络或升级 VPS 线路 |

---

## 13. 关键实现索引

- 自动选路与路径展示：`src/services/webrtc.ts`（ICE candidate-pair 的 candidateType → lan/public/relay）
- 分块与背压：同文件 `CHUNK_SIZE/HIGH_WATER/LOW_WATER` 与 `bufferedamountlow`
- 配对码 5 分钟失效：`server/signaling.mjs`（CODE_TTL_MS）+ 前端倒计时
- 统一保存出口：`src/services/files.ts` → Rust 命令 → `src-tauri/src/lib.rs` / `platform_android.rs`
- 时间戳重命名：前端 `timestampName()` + 桌面 `unique_path()` + Android SAF 重名重试，三重防覆盖
- 首次强制引导：`src/views/OnboardingView.vue`（未完成不可进入主界面）
- CSP 与权限：`src-tauri/tauri.conf.json`（connect-src 仅放行 ws/wss）、`capabilities/default.json`
