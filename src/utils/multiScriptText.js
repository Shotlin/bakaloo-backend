import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts')

// Noto Sans {Devanagari,Bengali,Gujarati} (SIL OFL) — PDFKit's standard 14
// fonts (Helvetica etc.) only cover WinAnsi/Latin-1, so any customer-typed
// name/address in Hindi, Marathi (both Devanagari script), Bengali, or
// Gujarati rendered as mojibake, not just missing glyphs — confirmed by
// generating a real invoice with Gujarati text before this fix existed.
// Regular weight only: these are the script(s) a customer might type into
// a free-text field, not the invoice's own bold headings, so a bold/regular
// mismatch when a run sits inside otherwise-bold text is an acceptable
// trade-off against not rendering at all.
const SCRIPT_FONTS = {
  devanagari: path.join(FONTS_DIR, 'NotoSansDevanagari.ttf'), // Hindi, Marathi
  bengali: path.join(FONTS_DIR, 'NotoSansBengali.ttf'),
  gujarati: path.join(FONTS_DIR, 'NotoSansGujarati.ttf'),
}

// Ordered Unicode block ranges, checked per character. Add another script
// here (font file + range) to extend coverage — nothing else needs to
// change, splitIntoRuns/measureRuns/drawWrappedMultiScriptText are already
// script-agnostic.
const SCRIPT_RANGES = [
  { font: 'devanagari', min: 0x0900, max: 0x097f },
  { font: 'bengali', min: 0x0980, max: 0x09ff },
  { font: 'gujarati', min: 0x0a80, max: 0x0aff },
]

const registeredDocs = new WeakSet()

/**
 * Registers the Indic-script fonts on `doc` (once per document — PDFKit
 * fonts are registered per-instance, not globally) so drawWrappedMultiScriptText
 * can switch to them mid-line. Idempotent; safe to call before every draw.
 */
function registerScriptFonts(doc) {
  if (registeredDocs.has(doc)) return
  for (const [name, filePath] of Object.entries(SCRIPT_FONTS)) {
    doc.registerFont(name, filePath)
  }
  registeredDocs.add(doc)
}

function scriptFontForCodePoint(cp) {
  for (const { font, min, max } of SCRIPT_RANGES) {
    if (cp >= min && cp <= max) return font
  }
  return null
}

/** Splits `text` into runs of consecutive characters needing the same font. */
function splitIntoRuns(text, defaultFont) {
  const runs = []
  let current = ''
  let currentFont = defaultFont
  for (const ch of text) {
    const font = scriptFontForCodePoint(ch.codePointAt(0)) || defaultFont
    if (font !== currentFont && current) {
      runs.push({ text: current, font: currentFont })
      current = ''
    }
    currentFont = font
    current += ch
  }
  if (current) runs.push({ text: current, font: currentFont })
  return runs
}

function measureRuns(doc, runs, size) {
  let width = 0
  for (const run of runs) {
    doc.font(run.font).fontSize(size)
    width += doc.widthOfString(run.text)
  }
  return width
}

/** Shared word-wrap pass used by both the measuring and drawing entry points. */
function computeLines(doc, text, width, size, defaultFont) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  doc.font(defaultFont).fontSize(size)
  const spaceWidth = doc.widthOfString(' ')

  const lines = []
  let currentLine = []
  let currentWidth = 0

  for (const word of words) {
    const runs = splitIntoRuns(word, defaultFont)
    const wordWidth = measureRuns(doc, runs, size)
    const extra = currentLine.length > 0 ? spaceWidth : 0

    if (currentLine.length > 0 && currentWidth + extra + wordWidth > width) {
      lines.push(currentLine)
      currentLine = []
      currentWidth = 0
    }
    if (currentLine.length > 0) currentWidth += spaceWidth
    currentLine.push({ runs, width: wordWidth })
    currentWidth += wordWidth
  }
  lines.push(currentLine)
  return { lines, spaceWidth }
}

/**
 * Measures the height `drawWrappedMultiScriptText` would render `text` at,
 * without drawing anything — for call sites that need to size a box (e.g.
 * a background rect) before the text that goes inside it.
 */
export function measureWrappedMultiScriptTextHeight(doc, text, width, { size = 8, font: defaultFont = 'Helvetica' } = {}) {
  registerScriptFonts(doc)
  const { lines } = computeLines(doc, text, width, size, defaultFont)
  return lines.length * size * 1.3
}

/**
 * Draws `text` word-wrapped to `width`, switching fonts per run so any mix
 * of Latin and Devanagari/Bengali/Gujarati script renders with correctly
 * shaped glyphs (conjuncts, matras) instead of the mojibake PDFKit's
 * standard fonts produce for codepoints outside WinAnsi encoding.
 *
 * Drop-in-ish replacement for `doc.text(text, x, y, {width})`: like that
 * call, it advances `doc.y` past the rendered block. Returns the rendered
 * height so callers that need it explicitly (e.g. a label/value row that
 * must line up a right-aligned amount) don't have to re-measure.
 */
export function drawWrappedMultiScriptText(doc, text, x, y, width, { size = 8, font: defaultFont = 'Helvetica' } = {}) {
  registerScriptFonts(doc)
  const { lines, spaceWidth } = computeLines(doc, text, width, size, defaultFont)

  const lineHeight = size * 1.3
  let cursorY = y
  for (const line of lines) {
    let cursorX = x
    for (let i = 0; i < line.length; i++) {
      if (i > 0) cursorX += spaceWidth
      for (const run of line[i].runs) {
        doc.font(run.font).fontSize(size)
        doc.text(run.text, cursorX, cursorY, { lineBreak: false })
        cursorX += doc.widthOfString(run.text)
      }
    }
    cursorY += lineHeight
  }

  const height = cursorY - y
  doc.y = y + height
  return height
}
