import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * OpenAPI 3 spec — the contract of record (§15). Because request/response
 * bodies are validated with zod (not class DTOs), schemas and examples are
 * attached here explicitly rather than reflected. Served at /v1/docs (UI) and
 * /v1/docs-json (raw). INTEGRATION_GUIDE.md is the exhaustive companion.
 */

const DESCRIPTION = [
  'Backend for the JustGo automotive marketplace — one API for the Client',
  '("Orange") and Supplier ("Green") apps.',
  '',
  '## Auth',
  'Authentication is handled by the **self-hosted Supabase GoTrue** (not this',
  'API). Obtain a JWT from GoTrue (email or phone sign-in), then send it as',
  '`Authorization: Bearer <jwt>`. This API verifies the token (HS256) and reads',
  'these custom claims: `account_id`, `roles`, `permissions`, and — for',
  'supplier staff — `supplier_id`/`branch_id`. The first call to `GET /v1/me`',
  'self-provisions the account row.',
  '',
  '## Conventions',
  '- **Money** is always `{ amountMinor, currency }` — integer minor units + ISO-4217.',
  '- **Timestamps** are UTC ISO-8601.',
  '- **Idempotency**: creating POSTs accept an `Idempotency-Key` header.',
  '- **Errors** use a stable envelope: `{ error: { code, message, details }, traceId }`.',
  '- **Lists** return `{ items: [...] }` (cursor pagination lands with volume).',
  '',
  '## Realtime',
  'Live updates broadcast over the self-hosted **Supabase Realtime** on channels',
  '`supplier:{supplierId}`, `request:{requestId}`, and `account:{accountId}`.',
  'See INTEGRATION_GUIDE.md.',
].join('\n');

function schemas(): Record<string, unknown> {
  const money = {
    type: 'object',
    required: ['amountMinor', 'currency'],
    properties: {
      amountMinor: { type: 'integer', example: 9500, description: 'Integer minor units (e.g. cents).' },
      currency: { type: 'string', example: 'EUR', description: 'ISO-4217 alpha-3.' },
    },
  };
  return {
    Money: money,
    ErrorEnvelope: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'VALIDATION_FAILED' },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        traceId: { type: 'string', nullable: true },
      },
    },
    Account: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        authUserId: { type: 'string', format: 'uuid' },
        firstName: { type: 'string', nullable: true },
        familyName: { type: 'string', nullable: true },
        email: { type: 'string', nullable: true },
        phone: { type: 'string', nullable: true },
        locale: { type: 'string', enum: ['en', 'es', 'fr'] },
        roles: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Quote: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        requestId: { type: 'string', format: 'uuid' },
        supplierId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['price', 'alternative'], nullable: true },
        amount: { allOf: [{ $ref: '#/components/schemas/Money' }], nullable: true },
        altName: { type: 'string', nullable: true },
        altReference: { type: 'string', nullable: true },
        altTecdocArticleId: { type: 'integer', nullable: true },
        status: {
          type: 'string',
          enum: ['pending', 'quoted', 'rejected', 'accepted', 'refused', 'closed'],
        },
        reason: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        isBest: { type: 'boolean', description: 'True for the current lowest priced quote.' },
      },
    },
    PartRequest: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        clientAccountId: { type: 'string', format: 'uuid' },
        vehicleId: { type: 'string', format: 'uuid', nullable: true },
        tecdocArticleId: { type: 'integer', nullable: true },
        categoryKey: { type: 'string', nullable: true },
        freeText: { type: 'string', nullable: true },
        photoUrl: { type: 'string', nullable: true },
        quantity: { type: 'integer' },
        strategy: { type: 'string', enum: ['all', 'single'] },
        status: {
          type: 'string',
          enum: ['pending', 'awaiting_client', 'accepted', 'refused', 'expired', 'cancelled'],
        },
        createdAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
        quotes: { type: 'array', items: { $ref: '#/components/schemas/Quote' } },
        bestQuoteId: { type: 'string', format: 'uuid', nullable: true },
      },
    },
    Order: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        requestId: { type: 'string', format: 'uuid', nullable: true },
        quoteId: { type: 'string', format: 'uuid', nullable: true },
        clientAccountId: { type: 'string', format: 'uuid' },
        supplierId: { type: 'string', format: 'uuid' },
        fulfilment: { type: 'string', enum: ['home', 'pickup', 'carrier', 'install'] },
        workshopSupplierId: { type: 'string', format: 'uuid', nullable: true },
        appointmentAt: { type: 'string', format: 'date-time', nullable: true },
        amount: { allOf: [{ $ref: '#/components/schemas/Money' }], nullable: true },
        status: {
          type: 'string',
          enum: ['created', 'confirmed', 'in_progress', 'completed', 'cancelled'],
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Supplier: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        ownerAccountId: { type: 'string', format: 'uuid' },
        verticalKey: { type: 'string', example: 'part_store' },
        name: { type: 'string' },
        isOpen: { type: 'boolean' },
        isMultiBranch: { type: 'boolean' },
        city: { type: 'string', nullable: true },
        country: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Notification: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        type: { type: 'string', example: 'quote.received' },
        title: { type: 'string', nullable: true },
        body: { type: 'string', nullable: true },
        refId: { type: 'string', format: 'uuid', nullable: true },
        read: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    AssemblyGroup: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        key: { type: 'string', example: 'braking' },
        label: {
          type: 'object',
          properties: { en: { type: 'string' }, es: { type: 'string' }, fr: { type: 'string' } },
        },
        parentId: { type: 'integer', nullable: true },
      },
    },
    ArticleRef: {
      type: 'object',
      properties: {
        articleId: { type: 'integer' },
        name: { type: 'string' },
        brand: { type: 'string' },
        reference: { type: 'string' },
        assemblyGroupId: { type: 'integer', nullable: true },
      },
    },
    VehicleType: {
      type: 'object',
      properties: {
        kType: { type: 'integer' },
        manufacturer: { type: 'string' },
        model: { type: 'string' },
        typeName: { type: 'string' },
        fromYear: { type: 'integer', nullable: true },
        toYear: { type: 'integer', nullable: true },
        powerKw: { type: 'integer', nullable: true },
        fuel: { type: 'string', nullable: true },
      },
    },
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const listOf = (name: string) => ({
  type: 'object',
  properties: { items: { type: 'array', items: ref(name) } },
});
const errors = (): Record<string, unknown> => {
  const envelope = { 'application/json': { schema: ref('ErrorEnvelope') } };
  return {
    '400': { description: 'Validation error', content: envelope },
    '401': { description: 'Unauthenticated', content: envelope },
    '403': { description: 'Forbidden', content: envelope },
    '404': { description: 'Not found', content: envelope },
    '409': { description: 'Conflict / illegal state transition', content: envelope },
    '422': { description: 'Business rule violated', content: envelope },
  };
};

