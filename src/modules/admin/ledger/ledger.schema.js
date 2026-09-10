const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const listLedgerAccountsSchema = {
  tags: ['Admin Ledger'],
  summary: 'List B2B ledger accounts with filters',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'] },
    },
  },
}

export const ledgerAccountDetailSchema = {
  tags: ['Admin Ledger'],
  summary: 'Get ledger account detail',
  params: uuidParam,
}

export const setupLedgerAccountSchema = {
  tags: ['Admin Ledger'],
  summary: 'Set up a B2B ledger for an approved business account',
  params: {
    type: 'object',
    required: ['businessAccountId'],
    properties: { businessAccountId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['monthlyCreditLimit'],
    properties: {
      monthlyCreditLimit: { type: 'number', exclusiveMinimum: 0 },
      hardLimit: { type: 'number', exclusiveMinimum: 0 },
      billingDay: { type: 'integer', minimum: 1, maximum: 28 },
    },
  },
}

export const updateLedgerLimitsSchema = {
  tags: ['Admin Ledger'],
  summary: 'Update a ledger account\'s credit limits / billing day',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      monthlyCreditLimit: { type: 'number', exclusiveMinimum: 0 },
      hardLimit: { type: 'number', exclusiveMinimum: 0 },
      billingDay: { type: 'integer', minimum: 1, maximum: 28 },
    },
  },
}

export const setLedgerStatusSchema = {
  tags: ['Admin Ledger'],
  summary: 'Suspend / reactivate / close a ledger account',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'] },
    },
  },
}

export const repayLedgerAccountSchema = {
  tags: ['Admin Ledger'],
  summary: 'Record a manual repayment/adjustment against a ledger account',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', exclusiveMinimum: 0 },
      description: { type: 'string', maxLength: 500 },
    },
  },
}

export const listLedgerCyclesSchema = {
  tags: ['Admin Ledger'],
  summary: 'List billing cycles for a ledger account',
  params: uuidParam,
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
    },
  },
}

export const markLedgerCyclePaidSchema = {
  tags: ['Admin Ledger'],
  summary: 'Mark a billing cycle as paid',
  params: {
    type: 'object',
    required: ['cycleId'],
    properties: { cycleId: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      amountPaid: { type: 'number', exclusiveMinimum: 0 },
      paymentReference: { type: 'string', maxLength: 255 },
    },
  },
}
