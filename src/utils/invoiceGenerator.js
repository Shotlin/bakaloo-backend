import PDFDocument from 'pdfkit'
import { STORE_INFO } from '../config/storeInfo.js'

const TERMINAL_BANNER_STATUS = new Set(['CANCELLED', 'REFUNDED'])

// POS thermal roll size (80mm) rather than A4 — this renders as a receipt,
// not a printed page. Height isn't fixed: every generate call renders once
// against a throwaway tall document purely to measure how much vertical
// space the content needs, then renders again for real at that exact
// height, so the PDF is always trimmed to its content (no trailing
// whitespace, no pagination).
const RECEIPT_WIDTH = 227
const RECEIPT_MARGIN = 10
const PAGE_LEFT = RECEIPT_MARGIN
const PAGE_RIGHT = RECEIPT_WIDTH - RECEIPT_MARGIN
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT

// PDFKit's standard 14 fonts can't render ₹ — any text with a rupee amount
// must use this embedded font instead (see STORE_INFO.currencyFontPath).
const CURRENCY_FONT = 'currency'

/**
 * Find the timeline entry that moved the order INTO its current terminal
 * status (CANCELLED/REFUNDED), if a timeline was supplied. Reversed search
 * because an order can bounce CANCELLED -> REFUNDED — we want the most
 * recent transition into the current status, not the first.
 */
function findStatusTransition(timeline, status) {
  if (!Array.isArray(timeline)) return null
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].to_status === status) return timeline[i]
  }
  return null
}

function parseOrderShape(order) {
  const rawAddress = order.delivery_address ?? order.deliveryAddress
  const address = typeof rawAddress === 'string'
    ? JSON.parse(rawAddress)
    : rawAddress || {}

  const items = typeof order.items === 'string'
    ? JSON.parse(order.items)
    : order.items || []

  return { address, items }
}

function formatOrderDate(date) {
  const d = new Date(date)
  const day = String(d.getDate()).padStart(2, '0')
  const month = d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()
  return `${day}-${month}-${d.getFullYear()}`
}