/** Attach request/response schemas + examples to specific operations. */
function enrich(doc: OpenAPIObject): void {
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
  const set = (path: string, method: string, spec: Record<string, unknown>) => {
    const op = paths[path]?.[method];
    if (op) Object.assign(op, spec);
  };
  const body = (schema: unknown, example?: unknown) => ({
    required: true,
    content: { 'application/json': { schema, ...(example ? { example } : {}) } },
  });
  const ok = (schema: unknown) => ({
    '200': { description: 'OK', content: { 'application/json': { schema } } },
  });

  set('/v1/me', 'get', {
    tags: ['Me'],
    summary: 'Get (and self-provision) the current account',
    responses: { ...ok(ref('Account')), ...errors() },
  });
  set('/v1/me', 'put', {
    tags: ['Me'],
    summary: 'Update the current profile',
    requestBody: body({
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        familyName: { type: 'string' },
        phone: { type: 'string' },
        locale: { type: 'string', enum: ['en', 'es', 'fr'] },
      },
    }),
    responses: { ...ok(ref('Account')), ...errors() },
  });

  set('/v1/requests', 'post', {
    tags: ['Client · Requests'],
    summary: 'Submit a part request (fans out to suppliers)',
    requestBody: body(
      {
        type: 'object',
        required: ['strategy'],
        properties: {
          vehicleId: { type: 'string', format: 'uuid' },
          tecdocArticleId: { type: 'integer' },
          categoryKey: { type: 'string' },
          freeText: { type: 'string' },
          photoUrl: { type: 'string' },
          quantity: { type: 'integer' },
          strategy: { type: 'string', enum: ['all', 'single'] },
          targetSupplierId: { type: 'string', format: 'uuid' },
          expiresInMinutes: { type: 'integer' },
        },
      },
      { strategy: 'all', categoryKey: 'braking', tecdocArticleId: 1001, quantity: 2 },
    ),
    responses: { ...ok(ref('PartRequest')), ...errors() },
  });
  set('/v1/requests', 'get', {
    tags: ['Client · Requests'],
    summary: 'List my requests',
    responses: { ...ok(listOf('PartRequest')), ...errors() },
  });
  set('/v1/requests/{id}', 'get', {
    tags: ['Client · Requests'],
    summary: 'Get one of my requests with its quotes',
    responses: { ...ok(ref('PartRequest')), ...errors() },
  });
  set('/v1/requests/{id}', 'delete', {
    tags: ['Client · Requests'],
    summary: 'Cancel a request',
    responses: { ...ok(ref('PartRequest')), ...errors() },
  });
  set('/v1/quotes/{id}/accept', 'post', {
    tags: ['Client · Requests'],
    summary: 'Accept a quote (creates an order, closes the rest)',
    responses: { ...ok(ref('PartRequest')), ...errors() },
  });
  set('/v1/quotes/{id}/refuse', 'post', {
    tags: ['Client · Requests'],
    summary: 'Refuse a quote',
    responses: { ...ok(ref('PartRequest')), ...errors() },
  });

  set('/v1/supplier', 'post', {
    tags: ['Supplier · Business'],
    summary: 'Register a supplier business',
    responses: { ...ok(ref('Supplier')), ...errors() },
  });
  set('/v1/supplier/profile', 'get', {
    tags: ['Supplier · Business'],
    summary: 'My supplier profile',
    responses: { ...ok(ref('Supplier')), ...errors() },
  });
  set('/v1/supplier/requests', 'get', {
    tags: ['Supplier · Inbox'],
    summary: 'Quote inbox (requests targeting me)',
    responses: { ...ok(listOf('Quote')), ...errors() },
  });
  set('/v1/supplier/requests/{quoteId}/quote', 'post', {
    tags: ['Supplier · Inbox'],
    summary: 'Answer with a price',
    requestBody: body(
      { type: 'object', required: ['amount'], properties: { amount: ref('Money') } },
      { amount: { amountMinor: 9500, currency: 'EUR' } },
    ),
    responses: { ...ok(ref('Quote')), ...errors() },
  });
  set('/v1/supplier/requests/{quoteId}/alternative', 'post', {
    tags: ['Supplier · Inbox'],
    summary: 'Offer an alternative part',
    requestBody: body({
      type: 'object',
      required: ['altName'],
      properties: {
        altName: { type: 'string' },
        altReference: { type: 'string' },
        altTecdocArticleId: { type: 'integer' },
        amount: ref('Money'),
      },
    }),
    responses: { ...ok(ref('Quote')), ...errors() },
  });
  set('/v1/supplier/requests/{quoteId}/reject', 'post', {
    tags: ['Supplier · Inbox'],
    summary: 'Reject a request',
    responses: { ...ok(ref('Quote')), ...errors() },
  });

  set('/v1/orders', 'get', {
    tags: ['Orders'],
    summary: 'List orders (client’s, or supplier’s when supplier-scoped)',
    responses: { ...ok(listOf('Order')), ...errors() },
  });
  set('/v1/orders/{id}', 'get', {
    tags: ['Orders'],
    summary: 'Get an order',
    responses: { ...ok(ref('Order')), ...errors() },
  });
  set('/v1/orders/{id}/fulfilment', 'patch', {
    tags: ['Orders'],
    summary: 'Choose fulfilment (install requires a workshop)',
    responses: { ...ok(ref('Order')), ...errors() },
  });

  set('/v1/notifications', 'get', {
    tags: ['Notifications'],
    summary: 'Notification feed + unread count',
    responses: {
      '200': {
        description: 'OK',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: ref('Notification') },
                unread: { type: 'integer' },
              },
            },
          },
        },
      },
      ...errors(),
    },
  });
  set('/v1/notifications/{id}/read', 'patch', {
    tags: ['Notifications'],
    summary: 'Mark a notification read',
    responses: { ...ok({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errors() },
  });
  set('/v1/devices', 'post', {
    tags: ['Notifications'],
    summary: 'Register an FCM device token',
    requestBody: body({
      type: 'object',
      required: ['fcmToken'],
      properties: {
        fcmToken: { type: 'string' },
        platform: { type: 'string', enum: ['android', 'ios', 'web'] },
      },
    }),
    responses: { ...ok({ type: 'object', properties: { ok: { type: 'boolean' } } }), ...errors() },
  });

  set('/v1/catalogue/vehicles/resolve', 'get', {
    tags: ['Catalogue'],
    summary: 'Resolve a vehicle to KType candidates',
    responses: { ...ok(listOf('VehicleType')), ...errors() },
  });
  set('/v1/catalogue/assembly-groups', 'get', {
    tags: ['Catalogue'],
    summary: 'Assembly groups for a KType',
    responses: { ...ok(listOf('AssemblyGroup')), ...errors() },
  });
  set('/v1/catalogue/articles', 'get', {
    tags: ['Catalogue'],
    summary: 'Search articles (KType/group/OE/text)',
    responses: { ...ok(listOf('ArticleRef')), ...errors() },
  });
  set('/v1/catalogue/articles/{id}', 'get', {
    tags: ['Catalogue'],
    summary: 'Article detail',
    responses: { ...ok(ref('ArticleRef')), ...errors() },
  });
  set('/v1/catalogue/cross-refs', 'get', {
    tags: ['Catalogue'],
    summary: 'Cross-references (Find Best Alternative)',
    responses: { ...ok(listOf('ArticleRef')), ...errors() },
  });

  set('/v1/health', 'get', {
    tags: ['Health'],
    summary: 'Liveness probe',
    security: [],
    responses: { '200': { description: 'OK' } },
  });
}

export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('JustGo Backend API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0.0-phase1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'supabase-jwt')
    .addServer('/', 'Current host')
    .addTag('Me')
    .addTag('Client · Requests')
    .addTag('Catalogue')
    .addTag('Supplier · Inbox')
    .addTag('Supplier · Business')
    .addTag('Orders')
    .addTag('Notifications')
    .addTag('Health')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.components = document.components ?? {};
  document.components.schemas = {
    ...((document.components.schemas as Record<string, unknown>) ?? {}),
    ...schemas(),
  } as typeof document.components.schemas;
  // Every operation requires the bearer token unless it clears security.
  document.security = [{ 'supabase-jwt': [] }];
  enrich(document);

  SwaggerModule.setup('v1/docs', app, document, {
    jsonDocumentUrl: 'v1/docs-json',
    customSiteTitle: 'JustGo API',
    swaggerOptions: { persistAuthorization: true },
  });
}
