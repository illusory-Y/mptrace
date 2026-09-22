// ============================================================
// OCR 结果导出：复制文本 / TXT / docx(Word) / 可检索 PDF / CSV
// 全部由前端本地生成，随后交给 files.saveSmallFile 统一保存到用户目录
// ============================================================
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from 'docx'
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { ExportFormat, OcrLine } from '../types'
import { saveSmallFile, timestampName } from './files'

const UTF8_BOM = '\uFEFF'

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

function toTxtBytes(text: string): Uint8Array {
  return new TextEncoder().encode(UTF8_BOM + text)
}

/** CSV 仅简单文本：每个识别行作为一个单元格；复杂表格无法还原排版（界面已明示） */
function toCsvBytes(lines: OcrLine[]): Uint8Array {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  const body = lines.length ? lines.map((l) => esc(l.text)).join('\r\n') : ''
  return new TextEncoder().encode(UTF8_BOM + '识别文本\r\n' + body + '\r\n')
}

async function toDocxBytes(text: string, baseName: string): Promise<Uint8Array> {
  const paragraphs = text.split('\n').map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line, size: 24 })], // 12pt
      }),
  )
  const doc = new Document({
    creator: '私传助手-本地OCR',
    title: baseName,
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: baseName, bold: true, size: 32 })],
          }),
          ...paragraphs,
        ],
      },
    ],
  })
  return new Uint8Array(await Packer.toBuffer(doc))
}

/** 按可用宽度对中英文混合文本做逐字符换行 */
function wrapLine(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: (t: string) => number,
): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    if (measure(cur + ch) > maxWidth && cur) {
      out.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

async function toPdfBytes(text: string): Promise<Uint8Array> {
  // 中文字体必须内嵌，否则中文无法显示/检索。字体放置方式见 public/fonts/README.md
  const fontUrl = new URL('fonts/SourceHanSans.ttf', document.baseURI).href
  const resp = await fetch(fontUrl)
  if (!resp.ok) {
    throw new Error(
      '未找到内嵌中文字体 public/fonts/SourceHanSans.ttf，请按 public/fonts/README.md 下载字体后再导出 PDF',
    )
  }
  const fontBytes = await resp.arrayBuffer()
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })

  const PAGE_W = 595.28 // A4
  const PAGE_H = 841.89
  const MARGIN = 48
  const fontSize = 12
  const lineHeight = 22
  const maxWidth = PAGE_W - MARGIN * 2

  let page = pdf.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN
  const draw = (line: string) => {
    if (y < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H])
      y = PAGE_H - MARGIN
    }
    page.drawText(line, {
      x: MARGIN,
      y,
      size: fontSize,
      font,
      color: rgb(0.08, 0.1, 0.16),
    })
    y -= lineHeight
  }

  for (const para of text.split('\n')) {
    const wrapped = wrapLine(para || ' ', maxWidth, fontSize, (t) =>
      font.widthOfTextAtSize(t, fontSize),
    )
    wrapped.forEach(draw)
    y -= lineHeight * 0.35
  }
  return new Uint8Array(await pdf.save())
}

export interface BuiltExport {
  name: string
  bytes: Uint8Array
  mime: string
}

/** 按格式构建导出文件（时间戳命名），既可落盘也可直接发给对端 */
export async function buildExportFile(
  format: ExportFormat,
  lines: OcrLine[],
  originalImageName = 'ocr_result',
): Promise<BuiltExport> {
  const base = originalImageName.replace(/\.[^.]+$/, '')
  const stampBase = timestampName(base).replace(/\.[^.]+$/, '')
  const fullText = lines.map((l) => l.text).join('\n')

  switch (format) {
    case 'txt':
      return { name: `${stampBase}.txt`, bytes: toTxtBytes(fullText), mime: 'text/plain' }
    case 'csv':
      return { name: `${stampBase}.csv`, bytes: toCsvBytes(lines), mime: 'text/csv' }
    case 'docx':
      return {
        name: `${stampBase}.docx`,
        bytes: await toDocxBytes(fullText, base),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }
    case 'pdf':
      return {
        name: `${stampBase}.pdf`,
        bytes: await toPdfBytes(fullText),
        mime: 'application/pdf',
      }
    default:
      throw new Error(`不支持的导出格式：${format as string}`)
  }
}

/** 统一导出入口：生成字节 -> 保存到用户配置目录 */
export async function exportOcrResult(
  format: ExportFormat,
  lines: OcrLine[],
  saveDir: string,
  originalImageName = 'ocr_result',
): Promise<string> {
  const file = await buildExportFile(format, lines, originalImageName)
  const saved = await saveSmallFile(saveDir, file.name, file.bytes, file.mime)
  return saved.display
}
