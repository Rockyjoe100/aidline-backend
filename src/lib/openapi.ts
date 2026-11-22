import { z } from 'zod';

/**
 * Converts a zod schema to the JSON Schema that OpenAPI documents. Input shape, so fields with
 * defaults are optional. Campaign ids are bigints in zod but digit strings on the wire.
 */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === 'bigint') {
        jsonSchema.type = 'string';
        jsonSchema.pattern = '^\\d+$';
      }
    },
  });
  delete json.$schema;
  return json;
}

/**
 * Route options that document path params and query string in OpenAPI. Fastify neither validates
 * nor serializes with these schemas: the handlers keep parsing with zod, so responses and error
 * bodies stay exactly as they were.
 */
export function documentRoute(options: {
  tag: string;
  params?: z.ZodType;
  querystring?: z.ZodType;
}) {
  return {
    schema: {
      tags: [options.tag],
      ...(options.params && { params: jsonSchema(options.params) }),
      ...(options.querystring && { querystring: jsonSchema(options.querystring) }),
    },
    validatorCompiler: () => () => true,
  };
}
