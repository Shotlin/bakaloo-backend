import PDFDocument from 'pdfkit'
import { STORE_INFO } from '../config/storeInfo.js'

const TERMINAL_BANNER_STATUS = new Set(['CANCELLED', 'REFUNDED'])
const PAGE_LEFT = 50
const PAGE_RIGHT = 545
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
 * Store logo + registration details, shared by the invoice and the packing
 * slip so both documents carry identical branding.
 */
function drawStoreHeader(doc, title) {
  const logoWidth = 170
  try {
    doc.image(STORE_INFO.logoPath, (doc.page.width - logoWidth) / 2, doc.y, { width: logoWidth })
    doc.y += logoWidth / 2.71 + 10
  } catch {
    // Missing/unreadable logo file must never break invoice generation.
    doc.fontSize(20).font('Helvetica-Bold').text(STORE_INFO.name, { align: 'center' })
    doc.moveDown(0.3)
  }

  doc.font('Helvetica-Bold').fontSize(9).text(`GST No: ${STORE_INFO.gstNo}`, { align: 'center' })
  doc.moveDown(0.3)

  doc.font('Helvetica').fontSize(9)
  for (const line of STORE_INFO.addressLines) {
    doc.text(line, { align: 'center' })
  }
  doc.text(STORE_INFO.phone, { align: 'center' })
  doc.moveDown(0.5)

  if (title) {
    doc.font('Helvetica-Bold').fontSize(13).text(title, { align: 'center' })
    doc.moveDown(0.4)
  }

  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.8)
}

/**
 * Two-column "Customer Details" block — name/phone/address on the left,
 * order id/date/delivery time on the right. Address height is measured so
 * multi-line addresses never overlap the section that follows.
 */
function drawCustomerDetails(doc, order, address) {
  const rowTop = doc.y
  doc.font('Helvetica-Bold').fontSize(11).text('Customer Details', PAGE_LEFT, rowTop)

  const infoTop = rowTop + 20
  const addressText = formatAddress(address) || '-'

  doc.font('Helvetica-Bold').fontSize(9)
  doc.text('Name', PAGE_LEFT, infoTop)
  doc.text('Phone', PAGE_LEFT, infoTop + 16)
  doc.text('Address', PAGE_LEFT, infoTop + 32)

  doc.font('Helvetica').fontSize(9)
  doc.text(order.customer_name || order.customerName || '-', PAGE_LEFT + 60, infoTop, { width: 190 })
  doc.text(order.customer_phone || order.customerPhone || '-', PAGE_LEFT + 60, infoTop + 16)
  const addressHeight = doc.heightOfString(addressText, { width: 190 })
  doc.text(addressText, PAGE_LEFT + 60, infoTop + 32, { width: 190 })

  const rightX = 340
  doc.font('Helvetica-Bold').fontSize(9)
  doc.text('Order ID', rightX, infoTop)
  doc.text('Order Date', rightX, infoTop + 16)
  doc.text('Delivery Time', rightX, infoTop + 32)

  doc.font('Helvetica').fontSize(9)
  doc.text(order.order_number || order.orderNumber || '-', rightX + 85, infoTop, { width: 120 })
  doc.text(formatOrderDate(order.created_at || order.createdAt), rightX + 85, infoTop + 16)
  const deliveredAt = order.delivered_at || order.deliveredAt
  doc.text(deliveredAt ? formatDeliveryTime(deliveredAt) : '-', rightX + 85, infoTop + 32)

  const leftBlockEnd = infoTop + 32 + Math.max(addressHeight, 12)
  doc.y = Math.max(leftBlockEnd, infoTop + 48) + 12
}