function formatDeliveryTime(date) {
  return new Date(date).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function formatAddress(address) {
  const addressLine = address.addressLine1 || address.address_line
  return [address.label, addressLine, address.addressLine2, address.city, address.pincode]
    .filter(Boolean)
    .join(', ')
}

/**
 * The "pack size" shoppers see under a product name (e.g. "500 g", "1 kg",
 * "6 pieces") — admin-authored free text on the product, snapshotted onto
 * the order item as `net_quantity` (see ProductForm's "Pack Size" field).
 * `unit` is a coarser base-measure classification (kg/g/piece/...) used
 * for catalog filtering, not what a picker needs on a packing slip, so it's
 * only a last-resort fallback here.
 */
function itemPackSize(item) {
  return item.net_quantity || item.netQuantity || item.unit || ''
}

/**
 * Right-aligned currency amount, drawn independently of the text cursor
 * (`lineBreak: false`) so it can share a row with a left-aligned fragment
 * drawn at the same y. Returns nothing — callers advance doc.y themselves.
 */
function drawAmount(doc, amount, y, { size = 8, bold = false } = {}) {
  const sign = amount < 0 ? '-' : ''
  doc.font(CURRENCY_FONT).fontSize(bold ? size + 1 : size)
  doc.text(`${sign}₹${Math.abs(amount).toFixed(2)}`, PAGE_LEFT, y, {
    width: PAGE_WIDTH, align: 'right', lineBreak: false,
  })
}

/**
 * Store logo + registration details, shared by the invoice and the packing
 * slip so both documents carry identical branding.
 */
function drawStoreHeader(doc, title) {
  const logoWidth = 140
  try {
    doc.image(STORE_INFO.logoPath, (RECEIPT_WIDTH - logoWidth) / 2, doc.y, { width: logoWidth })
    doc.y += logoWidth / 2.71 + 8
  } catch {
    // Missing/unreadable logo file must never break invoice generation.
    doc.fontSize(16).font('Helvetica-Bold').text(STORE_INFO.name, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
    doc.moveDown(0.3)
  }

  doc.font('Helvetica-Bold').fontSize(8).text(`GST No: ${STORE_INFO.gstNo}`, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.25)

  doc.font('Helvetica').fontSize(7.5)
  doc.text(STORE_INFO.addressLines.join(' '), PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.text(STORE_INFO.phone, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.4)

  if (title) {
    doc.font('Helvetica-Bold').fontSize(11).text(title, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
    doc.moveDown(0.3)
  }

  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.6)
}

/**
 * One "Label: value" line, wrapped to `PAGE_WIDTH` and height-measured so a
 * long value (e.g. an address) never overlaps the line drawn after it.
 */
function detailRow(doc, label, value) {
  const y = doc.y
  const labelText = `${label}: `
  doc.font('Helvetica-Bold').fontSize(8).text(labelText, PAGE_LEFT, y, { lineBreak: false })
  const labelWidth = doc.widthOfString(labelText)
  const valueWidth = PAGE_WIDTH - labelWidth
  const valueText = value || '-'

  doc.font('Helvetica').fontSize(8)
  const height = doc.heightOfString(valueText, { width: valueWidth })
  doc.text(valueText, PAGE_LEFT + labelWidth, y, { width: valueWidth })

  doc.y = y + Math.max(height, 10) + 3
}

/**
 * Single-column "Customer Details" block — narrow receipt width has no room
 * for the two-column layout an A4 invoice would use.
 */
function drawCustomerDetails(doc, order, address) {
  doc.font('Helvetica-Bold').fontSize(10).text('Customer Details', PAGE_LEFT, doc.y)
  doc.moveDown(0.4)

  detailRow(doc, 'Name', order.customer_name || order.customerName)
  detailRow(doc, 'Phone', order.customer_phone || order.customerPhone)
  detailRow(doc, 'Address', formatAddress(address))
  detailRow(doc, 'Order ID', order.order_number || order.orderNumber)
  detailRow(doc, 'Order Date', formatOrderDate(order.created_at || order.createdAt))
  const deliveredAt = order.delivered_at || order.deliveredAt
  detailRow(doc, 'Delivery Time', deliveredAt ? formatDeliveryTime(deliveredAt) : '-')

  doc.moveDown(0.3)
}

function drawTerminalBanner(doc, order) {
  const isRefunded = order.status === 'REFUNDED'
  const bannerColor = isRefunded ? '#B45309' : '#B91C1C' // amber-700 / red-700
  const transition = findStatusTransition(order.timeline, order.status)
  const refundAmount = order.payment?.refund_amount
    ? parseFloat(order.payment.refund_amount)
    : null

  const bannerTop = doc.y
  const innerLeft = PAGE_LEFT + 8
  const innerWidth = PAGE_WIDTH - 16

  // Measure first (heightOfString only, no drawing) so the box can be
  // painted before the text — otherwise fillAndStroke, drawn after, would
  // paint over whatever text came first.
  let contentHeight = 8 + 15
  let noteHeight = 0
  if (transition?.changed_at) contentHeight += 12
  if (transition?.note) {
    doc.font('Helvetica').fontSize(7.5)
    noteHeight = doc.heightOfString(`Reason: ${transition.note}`, { width: innerWidth })
    contentHeight += noteHeight + 2
  }
  if (refundAmount) contentHeight += 12
  contentHeight += 6

  doc.rect(PAGE_LEFT, bannerTop, PAGE_WIDTH, contentHeight).fillAndStroke('#FEF2F2', bannerColor)

  let y = bannerTop + 8
  doc.fillColor(bannerColor).font('Helvetica-Bold').fontSize(10)
    .text(isRefunded ? 'ORDER REFUNDED' : 'ORDER CANCELLED', innerLeft, y, { width: innerWidth })
  y += 15

  doc.font('Helvetica').fontSize(7.5)
  if (transition?.changed_at) {
    const label = isRefunded ? 'Refunded on' : 'Cancelled on'
    doc.text(`${label} ${formatOrderDate(transition.changed_at)}`, innerLeft, y, { width: innerWidth })
    y += 12
  }
  if (transition?.note) {
    doc.text(`Reason: ${transition.note}`, innerLeft, y, { width: innerWidth })
    y += noteHeight + 2
  }
  if (refundAmount) {
    doc.font(CURRENCY_FONT).text(`Refund amount: ₹${refundAmount.toFixed(2)}`, innerLeft, y, { width: innerWidth })
    y += 12
  }

  // Reset both fill and stroke — .fillAndStroke() above leaves the banner's
  // red/amber as the active color, which would otherwise bleed into every
  // table line and box border drawn after a cancelled/refunded order.
  doc.fillColor('black').strokeColor('black')
  doc.y = bannerTop + contentHeight + 10
}

/**
 * Items list, POS-receipt style: each item gets two lines — the name (with
 * its pack size, e.g. "Onion (Kanda) (1 kg)") on its own full-width line so
 * long names simply wrap, then "qty x unit price ... line total" underneath.
 */
function drawItemsTable(doc, items) {
  doc.font('Helvetica-Bold').fontSize(9).text('Items', PAGE_LEFT, doc.y)
  doc.moveDown(0.2)
  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.35)

  for (const item of items) {
    const name = item.name || item.productName || 'Product'
    const packSize = itemPackSize(item)
    const label = packSize ? `${name} (${packSize})` : name
    const qty = item.quantity || item.qty || 0
    const price = parseFloat(item.price || 0)
    const total = parseFloat(item.total ?? qty * price)

    doc.font('Helvetica-Bold').fontSize(8.5)
    doc.text(label, PAGE_LEFT, doc.y, { width: PAGE_WIDTH })
    doc.moveDown(0.1)

    const rowY = doc.y
    const qtyText = `${qty} x `
    doc.font('Helvetica').fontSize(8)
    doc.text(qtyText, PAGE_LEFT, rowY, { lineBreak: false })
    const qtyTextWidth = doc.widthOfString(qtyText) // measure before switching fonts below
    doc.font(CURRENCY_FONT).fontSize(8)
    doc.text(`₹${price.toFixed(2)}`, PAGE_LEFT + qtyTextWidth, rowY, { lineBreak: false })
    drawAmount(doc, total, rowY)

    doc.y = rowY + 12
    doc.moveDown(0.3)
  }

  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.5)
}

function drawTotals(doc, order) {
  const subtotal = parseFloat(order.subtotal || 0)
  const discount = parseFloat(order.discount_amount || order.discountAmount || 0)
  const delivery = parseFloat(order.delivery_fee || order.deliveryFee || 0)
  const handling = parseFloat(order.handling_fee || order.handlingFee || 0)
  const tax = parseFloat(order.tax_amount || order.taxAmount || 0)
  const total = parseFloat(order.total_amount || order.totalAmount || 0)
  const savings = parseFloat(order.savings_total || order.savingsTotal || 0)

  const printLine = (label, value, bold = false) => {
    const y = doc.y
    const size = bold ? 9.5 : 8
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
    doc.text(label, PAGE_LEFT, y, { lineBreak: false })
    drawAmount(doc, value, y, { size, bold })
    doc.y = y + (bold ? 16 : 13)
  }

  printLine('Subtotal', subtotal)
  printLine('Delivery Fee', delivery)
  printLine('Handling Fee', handling)
  if (tax > 0) printLine('Tax', tax)
  if (discount > 0) printLine('Discount', -discount)

  doc.moveTo(PAGE_LEFT, doc.y + 2).lineTo(PAGE_RIGHT, doc.y + 2).stroke()
  doc.y += 10

  printLine('Total', total, true)
  doc.moveDown(0.3)

  doc.font('Helvetica').fontSize(8)
  doc.text('Payment Method', PAGE_LEFT, doc.y, { lineBreak: false })
  doc.text(order.payment_method || order.paymentMethod || '-', PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'right', lineBreak: false })
  doc.moveDown(0.9)

  if (savings > 0) {
    const y = doc.y
    doc.rect(PAGE_LEFT, y, PAGE_WIDTH, 22).stroke()

    // Mixed-font sentence (₹ needs CURRENCY_FONT, the rest stays Helvetica) —
    // pdfkit can't mix fonts within one text() call, so each fragment is
    // measured and positioned manually to read as one centered line.
    const before = 'Saved '
    const amount = `₹${savings.toFixed(2)}`
    const after = ' on this order'
    doc.font('Helvetica-Bold').fontSize(8)
    const beforeWidth = doc.widthOfString(before)
    const afterWidth = doc.widthOfString(after)
    doc.font(CURRENCY_FONT).fontSize(8)
    const amountWidth = doc.widthOfString(amount)

    let x = PAGE_LEFT + (PAGE_WIDTH - beforeWidth - amountWidth - afterWidth) / 2
    const textY = y + 7
    doc.font('Helvetica-Bold').text(before, x, textY, { lineBreak: false })
    x += beforeWidth
    doc.font(CURRENCY_FONT).text(amount, x, textY, { lineBreak: false })
    x += amountWidth
    doc.font('Helvetica-Bold').text(after, x, textY, { lineBreak: false })

    doc.y = y + 30
  }
}

