function normalizeTimelineType(rawTimelineType) {
  const normalized = `${rawTimelineType || ''}`.trim().toUpperCase()
  if (!normalized) {
    return 'ORDER_STATUS'
  }
  if (normalized === 'OUT_FOR_DELIVERY') {
    return 'PICKED_UP'
  }
  return normalized
}

export function buildCustomerOrderEventNotification({
  orderId,
  orderNumber,
  timelineType,
  status,
  otp,
}) {
  const normalizedTimelineType = normalizeTimelineType(timelineType)
  const normalizedStatus = `${status || ''}`.trim().toUpperCase()
  const cleanOtp = `${otp || ''}`.trim()
  const otpSuffix = cleanOtp
    ? ` Your delivery OTP is ${cleanOtp} — share it with your delivery partner when they arrive.`
    : ''

  const messageMap = {
    ORDER_PLACED: {
      title: '🛍️ Order placed',
      body: `Your order ${orderNumber} was placed successfully. We will keep you updated here.`,
    },
    RIDER_ACCEPTED: {
      title: '🛵 Rider accepted your order',
      body: `A delivery partner accepted order ${orderNumber}. Please wait a few minutes while they get ready.`,
    },
    PICKED_UP: {
      title: '📦 Your order is on the way',
      body: `Order ${orderNumber} has been picked up and is now heading to you.${otpSuffix}`,
    },
    OTP_RESENT: {
      title: '🔑 Your delivery OTP',
      body: `Your delivery OTP for order ${orderNumber} is ${cleanOtp}. Share it with your delivery partner to confirm delivery.`,
    },
    DELIVERED: {
      title: '✅ Delivered successfully',
      body: `Order ${orderNumber} has been delivered. Enjoy your purchase.`,
    },
    CANCELLED: {
      title: '❌ Order cancelled',
      body: `Order ${orderNumber} was cancelled because the delivery could not be completed.`,
    },
  }

  const fallback = {
    title: '📣 Order update',
    body: `There is a new update for order ${orderNumber}.`,
  }

  const message = messageMap[normalizedTimelineType] || fallback

  return {
    title: message.title,
    body: message.body,
    type: 'ORDER_STATUS',
    data: {
      type: 'ORDER_STATUS',
      orderId,
      orderNumber,
      timelineType: normalizedTimelineType,
      status: normalizedStatus,
      ...(cleanOtp ? { deliveryOtp: cleanOtp } : {}),
    },
  }
}