function drawTerminalBanner(doc, order) {
  const isRefunded = order.status === 'REFUNDED'
  const bannerColor = isRefunded ? '#B45309' : '#B91C1C' // amber-700 / red-700
  const transition = findStatusTransition(order.timeline, order.status)
  const refundAmount = order.payment?.refund_amount
    ? parseFloat(order.payment.refund_amount)
    : null

  const bannerTop = doc.y
  const bannerHeight = transition || refundAmount ? 54 : 30
  doc.rect(PAGE_LEFT, bannerTop, PAGE_WIDTH, bannerHeight).fillAndStroke('#FEF2F2', bannerColor)

  doc.fillColor(bannerColor).font('Helvetica-Bold').fontSize(13)
    .text(isRefunded ? 'ORDER REFUNDED' : 'ORDER CANCELLED', PAGE_LEFT + 10, bannerTop + 7)

  doc.font('Helvetica').fontSize(9)
  let bannerLine = bannerTop + 26
  if (transition?.changed_at) {
    const label = isRefunded ? 'Refunded on' : 'Cancelled on'
    doc.text(`${label} ${formatOrderDate(transition.changed_at)}`, PAGE_LEFT + 10, bannerLine)
    bannerLine += 14
  }
  if (transition?.note) {
    doc.text(`Reason: ${transition.note}`, PAGE_LEFT + 10, bannerLine, { width: 420 })
  }
  if (refundAmount) {
    doc.font(CURRENCY_FONT).text(`Refund amount: ₹${refundAmount.toFixed(2)}`, 350, bannerTop + 26)
  }

  // Reset both fill and stroke — .fillAndStroke() above leaves the banner's
  // red/amber as the active stroke color, which would otherwise bleed into
  // every table line and box border drawn after a cancelled/refunded order.
  doc.fillColor('black').strokeColor('black')
  doc.y = bannerTop + bannerHeight + 14
}

/**
 * Items table. `withPrice: true` renders the invoice's Item/Qty/Price (₹)
 * columns; `withPrice: false` renders the packing slip's Item/Qty/Unit
 * columns (no pricing, by design — packing slips are a picking aid).
 */
function drawItemsTable(doc, items, { withPrice }) {
  const tableTop = doc.y
  const colX = withPrice
    ? { item: PAGE_LEFT, qty: 300, price: 460 }
    : { item: PAGE_LEFT, qty: 370, unit: 450 }

  doc.font('Helvetica-Bold').fontSize(10)
  doc.text('Item', colX.item, tableTop)
  doc.text('Qty', colX.qty, tableTop)
  if (withPrice) {
    doc.font(CURRENCY_FONT).fontSize(10).text('Price (₹)', colX.price, tableTop, { width: 85, align: 'right' })
  } else {
    doc.text('Unit', colX.unit, tableTop)
  }

  doc.moveTo(PAGE_LEFT, tableTop + 15).lineTo(PAGE_RIGHT, tableTop + 15).stroke()

  let y = tableTop + 24
  doc.font('Helvetica').fontSize(9)

  for (const item of items) {
    const name = item.name || item.productName || 'Product'
    const qty = item.quantity || item.qty || 0

    if (y > 700) {
      doc.addPage()
      y = 50
    }

    doc.text(name, colX.item, y, { width: withPrice ? 230 : 300 })
    doc.text(String(qty), colX.qty, y)

    if (withPrice) {
      const price = parseFloat(item.price || 0)
      const total = parseFloat(item.total ?? qty * price)
      doc.text(total.toFixed(2), colX.price, y, { width: 85, align: 'right' })
    } else {
      doc.text(item.unit || '-', colX.unit, y)
    }

    y += 20
  }

  doc.moveTo(PAGE_LEFT, y + 4).lineTo(PAGE_RIGHT, y + 4).stroke()
  doc.y = y + 16
}

