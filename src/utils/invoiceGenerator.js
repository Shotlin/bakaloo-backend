import PDFDocument from 'pdfkit'

const TERMINAL_BANNER_STATUS = new Set(['CANCELLED', 'REFUNDED'])

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

    const address = typeof order.delivery_address === 'string'
      ? JSON.parse(order.delivery_address)
      : order.delivery_address || {}

    const items = typeof order.items === 'string'
      ? JSON.parse(order.items)
      : order.items || []

    // ─── Header ───────────────────────────────────────
    doc
      .fontSize(22)
      .font('Helvetica-Bold')
      .text('INVOICE', { align: 'center' })
      .moveDown(0.3)

    doc
      .fontSize(10)
      .font('Helvetica')
      .text('Bakaloo Grocery Delivery', { align: 'center' })
      .moveDown(1.5)

    // ─── Order Info ───────────────────────────────────
    const top = doc.y
    doc.font('Helvetica-Bold').fontSize(10)

    doc.text('Invoice No:', 50, top)
    doc.font('Helvetica').text(order.order_number || order.orderNumber || '-', 140, top)

    doc.font('Helvetica-Bold').text('Date:', 50, top + 18)
    doc.font('Helvetica').text(new Date(order.created_at || order.createdAt).toLocaleDateString('en-IN'), 140, top + 18)

    doc.font('Helvetica-Bold').text('Status:', 50, top + 36)
    doc.font('Helvetica').text(order.status, 140, top + 36)

    doc.font('Helvetica-Bold').text('Payment:', 350, top)
    doc.font('Helvetica').text(`${order.payment_method || order.paymentMethod} (${order.payment_status || order.paymentStatus})`, 420, top)

    // ─── Delivery Address ─────────────────────────────
    if (address.label || address.address_line) {
      doc.font('Helvetica-Bold').text('Deliver to:', 350, top + 18)
      doc.font('Helvetica').text(
        [address.label, address.address_line, address.city, address.pincode].filter(Boolean).join(', '),
        350, top + 36,
        { width: 200 }
      )
    }

    // ─── Cancellation / Refund Banner ──────────────────
    if (TERMINAL_BANNER_STATUS.has(order.status)) {
      const isRefunded = order.status === 'REFUNDED'
      const bannerColor = isRefunded ? '#B45309' : '#B91C1C' // amber-700 / red-700
      const transition = findStatusTransition(order.timeline, order.status)
      const refundAmount = order.payment?.refund_amount
        ? parseFloat(order.payment.refund_amount)
        : null

      const bannerTop = doc.y + 6
      doc
        .rect(50, bannerTop, 495, transition || refundAmount ? 54 : 30)
        .fillAndStroke('#FEF2F2', bannerColor)

      doc
        .fillColor(bannerColor)
        .font('Helvetica-Bold')
        .fontSize(13)
        .text(
          isRefunded ? 'ORDER REFUNDED' : 'ORDER CANCELLED',
          60, bannerTop + 7
        )

      doc.font('Helvetica').fontSize(9)
      let bannerLine = bannerTop + 26
      if (transition?.changed_at) {
        const label = isRefunded ? 'Refunded on' : 'Cancelled on'
        doc.text(
          `${label} ${new Date(transition.changed_at).toLocaleDateString('en-IN')}`,
          60, bannerLine
        )
        bannerLine += 14
      }
      if (transition?.note) {
        doc.text(`Reason: ${transition.note}`, 60, bannerLine, { width: 420 })
      }
      if (refundAmount) {
        doc.text(`Refund amount: ₹${refundAmount.toFixed(2)}`, 350, bannerTop + 26)
      }

      doc.fillColor('black')
      doc.y = bannerTop + (transition || refundAmount ? 54 : 30) + 12
    } else {
      doc.moveDown(4)
    }

    // ─── Items Table Header ───────────────────────────
    const tableTop = doc.y
    const colX = { item: 50, qty: 300, price: 370, total: 460 }

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('Item', colX.item, tableTop)
      .text('Qty', colX.qty, tableTop)
      .text('Price', colX.price, tableTop)
      .text('Total', colX.total, tableTop)

    doc
      .moveTo(50, tableTop + 15)
      .lineTo(545, tableTop + 15)
      .stroke()

    // ─── Items ────────────────────────────────────────
    let y = tableTop + 22
    doc.font('Helvetica').fontSize(9)

    for (const item of items) {
      const name = item.name || item.productName || 'Product'
      const qty = item.quantity || item.qty || 0
      const price = parseFloat(item.price || 0)
      const total = parseFloat(item.total || qty * price)

      if (y > 700) {
        doc.addPage()
        y = 50
      }

      doc
        .text(name, colX.item, y, { width: 240 })
        .text(String(qty), colX.qty, y)
        .text(`₹${price.toFixed(2)}`, colX.price, y)
        .text(`₹${total.toFixed(2)}`, colX.total, y)

      y += 18
    }

    // ─── Separator ────────────────────────────────────
    doc.moveTo(50, y + 5).lineTo(545, y + 5).stroke()
    y += 15

    // ─── Totals ───────────────────────────────────────
    doc.font('Helvetica').fontSize(10)

    const subtotal = parseFloat(order.subtotal || 0)
    const discount = parseFloat(order.discount_amount || order.discountAmount || 0)
    const delivery = parseFloat(order.delivery_fee || order.deliveryFee || 0)
    const tax = parseFloat(order.tax_amount || order.taxAmount || 0)
    const total = parseFloat(order.total_amount || order.totalAmount || 0)

    const printLine = (label, value, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
      doc.text(label, 350, y).text(`₹${value.toFixed(2)}`, colX.total, y)
      y += 18
    }

    printLine('Subtotal:', subtotal)
    if (discount > 0) printLine('Discount:', -discount)
    if (delivery > 0) printLine('Delivery Fee:', delivery)
    if (tax > 0) printLine('Tax:', tax)
    printLine('Total:', total, true)

    // ─── Footer ───────────────────────────────────────
    doc.moveDown(3)
    doc
      .fontSize(8)
      .font('Helvetica')
      .text('Thank you for ordering with Bakaloo!', 50, doc.y, { align: 'center' })
      .text('This is a computer-generated invoice.', { align: 'center' })

    doc.end()
  })
}
