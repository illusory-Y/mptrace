# 字体目录（导出可检索 PDF 用）

导出中文 PDF 必须内嵌中文字体，否则中文无法显示/检索。

## 需要的文件

```
public/fonts/SourceHanSans.ttf
```

**必须是 TrueType（glyf 轮廓）的 .ttf 文件**；Adobe 官方思源黑体仓库默认是 OTF（CFF 轮廓），
pdf-lib 无法嵌入，请选择 TTF 版本。

## 获取方式（SIL OFL 开源协议，可随个人工具本地使用）

1. 思源黑体 TTF 移植版：<https://github.com/be5invis/source-han-sans-ttf/releases>
   下载 Regular 字重 TTF，重命名为 `SourceHanSans.ttf` 放入本目录。
2. 或使用任意授权合规的中文 TTF（如 Noto Sans SC 的 TTF 静态实例），同样重命名即可。

## 说明

- 不导出 PDF 时不需要下载字体，其他功能不受影响。
- 字体仅在本机用于生成 PDF，不会上传。
- 生成的 PDF 文本可选、可搜索、可复制（可检索 PDF）。
