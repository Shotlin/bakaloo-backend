/**
 * Centralized error messages — use these keys throughout the app
 * Keeps error strings consistent and easy to localize
 */
export const ERRORS = {
  // Auth
  PHONE_REQUIRED: 'Phone number is required',
  INVALID_PHONE: 'Invalid phone number format',
  OTP_SEND_FAILED: 'Failed to send OTP. Please try again.',
  INVALID_OTP: 'Invalid OTP',
  OTP_EXPIRED: 'OTP expired or not found. Request a new one.',
  OTP_LOCKED: 'Too many failed attempts. Account temporarily locked.',
  UNAUTHORIZED: 'Unauthorized — authentication required',
  TOKEN_EXPIRED: 'Token has expired',
  INVALID_TOKEN: 'Invalid token',
  REFRESH_TOKEN_REQUIRED: 'Refresh token is required',
  INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token',

  // Authorization
  FORBIDDEN: 'Forbidden — insufficient permissions',

  // User
  USER_NOT_FOUND: 'User not found',
  USER_BLOCKED: 'Your account has been blocked. Contact support.',
  EMAIL_TAKEN: 'Email is already in use',

  // General
  NOT_FOUND: 'Resource not found',
  VALIDATION_ERROR: 'Validation error',
  INTERNAL_ERROR: 'Internal server error',
  RATE_LIMIT: 'Rate limit exceeded. Please try again later.',

  // Products
  PRODUCT_NOT_FOUND: 'Product not found',
  OUT_OF_STOCK: 'Product is out of stock',

  // Orders
  ORDER_NOT_FOUND: 'Order not found',
  CANNOT_CANCEL: 'Order cannot be cancelled at this stage',
  EMPTY_CART: 'Cart is empty',

  // Payments
  PAYMENT_FAILED: 'Payment verification failed',
  INVALID_SIGNATURE: 'Invalid payment signature',

  // Coupons
  INVALID_COUPON: 'Invalid or expired coupon code',
  COUPON_LIMIT: 'Coupon usage limit reached',
}
