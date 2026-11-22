/**
 * Shared JSON schemas for the OpenAPI document. Requests are still validated by zod in each
 * route (see `setValidatorCompiler` in app.ts), so these schemas describe the API and shape
 * responses. They never reject a request on their own.
 */

/** Token amounts are NUMERIC columns, returned as decimal strings and never as JS numbers. */
export const amount = {
  type: 'string',
  pattern: '^\\d+$',
  description: 'Token amount in stroops, as a decimal string',
} as const;

export const nullableString = { type: ['string', 'null'] } as const;
export const nullableInteger = { type: ['integer', 'null'] } as const;
export const dateTime = { type: 'string', format: 'date-time' } as const;
export const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

export const pagination = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  offset: { type: 'integer', minimum: 0, default: 0 },
} as const;

/** Query string for every list route that accepts `limit` and `offset`. */
export const paginationQuery = { type: 'object', properties: pagination } as const;

/** Error envelope returned by the global error handler and by individual routes. */
export const errorBody = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Machine readable error code' },
    message: { type: 'string' },
    issues: {
      type: 'array',
      description: 'Field level problems, present on validation errors',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
} as const;

export const errorResponse = (description: string) => ({ ...errorBody, description }) as const;