function drawFooter(doc) {
  // Explicit x/width rather than a flowing text() call — a preceding section
  // can leave doc.x parked mid-page, which would otherwise narrow the
  // "centered" width and wrap this one-line sentence across two lines.
  doc.y += 10
  doc.font('Helvetica-Oblique').fontSize(8.5)
    .text(`— Thank you for shopping with ${STORE_INFO.name}! —`, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.5)
  doc.font('Helvetica').fontSize(7.5)
    .text('We hope to serve you again soon.', PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
}

function renderReceipt(doc, order, address, items, { title }) {
  doc.registerFont(CURRENCY_FONT, STORE_INFO.currencyFontPath)

  drawStoreHeader(doc, title)
  drawCustomerDetails(doc, order, address)

  if (TERMINAL_BANNER_STATUS.has(order.status)) {
    drawTerminalBanner(doc, order)
  } else {
    doc.moveDown(0.3)
  }

  drawItemsTable(doc, items)
  drawTotals(doc, order)
  drawFooter(doc)

  return doc.y
}

/**
 * PDFKit fixes a page's height at creation time, so trimming a receipt PDF
 * to its content means rendering once to learn the final y position. This
 * throwaway document (tall enough for any realistic order) is never piped
 * anywhere — it exists purely so `renderReceipt`'s real drawing/measuring
 * calls (heightOfString, image, text wrapping, ...) tell us exactly how
 * tall the real page needs to be.
 */
function measureReceiptHeight(order, address, items, opts) {
  const measurer = new PDFDocument({ size: [RECEIPT_WIDTH, 5000], margin: RECEIPT_MARGIN })
  measurer.on('error', () => {})
  const finalY = renderReceipt(measurer, order, address, items, opts)
  measurer.end()
  return Math.ceil(finalY) + RECEIPT_MARGIN
}

function generateReceiptPDF(order, opts) {
  return new Promise((resolve, reject) => {
    const { address, items } = parseOrderShape(order)
    const height = measureReceiptHeight(order, address, items, opts)

    const doc = new PDFDocument({ size: [RECEIPT_WIDTH, height], margin: RECEIPT_MARGIN })
    const chunks = []

    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    renderReceipt(doc, order, address, items, opts)
    doc.end()
  })
}

/**
 * Generate a PDF invoice buffer for an order, sized as an 80mm POS receipt.
 * @param {Object} order - Order object with items, delivery_address, etc.
 *   Optional `order.timeline` (order_status_history rows) and
 *   `order.payment` (latest payments row) enrich the CANCELLED/REFUNDED
 *   banner with a date, reason, and refund amount when available — the
 *   invoice still renders correctly without them, just with a plainer
 *   banner (no date/reason line).
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generateInvoicePDF(order) {
  return generateReceiptPDF(order, { title: null })
}

/**
 * Generate a PDF packing slip buffer for an order — same branding, customer
 * details, itemized pricing and totals as the invoice (per business request,
 * the slip that ships with the order should be a complete receipt too), just
 * labelled "PACKING SLIP" instead of carrying no title.
 * @param {Object} order
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generatePackingSlipPDF(order) {
  return generateReceiptPDF(order, { title: 'PACKING SLIP' })
}