function drawTotals(doc, order) {
  const subtotal = parseFloat(order.subtotal || 0)
  const discount = parseFloat(order.discount_amount || order.discountAmount || 0)
  const delivery = parseFloat(order.delivery_fee || order.deliveryFee || 0)
  const handling = parseFloat(order.handling_fee || order.handlingFee || 0)
  const tax = parseFloat(order.tax_amount || order.taxAmount || 0)
  const total = parseFloat(order.total_amount || order.totalAmount || 0)
  const savings = parseFloat(order.savings_total || order.savingsTotal || 0)

  const labelX = 350
  const valueX = 460
  let y = doc.y

  const printLine = (label, value, bold = false) => {
    const size = bold ? 12 : 10
    const sign = value < 0 ? '-' : ''
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
    doc.text(label, labelX, y)
    doc.font(CURRENCY_FONT).fontSize(size)
    doc.text(`${sign}₹${Math.abs(value).toFixed(2)}`, valueX, y, { width: 85, align: 'right' })
    y += bold ? 20 : 17
  }

  printLine('Subtotal', subtotal)
  printLine('Delivery Fee', delivery)
  printLine('Handling Fee', handling)
  if (tax > 0) printLine('Tax', tax)
  if (discount > 0) printLine('Discount', -discount)

  doc.moveTo(labelX, y + 2).lineTo(PAGE_RIGHT, y + 2).stroke()
  y += 12

  printLine('Total', total, true)
  y += 4

  doc.font('Helvetica').fontSize(9)
  doc.text('Payment Method:', labelX, y)
  doc.text(order.payment_method || order.paymentMethod || '-', valueX - 40, y, { width: 125, align: 'right' })
  y += 22

  if (savings > 0) {
    doc.rect(PAGE_LEFT, y, PAGE_WIDTH, 24).stroke()

    // Mixed-font sentence (₹ needs CURRENCY_FONT, the rest stays Helvetica) —
    // pdfkit can't mix fonts within one text() call, so each fragment is
    // measured and positioned manually to read as one centered line.
    const before = 'Customer saved '
    const amount = `₹${savings.toFixed(2)}`
    const after = ' on this order'
    doc.font('Helvetica-Bold').fontSize(9)
    const beforeWidth = doc.widthOfString(before)
    const afterWidth = doc.widthOfString(after)
    doc.font(CURRENCY_FONT).fontSize(9)
    const amountWidth = doc.widthOfString(amount)

    let x = PAGE_LEFT + (PAGE_WIDTH - beforeWidth - amountWidth - afterWidth) / 2
    const textY = y + 7
    doc.font('Helvetica-Bold').text(before, x, textY, { lineBreak: false })
    x += beforeWidth
    doc.font(CURRENCY_FONT).text(amount, x, textY, { lineBreak: false })
    x += amountWidth
    doc.font('Helvetica-Bold').text(after, x, textY, { lineBreak: false })

    y += 34
  }

  doc.y = y
}

function drawFooter(doc) {
  // Explicit x/width rather than a flowing text() call — a preceding section
  // can leave doc.x parked mid-page (e.g. after the items table's last
  // column), which would otherwise narrow the "centered" width and wrap
  // this one-line sentence across two lines.
  doc.y += 20
  doc.font('Helvetica-Oblique').fontSize(10)
    .text(`— Thank you for shopping with ${STORE_INFO.name}! —`, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.font('Helvetica').fontSize(8)
    .text('We hope to serve you again soon.', PAGE_LEFT, doc.y + 16, { width: PAGE_WIDTH, align: 'center' })
}

/**
 * Generate a PDF invoice buffer for an order
 * @param {Object} order - Order object with items, delivery_address, etc.
 *   Optional `order.timeline` (order_status_history rows) and
 *   `order.payment` (latest payments row) enrich the CANCELLED/REFUNDED
 *   banner with a date, reason, and refund amount when available — the
 *   invoice still renders correctly without them, just with a plainer
 *   banner (no date/reason line).
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generateInvoicePDF(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []

    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.registerFont(CURRENCY_FONT, STORE_INFO.currencyFontPath)

    const { address, items } = parseOrderShape(order)

    drawStoreHeader(doc)
    drawCustomerDetails(doc, order, address)

    if (TERMINAL_BANNER_STATUS.has(order.status)) {
      drawTerminalBanner(doc, order)
    } else {
      doc.moveDown(0.6)
    }

    drawItemsTable(doc, items, { withPrice: true })
    drawTotals(doc, order)
    drawFooter(doc)

    doc.end()
  })
}

/**
 * Generate a PDF packing slip buffer for an order — items + quantities only,
 * no pricing (a picking/packing aid, not a bill), but branded identically to
 * the invoice (same logo/GST/address header and footer).
 * @param {Object} order
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generatePackingSlipPDF(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []

    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const { address, items } = parseOrderShape(order)

    drawStoreHeader(doc, 'PACKING SLIP')
    drawCustomerDetails(doc, order, address)
    doc.moveDown(0.6)
    drawItemsTable(doc, items, { withPrice: false })
    drawFooter(doc)

    doc.end()
  })
}
