# 应用图标

Tauri 编译时需要本目录存在以下文件（`tauri.conf.json > bundle.icon` 引用）：

```
32x32.png  128x128.png  128x128@2x.png  icon.icns  icon.ico
```

## 一键生成

准备一张 1024×1024 的 PNG 源图（例如 `logo.png`，放在项目根目录），执行：

```bash
npm run tauri icon ./logo.png
# 等价于 npx tauri icon ./logo.png
```

工具会自动生成 Windows(ico)、macOS(icns)、Android(mipmap) 所需的全套尺寸并写入本目录与 `gen/android`。

未生成图标前执行 `tauri build` / `tauri android build` 会报图标缺失错误，属正常现象。
