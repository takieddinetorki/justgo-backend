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
  '## Auth — two steps, not one',
  '1. **Sign in with the self-hosted Supabase GoTrue** (email or phone). It',
  '   returns an access token that proves WHO the user is.',
  '2. **Exchange it at `POST /v1/auth/session`** for a JustGo session token',
  '   that also says what they may DO. Send that one as',
  '   `Authorization: Bearer <token>` on every other call.',
  '',
  'Step 2 is not optional. Roles and permissions are rows in the identity',
  'schema, so a raw GoTrue token arrives with none — and every endpoint',
  'behind a permission returns **403**. The exchange also carries the',
  '`supplier_id` claim that puts an endpoint into supplier mode.',
  '',
  'The session token keeps GoTrue’s `sub`, `role` and `aud`, so it still works',
  'against Supabase Realtime and PostgREST. It never outlives the GoTrue token',
  'it came from — re-exchange after every refresh.',
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
    Session: {
      type: 'object',
      properties: {
        accessToken: { type: 'string', description: 'Send as `Authorization: Bearer …`.' },
        tokenType: { type: 'string', enum: ['Bearer'] },
        expiresIn: {
          type: 'integer',
          example: 3600,
          description: 'Seconds. Capped by the GoTrue token this was exchanged from.',
        },
        account: { $ref: '#/components/schemas/Account' },
        roles: { type: 'array', items: { type: 'string' }, example: ['supplier_owner'] },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resolved for the requested scope, not the union of every role.',
          example: ['quote.submit', 'supplier.requests.read'],
        },
        supplier: {
          type: 'object',
          nullable: true,
          description: 'Null for a client session.',
          properties: {
            supplierId: { type: 'string', format: 'uuid' },
            branchId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
        supplierScopes: {
          type: 'array',
          description: 'Every supplier this account could scope to — offer a choice when >1.',
          items: {
            type: 'object',
            properties: {
              supplierId: { type: 'string', format: 'uuid' },
              branchId: { type: 'string', format: 'uuid', nullable: true },
              roleKey: { type: 'string', example: 'supplier_owner' },
            },
          },
        },
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
        address: { type: 'string', nullable: true },
        legalName: {
          type: 'string',
          nullable: true,
          description: 'Registered name, as it must appear on a facture.',
        },
        nif: { type: 'string', nullable: true, description: 'Numero d identification fiscale.' },
        nis: { type: 'string', nullable: true, description: 'Numero d identification statistique.' },
        rc: { type: 'string', nullable: true, description: 'Registre de commerce.' },
        taxArticle: { type: 'string', nullable: true, description: 'Article d imposition.' },
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
    Vehicle: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        ownerAccountId: { type: 'string', format: 'uuid' },
        name: { type: 'string', nullable: true, example: 'Ma Clio' },
        brand: { type: 'string', nullable: true, example: 'Renault' },
        model: { type: 'string', nullable: true, example: 'Clio IV' },
        year: { type: 'integer', nullable: true, example: 2018 },
        vin: { type: 'string', nullable: true },
        plate: { type: 'string', nullable: true, example: '00123-116-16' },
        mileageKm: { type: 'integer', nullable: true, example: 84000 },
        tecdocVehicleTypeId: { type: 'integer', nullable: true },
        tecdocManufacturerId: { type: 'integer', nullable: true },
        tecdocModelId: { type: 'integer', nullable: true },
        healthStatus: {
          type: 'string',
          enum: ['optimal', 'good', 'warning', 'critical', 'urgent'],
        },
        photoUrl: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    MaintenanceTask: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        vehicleId: { type: 'string', format: 'uuid' },
        title: { type: 'string', example: 'Vidange' },
        intervalKm: { type: 'integer', nullable: true, example: 10000 },
        intervalMonths: { type: 'integer', nullable: true, example: 12 },
        dueAtKm: { type: 'integer', nullable: true },
        dueDate: { type: 'string', format: 'date', nullable: true },
        status: { type: 'string', enum: ['pending', 'due', 'done', 'dismissed'] },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    HealthEntry: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        vehicleId: { type: 'string', format: 'uuid' },
        systemArea: { type: 'string', nullable: true, example: 'braking' },
        status: { type: 'string', nullable: true, example: 'warning' },
        note: { type: 'string', nullable: true },
        mileageKm: { type: 'integer', nullable: true },
        at: { type: 'string', format: 'date-time' },
      },
    },
    AssistanceRequest: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        clientAccountId: { type: 'string', format: 'uuid' },
        vehicleId: { type: 'string', format: 'uuid', nullable: true },
        serviceType: {
          type: 'string',
          enum: ['breakdown', 'tow', 'battery', 'tyre', 'fuel', 'lockout'],
        },
        description: { type: 'string', nullable: true },
        lat: { type: 'number', example: 36.7538 },
        lng: { type: 'number', example: 3.0588 },
        pickupAddress: { type: 'string', nullable: true },
        assignedSupplierId: { type: 'string', format: 'uuid', nullable: true },
        status: {
          type: 'string',
          enum: ['requested', 'dispatched', 'en_route', 'completed', 'cancelled'],
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Reservation: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        clientAccountId: { type: 'string', format: 'uuid' },
        supplierId: { type: 'string', format: 'uuid' },
        branchId: { type: 'string', format: 'uuid', nullable: true },
        serviceTypeKey: { type: 'string', example: 'oil_change' },
        vehicleId: { type: 'string', format: 'uuid', nullable: true },
        slotStart: { type: 'string', format: 'date-time' },
        slotEnd: { type: 'string', format: 'date-time' },
        status: {
          type: 'string',
          enum: ['pending', 'accepted', 'rejected', 'rescheduled', 'completed', 'cancelled'],
        },
        note: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Listing: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        sellerAccountId: { type: 'string', format: 'uuid' },
        supplierId: { type: 'string', format: 'uuid', nullable: true },
        title: { type: 'string', example: 'Renault Clio IV 2018' },
        brand: { type: 'string', nullable: true },
        model: { type: 'string', nullable: true },
        year: { type: 'integer', nullable: true },
        mileageKm: { type: 'integer', nullable: true },
        amount: { allOf: [ref('Money')], nullable: true },
        description: { type: 'string', nullable: true },
        photoUrls: { type: 'array', items: { type: 'string' } },
        city: { type: 'string', nullable: true, example: 'Alger' },
        country: { type: 'string', nullable: true, example: 'DZ' },
        status: {
          type: 'string',
          enum: ['draft', 'published', 'pending_review', 'sold', 'withdrawn'],
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    NearbySupplier: {
      type: 'object',
      properties: {
        supplierId: { type: 'string', format: 'uuid' },
        verticalKey: { type: 'string', example: 'parts' },
        name: { type: 'string' },
        categoryKeys: { type: 'array', items: { type: 'string' } },
        distanceM: { type: 'integer', example: 1240 },
      },
    },
    DirectorySupplier: {
      type: 'object',
      properties: {
        supplierId: { type: 'string', format: 'uuid' },
        verticalKey: { type: 'string', example: 'garage' },
        name: { type: 'string', example: 'Garage Central' },
        categoryKeys: { type: 'array', items: { type: 'string' } },
        city: { type: 'string', nullable: true, example: 'Alger' },
        country: { type: 'string', nullable: true, example: 'DZ' },
        rating: { type: 'number', nullable: true, example: 4.6 },
        distanceM: {
          type: 'integer',
          nullable: true,
          description: 'Present only when the query supplied lat/lng.',
        },
      },
    },
    DirectoryPage: {
      type: 'object',
      properties: {
        items: { type: 'array', items: ref('DirectorySupplier') },
        nextCursor: {
          type: 'string',
          nullable: true,
          description: 'Pass back as cursor. Null on the last page.',
        },
      },
    },
    Product: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        supplierId: { type: 'string', format: 'uuid' },
        tecdocArticleId: { type: 'integer', nullable: true },
        name: { type: 'string', example: 'Plaquettes de frein avant' },
        reference: { type: 'string', nullable: true, example: 'BP-1234' },
        categoryKey: { type: 'string', nullable: true },
        amount: { allOf: [ref('Money')], nullable: true },
        quantity: { type: 'integer', example: 12 },
        isDeal: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    ServiceOffer: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        supplierId: { type: 'string', format: 'uuid' },
        serviceTypeKey: { type: 'string', example: 'oil_change' },
        name: { type: 'string', example: 'Vidange + filtre' },
        description: { type: 'string', nullable: true },
        amount: { allOf: [ref('Money')], nullable: true },
        durationMins: { type: 'integer', nullable: true, example: 45 },
        active: { type: 'boolean' },
      },
    },
    ServiceType: {
      type: 'object',
      properties: {
        key: { type: 'string', example: 'oil_change' },
        verticalKey: { type: 'string', example: 'garage' },
        label: {
          type: 'object',
          properties: { en: { type: 'string' }, fr: { type: 'string' }, ar: { type: 'string' } },
        },
      },
    },
    SignedUpload: {
      type: 'object',
      description:
        'PUT the bytes to uploadUrl, then send path back on the resource that uses it. Persist the PATH, never the URL — the URL expires.',
      properties: {
        uploadUrl: { type: 'string', description: 'Pre-signed PUT target. Short-lived.' },
        path: { type: 'string', example: 'ACCOUNT_ID/1739357000_front.jpg' },
        token: {
          type: 'string',
          description: 'The opaque token embedded in uploadUrl, for clients that need it separately.',
        },
        expiresInSeconds: { type: 'integer', example: 3600 },
      },
    },
    RegistrationDraft: {
      type: 'object',
      description:
        'OCR result, NEVER auto-committed — the client confirms it before a vehicle is created.',
      properties: {
        brand: { type: 'string', nullable: true },
        model: { type: 'string', nullable: true },
        year: { type: 'integer', nullable: true },
        vin: { type: 'string', nullable: true },
        plate: { type: 'string', nullable: true },
        confidence: { type: 'number', nullable: true, example: 0.82 },
      },
    },
    Message: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        conversationId: { type: 'string', format: 'uuid' },
        senderAccountId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['text', 'photo', 'voice'] },
        body: { type: 'string', nullable: true, description: 'Text content. Null for photo/voice.' },
        attachmentBucket: { type: 'string', nullable: true, example: 'message-attachments' },
        attachmentPath: { type: 'string', nullable: true },
        durationMs: { type: 'integer', nullable: true, description: 'Voice notes only.' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    MessagePage: {
      type: 'object',
      properties: {
        items: { type: 'array', items: ref('Message') },
        nextCursor: { type: 'string', nullable: true },
      },
    },
    Conversation: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        contextType: {
          type: 'string',
          enum: ['listing', 'request', 'order'],
          nullable: true,
          description: 'What the conversation is about, if anything.',
        },
        contextId: { type: 'string', format: 'uuid', nullable: true },
        subject: { type: 'string', nullable: true },
        participants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              accountId: { type: 'string', format: 'uuid' },
              supplierId: {
                type: 'string',
                format: 'uuid',
                nullable: true,
                description: 'Set when this participant takes part as a business.',
              },
              lastReadAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
        lastMessage: { allOf: [ref('Message')], nullable: true },
        unreadCount: { type: 'integer', example: 3 },
        lastMessageAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Document: {
      type: 'object',
      description:
        'A sealed PDF. The bytes sit in a private bucket exactly as signed; sha256 and the Ed25519 signature are over those bytes.',
      properties: {
        id: { type: 'string', format: 'uuid' },
        type: {
          type: 'string',
          enum: [
            'reservation_confirmation',
            'quotation',
            'purchase_order',
            'invoice',
            'credit_note',
            'receipt',
          ],
        },
        number: {
          type: 'string',
          example: 'FA-2026-000001',
          description: 'Gapless per series and year. This is the reference a human quotes.',
        },
        subjectType: { type: 'string', example: 'order' },
        subjectId: { type: 'string', format: 'uuid' },
        issuedToAccountId: { type: 'string', format: 'uuid', nullable: true },
        supplierId: { type: 'string', format: 'uuid', nullable: true },
        status: { type: 'string', enum: ['issued', 'void'] },
        sha256: { type: 'string', description: 'Hex digest of the stored bytes.' },
        algo: { type: 'string', example: 'ed25519' },
        keyId: { type: 'string', example: 'k1' },
        signatureFormat: { type: 'string', enum: ['detached', 'embedded'] },
        byteSize: { type: 'integer', example: 3001 },
        issuedAt: { type: 'string', format: 'date-time' },
        voidedAt: { type: 'string', format: 'date-time', nullable: true },
        voidReason: { type: 'string', nullable: true },
      },
    },
    VerificationResult: {
      type: 'object',
      description:
        'AUTHENTICITY AND VALIDITY ARE SEPARATE. A voided document is still authentic — we really did issue it — but it is no longer valid. message states both in one sentence.',
      properties: {
        found: { type: 'boolean' },
        authentic: {
          type: 'boolean',
          description: 'The signature over the stored bytes verifies against a published key.',
        },
        matchesSuppliedFile: {
          type: 'boolean',
          description: 'Present only when a file was uploaded: whether its bytes are identical.',
        },
        number: { type: 'string', example: 'FA-2026-000001' },
        type: { type: 'string' },
        status: { type: 'string', enum: ['issued', 'void'] },
        issuedAt: { type: 'string', format: 'date-time' },
        voidedAt: { type: 'string', format: 'date-time', nullable: true },
        voidReason: { type: 'string', nullable: true },
        message: { type: 'string' },
      },
    },
    PublicKeys: {
      type: 'object',
      description:
        'Publishing these is what makes a signature evidence rather than our own assertion. Retired keys stay listed so historical documents keep verifying.',
      properties: {
        algo: { type: 'string', example: 'ed25519' },
        keys: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              keyId: { type: 'string', example: 'k1' },
              publicKey: { type: 'string', description: 'Base64, raw 32-byte Ed25519 public key.' },
              retired: { type: 'boolean' },
            },
          },
        },
      },
    },
    PostMedia: {
      type: 'object',
      description: 'A path in a private bucket, not bytes. Fetch via a signed URL.',
      properties: {
        id: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['photo', 'video'] },
        bucket: { type: 'string', example: 'post-media' },
        path: { type: 'string' },
        durationMs: { type: 'integer', nullable: true, description: 'Video only.' },
        ordinal: {
          type: 'integer',
          description: 'Render order. The gallery sequence is part of the content.',
        },
      },
    },
    Post: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        authorAccountId: {
          type: 'string',
          format: 'uuid',
          description: 'Who actually pressed post. Always set.',
        },
        authorSupplierId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          description:
            'The business they pressed it on behalf of, if any. Render the business badge from this and keep the account for accountability.',
        },
        body: { type: 'string', nullable: true },
        media: { type: 'array', items: ref('PostMedia') },
        likeCount: { type: 'integer' },
        commentCount: { type: 'integer' },
        likedByMe: {
          type: 'boolean',
          description: 'Per-caller — drives the filled heart without a second request.',
        },
        status: { type: 'string', enum: ['published', 'removed'] },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    PostPage: {
      type: 'object',
      properties: {
        items: { type: 'array', items: ref('Post') },
        nextCursor: { type: 'string', nullable: true },
      },
    },
    Comment: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        postId: { type: 'string', format: 'uuid' },
        authorAccountId: { type: 'string', format: 'uuid' },
        authorSupplierId: { type: 'string', format: 'uuid', nullable: true },
        body: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    CommentPage: {
      type: 'object',
      properties: {
        items: { type: 'array', items: ref('Comment') },
        nextCursor: { type: 'string', nullable: true },
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

  set('/v1/auth/session', 'post', {
    tags: ['Auth'],
    summary: 'Exchange a GoTrue token for a JustGo session token',
    description: [
      'Call this straight after sign-in and again after every GoTrue refresh.',
      '',
      'Omit the body (or send `{"scope":"client"}`) for a client session.',
      'The Supplier app sends `{"scope":"supplier"}` — which auto-selects when',
      'the account acts for exactly one supplier — or names one explicitly with',
      '`{"supplierId":"…"}`. Scoping is opt-in: owning a supplier never',
      'silently turns a client session into a supplier one.',
      '',
      'Self-provisioning: a brand-new GoTrue user gets their account row here,',
      'so calling `GET /v1/me` first is not required.',
      '',
      '`expiresIn` is the lesser of `SESSION_TOKEN_TTL_SECONDS` and the',
      'remaining life of the token you exchanged.',
    ].join('\n'),
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['client', 'supplier'] },
              supplierId: { type: 'string', format: 'uuid' },
              branchId: { type: 'string', format: 'uuid' },
            },
          },
          example: { scope: 'supplier' },
        },
      },
    },
    responses: { ...ok(ref('Session')), ...errors() },
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

  set('/v1/orders/{id}/status', 'patch', {
    tags: ['Supplier · Business'],
    summary: 'Advance the order',
    description:
      'Supplier side only, and requires a supplier-scoped token. `confirm` -> `start` -> `complete`, in that order; the state machine returns **409 ILLEGAL_ORDER_TRANSITION** for anything else. **`complete` is what issues the facture** — see Documents. Cancelling has its own endpoint and its own permission.',
    requestBody: body(
      {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['confirm', 'start', 'complete'],
            description: 'confirm → confirmed, start → in_progress, complete → completed.',
          },
        },
      },
      { action: 'complete' },
    ),
    responses: { ...ok(ref('Order')), ...errors() },
  });
  set('/v1/orders/{id}/cancel', 'post', {
    tags: ['Orders'],
    summary: 'Call the sale off',
    description:
      'Either party may cancel — the buyer changed their mind, or the supplier has no stock after all. A supplier-scoped token cancels as the supplier, anyone else as the buyer. **409** once the order is completed or already cancelled.',
    requestBody: body(
      { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } },
      { reason: 'Plus besoin de la pièce' },
    ),
    responses: { ...ok(ref('Order')), ...errors() },
  });
  set('/v1/orders/{id}/purchase-order', 'post', {
    tags: ['Documents'],
    summary: 'Bon de commande for this order',
    description:
      'Takes **no body**: the only input is the order id and the server reads what the document says out of its own tables. A document whose contents the caller could dictate would make the signature worthless. Idempotent — a double tap returns the BC that already exists rather than burning a second number out of the gapless BC series.',
    responses: { ...ok(ref('Document')), ...errors() },
  });
  set('/v1/quotes/{id}/document', 'post', {
    tags: ['Documents'],
    summary: 'Devis for a quote you received',
    description:
      'Takes **no body**, for the same reason as the bon de commande. Issued at most once per quote. 404 if the quote is not on one of your own requests.',
    responses: { ...ok(ref('Document')), ...errors() },
  });

  // ── Social ────────────────────────────────────────────────────────────
  set('/v1/feed', 'get', {
    tags: ['Social'],
    summary: 'The community feed',
    description:
      'Published posts, newest first, keyset-paginated. **There is no follow graph** — this is every post, which is deliberate rather than unfinished: nothing in the app lets a user follow anyone, so a graph nobody could populate would only make the feed empty. Narrow it with `author` (a profile timeline) or `supplier` (a business page).',
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 20 } },
      {
        name: 'cursor',
        in: 'query',
        schema: { type: 'string' },
        description: 'Pass back the `nextCursor` you were given. Null means last page.',
      },
      {
        name: 'author',
        in: 'query',
        schema: { type: 'string', format: 'uuid' },
        description: 'Only this account’s posts.',
      },
      {
        name: 'supplier',
        in: 'query',
        schema: { type: 'string', format: 'uuid' },
        description: 'Only posts made on behalf of this business.',
      },
    ],
    responses: { ...ok(ref('PostPage')), ...errors() },
  });
  set('/v1/posts', 'post', {
    tags: ['Social'],
    summary: 'Publish a post',
    description:
      'Needs text or at least one media item (422 otherwise). Media goes up through `POST /v1/media/uploads` to the **post-media** bucket first — send the returned paths here, in the order they should appear. Bytes never pass through this endpoint, and a path outside your own upload namespace is rejected. `asSupplierId` posts **as a business** and requires a supplier-scoped token for that exact supplier: the badge is what readers trust, so it is not a free-text field.',
    requestBody: body(
      {
        type: 'object',
        properties: {
          body: { type: 'string', maxLength: 5000 },
          media: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              required: ['kind', 'bucket', 'path'],
              properties: {
                kind: { type: 'string', enum: ['photo', 'video'] },
                bucket: { type: 'string', enum: ['post-media'] },
                path: { type: 'string', maxLength: 300 },
                durationMs: { type: 'integer', description: 'Video only.' },
              },
            },
          },
          asSupplierId: { type: 'string', format: 'uuid' },
        },
      },
      {
        body: 'Nouvelle arrivée : plaquettes de frein Bosch',
        media: [{ kind: 'photo', bucket: 'post-media', path: 'ACCOUNT_ID/1739357000_1.jpg' }],
      },
    ),
    responses: { ...ok(ref('Post')), ...errors() },
  });
  set('/v1/posts/{id}', 'get', {
    tags: ['Social'],
    summary: 'Post detail',
    responses: { ...ok(ref('Post')), ...errors() },
  });
  set('/v1/posts/{id}', 'delete', {
    tags: ['Social'],
    summary: 'Retract your own post',
    description:
      'Sets status `removed` rather than deleting: a post somebody has commented on or reported should stop being visible without taking the conversation, or the evidence, with it. **404** if the post is not yours — the endpoint does not confirm it exists.',
    responses: { ...ok(ref('Post')), ...errors() },
  });
  set('/v1/posts/{id}/takedown', 'post', {
    tags: ['Social'],
    summary: 'Administrative takedown',
    description: 'Any post, with a stated reason. Requires `platform.admin`.',
    requestBody: body(
      {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
      { reason: 'Spam' },
    ),
    responses: { ...ok(ref('Post')), ...errors() },
  });
  set('/v1/posts/{id}/like', 'post', {
    tags: ['Social'],
    summary: 'Like a post',
    description:
      'Idempotent — double-tapping is how people use a like button, so a second call leaves one like and one count. Returns the post with the updated `likeCount` and `likedByMe`.',
    responses: { ...ok(ref('Post')), ...errors() },
  });
  set('/v1/posts/{id}/like', 'delete', {
    tags: ['Social'],
    summary: 'Remove your like',
    description: 'Also idempotent: un-liking something you never liked changes nothing.',
    responses: { ...ok(ref('Post')), ...errors() },
  });
  set('/v1/posts/{id}/comments', 'get', {
    tags: ['Social'],
    summary: 'Comments, oldest first',
    description: 'A thread is read in the order it was said, so this pages forwards.',
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 50 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
    ],
    responses: { ...ok(ref('CommentPage')), ...errors() },
  });
  set('/v1/posts/{id}/comments', 'post', {
    tags: ['Social'],
    summary: 'Comment on a post',
    requestBody: body(
      {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', minLength: 1, maxLength: 2000 },
          asSupplierId: {
            type: 'string',
            format: 'uuid',
            description: 'Comment as a business. Same scope requirement as posting.',
          },
        },
      },
      { body: 'Toujours disponible ?' },
    ),
    responses: {
      '201': { description: 'Created', content: { 'application/json': { schema: ref('Comment') } } },
      ...errors(),
    },
  });

  // ── Client · Garage ────────────────────────────────────────────────────
  const vehicleBody = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 120, example: 'Ma Clio' },
      brand: { type: 'string', maxLength: 80, example: 'Renault' },
      model: { type: 'string', maxLength: 80, example: 'Clio IV' },
      year: { type: 'integer', minimum: 1900, maximum: 2100, example: 2018 },
      vin: { type: 'string', maxLength: 32 },
      plate: { type: 'string', maxLength: 16, example: '00123-116-16' },
      mileageKm: { type: 'integer', minimum: 0, example: 84000 },
      photoUrl: { type: 'string', format: 'uri' },
      resolveTecDoc: {
        type: 'boolean',
        description: 'Try to match the vehicle against TecDoc on creation.',
      },
    },
  };
  set('/v1/vehicles', 'get', {
    tags: ['Client · Garage'],
    summary: 'The caller’s vehicles',
    responses: { ...ok(listOf('Vehicle')), ...errors() },
  });
  set('/v1/vehicles', 'post', {
    tags: ['Client · Garage'],
    summary: 'Add a vehicle',
    requestBody: body(vehicleBody, { brand: 'Renault', model: 'Clio IV', year: 2018, mileageKm: 84000 }),
    responses: { ...ok(ref('Vehicle')), ...errors() },
  });
  set('/v1/vehicles/{id}', 'get', {
    tags: ['Client · Garage'],
    summary: 'Vehicle detail',
    responses: { ...ok(ref('Vehicle')), ...errors() },
  });
  set('/v1/vehicles/{id}', 'patch', {
    tags: ['Client · Garage'],
    summary: 'Rename / re-plate / set health',
    requestBody: body({
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 120 },
        plate: { type: 'string', maxLength: 16 },
        photoUrl: { type: 'string', format: 'uri' },
        healthStatus: {
          type: 'string',
          enum: ['optimal', 'good', 'warning', 'critical', 'urgent'],
        },
      },
    }),
    responses: { ...ok(ref('Vehicle')), ...errors() },
  });
  set('/v1/vehicles/{id}', 'delete', {
    tags: ['Client · Garage'],
    summary: 'Remove a vehicle',
    responses: { '204': { description: 'Removed' }, ...errors() },
  });
  set('/v1/vehicles/{id}/mileage', 'patch', {
    tags: ['Client · Garage'],
    summary: 'Record the odometer',
    description: 'Advancing mileage is what makes interval-based maintenance tasks fall due.',
    requestBody: body(
      {
        type: 'object',
        required: ['mileageKm'],
        properties: { mileageKm: { type: 'integer', minimum: 0, example: 86500 } },
      },
      { mileageKm: 86500 },
    ),
    responses: { ...ok(ref('Vehicle')), ...errors() },
  });
  set('/v1/vehicles/{id}/health', 'get', {
    tags: ['Client · Garage'],
    summary: 'Health history',
    responses: { ...ok(listOf('HealthEntry')), ...errors() },
  });
  set('/v1/vehicles/{id}/maintenance', 'get', {
    tags: ['Client · Garage'],
    summary: 'Maintenance tasks',
    responses: { ...ok(listOf('MaintenanceTask')), ...errors() },
  });
  set('/v1/vehicles/{id}/maintenance', 'post', {
    tags: ['Client · Garage'],
    summary: 'Add a maintenance task',
    description:
      'Give an interval (km or months) for a recurring task, or a fixed due point. At least one is needed for the task to ever fall due.',
    requestBody: body(
      {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200, example: 'Vidange' },
          intervalKm: { type: 'integer', minimum: 1, example: 10000 },
          intervalMonths: { type: 'integer', minimum: 1, example: 12 },
          dueAtKm: { type: 'integer', minimum: 1 },
          dueDate: { type: 'string', format: 'date' },
        },
      },
      { title: 'Vidange', intervalKm: 10000 },
    ),
    responses: { ...ok(ref('MaintenanceTask')), ...errors() },
  });

  // ── Media ─────────────────────────────────────────────────────────────
  set('/v1/media/uploads', 'post', {
    tags: ['Media'],
    summary: 'Pre-signed upload URL',
    description:
      'Bytes never pass through this API. Ask for a URL, PUT the file straight to storage, then send the returned `path` on whatever resource uses it. The server namespaces every object under the caller’s account, so paths cannot collide or leak.',
    requestBody: body(
      {
        type: 'object',
        required: ['bucket', 'filename'],
        properties: {
          bucket: {
            type: 'string',
            enum: [
              'registrations',
              'vehicle-photos',
              'part-photos',
              'avatars',
              'message-attachments',
            ],
          },
          filename: { type: 'string', minLength: 1, maxLength: 200, example: 'front.jpg' },
          contentType: { type: 'string', maxLength: 100, example: 'image/jpeg' },
        },
      },
      { bucket: 'vehicle-photos', filename: 'front.jpg', contentType: 'image/jpeg' },
    ),
    responses: { ...ok(ref('SignedUpload')), ...errors() },
  });
  set('/v1/vehicles/scan', 'post', {
    tags: ['Media'],
    summary: 'OCR a carte grise',
    description:
      'Upload the photo first via /v1/media/uploads to the `registrations` bucket, then pass its path here. Returns a DRAFT only — the client confirms the fields before any vehicle is created.',
    requestBody: body(
      {
        type: 'object',
        required: ['path'],
        properties: {
          bucket: { type: 'string', enum: ['registrations'], default: 'registrations' },
          path: {
            type: 'string',
            maxLength: 300,
            description: 'Must sit under the caller’s own upload namespace.',
          },
        },
      },
      { bucket: 'registrations', path: 'ACCOUNT_ID/1739357000_carte-grise.jpg' },
    ),
    responses: {
      '200': {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { draft: ref('RegistrationDraft') } },
          },
        },
      },
      ...errors(),
    },
  });

  // ── Client · Discovery ────────────────────────────────────────────────
  set('/v1/discovery/suppliers', 'get', {
    tags: ['Client · Discovery'],
    summary: 'Nearby suppliers',
    description: 'Demands a location. For browsing without one, use /v1/discovery/directory.',
    security: [],
    parameters: [
      { name: 'lat', in: 'query', required: true, schema: { type: 'number' }, example: 36.7538 },
      { name: 'lng', in: 'query', required: true, schema: { type: 'number' }, example: 3.0588 },
      { name: 'radiusM', in: 'query', schema: { type: 'integer', default: 15000 } },
      { name: 'vertical', in: 'query', schema: { type: 'string' }, example: 'parts' },
      { name: 'category', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
    ],
    responses: { ...ok(listOf('NearbySupplier')), ...errors() },
  });
  set('/v1/discovery/directory', 'get', {
    tags: ['Client · Discovery'],
    summary: 'Services Directory',
    description:
      'Every field is optional, INCLUDING location — that is what separates it from nearby search, which demands a lat/lng the user may never have granted. Fuzzy name search via `q`; keyset pagination via `cursor`.',
    security: [],
    parameters: [
      { name: 'q', in: 'query', schema: { type: 'string', maxLength: 120 }, example: 'garage' },
      { name: 'vertical', in: 'query', schema: { type: 'string' }, example: 'garage' },
      { name: 'category', in: 'query', schema: { type: 'string' } },
      { name: 'city', in: 'query', schema: { type: 'string' }, example: 'Alger' },
      {
        name: 'lat',
        in: 'query',
        schema: { type: 'number' },
        description: 'With lng, adds distanceM and orders by proximity.',
      },
      { name: 'lng', in: 'query', schema: { type: 'number' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
    ],
    responses: { ...ok(ref('DirectoryPage')), ...errors() },
  });
  set('/v1/discovery/suppliers/{id}', 'get', {
    tags: ['Client · Discovery'],
    summary: 'Public supplier profile',
    security: [],
    responses: { ...ok(ref('DirectorySupplier')), ...errors() },
  });
  set('/v1/catalogue/service-types', 'get', {
    tags: ['Catalogue'],
    summary: 'Service types',
    security: [],
    parameters: [
      { name: 'vertical', in: 'query', schema: { type: 'string' }, example: 'garage' },
    ],
    responses: { ...ok(listOf('ServiceType')), ...errors() },
  });

  // ── Client · Marketplace ──────────────────────────────────────────────
  set('/v1/marketplace/listings', 'get', {
    tags: ['Client · Marketplace'],
    summary: 'Browse listings',
    parameters: [
      { name: 'brand', in: 'query', schema: { type: 'string' } },
      { name: 'maxAmountMinor', in: 'query', schema: { type: 'integer' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
    ],
    responses: { ...ok(listOf('Listing')), ...errors() },
  });
  set('/v1/marketplace/listings', 'post', {
    tags: ['Client · Marketplace'],
    summary: 'Publish a listing',
    description: 'Photos go up through /v1/media/uploads first; send the resulting URLs here.',
    requestBody: body(
      {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          brand: { type: 'string', maxLength: 80 },
          model: { type: 'string', maxLength: 80 },
          year: { type: 'integer', minimum: 1900, maximum: 2100 },
          mileageKm: { type: 'integer', minimum: 0 },
          amount: ref('Money'),
          description: { type: 'string', maxLength: 5000 },
          photoUrls: { type: 'array', maxItems: 20, items: { type: 'string', format: 'uri' } },
          city: { type: 'string', maxLength: 120 },
          country: { type: 'string', minLength: 2, maxLength: 2, example: 'DZ' },
          lat: { type: 'number' },
          lng: { type: 'number' },
        },
      },
      {
        title: 'Renault Clio IV 2018',
        brand: 'Renault',
        year: 2018,
        mileageKm: 84000,
        amount: { amountMinor: 185000000, currency: 'DZD' },
        city: 'Alger',
        country: 'DZ',
      },
    ),
    responses: { ...ok(ref('Listing')), ...errors() },
  });
  set('/v1/marketplace/listings/{id}', 'get', {
    tags: ['Client · Marketplace'],
    summary: 'Listing detail',
    responses: { ...ok(ref('Listing')), ...errors() },
  });
  set('/v1/marketplace/listings/{id}/contact', 'post', {
    tags: ['Client · Marketplace'],
    summary: 'Contact the seller',
    description: 'Opens (or reuses) a conversation about this listing — see /v1/conversations.',
    requestBody: body(
      { type: 'object', properties: { message: { type: 'string', maxLength: 1000 } } },
      { message: 'Bonjour, la voiture est toujours disponible ?' },
    ),
    responses: { ...ok(ref('Conversation')), ...errors() },
  });

  // ── Messaging ─────────────────────────────────────────────────────────
  set('/v1/conversations', 'get', {
    tags: ['Messaging'],
    summary: 'Conversations, most recent first',
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
    responses: { ...ok(listOf('Conversation')), ...errors() },
  });
  set('/v1/conversations', 'post', {
    tags: ['Messaging'],
    summary: 'Start a conversation',
    description:
      'Idempotent per (participants, context): asking twice about the same listing returns the conversation that already exists rather than a second one. Pass `asSupplierId` to take part as a business.',
    requestBody: body(
      {
        type: 'object',
        required: ['withAccountId'],
        properties: {
          withAccountId: { type: 'string', format: 'uuid' },
          contextType: { type: 'string', enum: ['listing', 'request', 'order'] },
          contextId: { type: 'string', format: 'uuid' },
          subject: { type: 'string', maxLength: 200 },
          asSupplierId: {
            type: 'string',
            format: 'uuid',
            description: 'Requires the caller to hold that supplier’s scope.',
          },
        },
      },
      { withAccountId: '…', contextType: 'listing', contextId: '…' },
    ),
    responses: { ...ok(ref('Conversation')), ...errors() },
  });
  set('/v1/conversations/{id}', 'get', {
    tags: ['Messaging'],
    summary: 'Conversation detail',
    responses: { ...ok(ref('Conversation')), ...errors() },
  });
  set('/v1/conversations/{id}/messages', 'get', {
    tags: ['Messaging'],
    summary: 'Messages, newest first',
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
    ],
    responses: { ...ok(ref('MessagePage')), ...errors() },
  });
  set('/v1/conversations/{id}/messages', 'post', {
    tags: ['Messaging'],
    summary: 'Send a message',
    description:
      'A text message needs `body`. A photo or voice note needs `attachmentBucket` + `attachmentPath` from /v1/media/uploads — upload first, then send the path. Voice notes should carry `durationMs` so the client can draw the waveform without fetching the audio.',
    requestBody: body(
      {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['text', 'photo', 'voice'], default: 'text' },
          body: { type: 'string', maxLength: 4000 },
          attachmentBucket: { type: 'string', example: 'message-attachments' },
          attachmentPath: { type: 'string', maxLength: 300 },
          durationMs: { type: 'integer', maximum: 600000 },
        },
      },
      { kind: 'text', body: 'Bonjour, je passe demain matin.' },
    ),
    responses: { ...ok(ref('Message')), ...errors() },
  });
  set('/v1/conversations/{id}/read', 'post', {
    tags: ['Messaging'],
    summary: 'Mark as read',
    description: 'Moves the caller’s read marker to now, which is what clears `unreadCount`.',
    responses: { '204': { description: 'Marked' }, ...errors() },
  });

  // ── Documents ─────────────────────────────────────────────────────────
  set('/v1/documents', 'get', {
    tags: ['Documents'],
    summary: 'Documents issued to the caller',
    description:
      'There is deliberately no endpoint that CREATES a document from a request body. Documents are issued by the server from events it already trusts, because a signature over client-supplied content would certify nothing.',
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
    responses: { ...ok(listOf('Document')), ...errors() },
  });
  set('/v1/documents/{id}/download', 'get', {
    tags: ['Documents'],
    summary: 'Short-lived download URL',
    description: 'The bucket is private — there is no permanent public link to a document.',
    responses: {
      '200': {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { url: { type: 'string' } } },
          },
        },
      },
      ...errors(),
    },
  });
  set('/v1/documents/keys', 'get', {
    tags: ['Documents'],
    summary: 'Public signing keys',
    description:
      'So a third party can verify a document offline. Without this, "authentic" only means "our API said so", which proves nothing to someone who does not trust us.',
    security: [],
    responses: { ...ok(ref('PublicKeys')), ...errors() },
  });
  set('/v1/documents/verify/{number}', 'get', {
    tags: ['Documents'],
    summary: 'Verify by number',
    description:
      'Open to the world — this is the QR target printed on every document. Returns status and authenticity only: no amounts and no parties, because document numbers are guessable.',
    security: [],
    responses: { ...ok(ref('VerificationResult')), ...errors() },
  });
  set('/v1/documents/verify/{number}', 'post', {
    tags: ['Documents'],
    summary: 'Verify a file you hold',
    description:
      'The stronger check: send the bytes YOU have and we compare them against what we sealed. Proves your copy is the real one instead of asking you to trust our screen.',
    security: [],
    requestBody: body({
      type: 'object',
      properties: {
        file: { type: 'string', format: 'byte', description: 'Base64 of the PDF you hold.' },
      },
    }),
    responses: { ...ok(ref('VerificationResult')), ...errors() },
  });
  set('/v1/documents/{id}/void', 'post', {
    tags: ['Documents'],
    summary: 'Annul a document (admin)',
    description:
      'NOT a delete. The stored bytes stay exactly as issued, so a voided document stays provably authentic while ceasing to be valid, and the verifier says so. Purely administrative — no accounting entry is produced.',
    requestBody: body(
      {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
      { reason: 'Issued against the wrong order' },
    ),
    responses: { ...ok(ref('Document')), ...errors() },
  });

  // ── Client · Fulfilment ───────────────────────────────────────────────
  set('/v1/reservations', 'get', {
    tags: ['Client · Fulfilment'],
    summary: 'The caller’s reservations',
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
    responses: { ...ok(listOf('Reservation')), ...errors() },
  });
  set('/v1/reservations', 'post', {
    tags: ['Client · Fulfilment'],
    summary: 'Book a slot',
    requestBody: body(
      {
        type: 'object',
        required: ['supplierId', 'serviceTypeKey', 'slotStart', 'slotEnd'],
        properties: {
          supplierId: { type: 'string', format: 'uuid' },
          branchId: { type: 'string', format: 'uuid' },
          serviceTypeKey: { type: 'string', maxLength: 64, example: 'oil_change' },
          vehicleId: { type: 'string', format: 'uuid' },
          slotStart: { type: 'string', format: 'date-time' },
          slotEnd: { type: 'string', format: 'date-time' },
          note: { type: 'string', maxLength: 500 },
        },
      },
      {
        supplierId: '…',
        serviceTypeKey: 'oil_change',
        slotStart: '2026-10-20T09:00:00Z',
        slotEnd: '2026-10-20T10:00:00Z',
      },
    ),
    responses: { ...ok(ref('Reservation')), ...errors() },
  });
  set('/v1/reservations/{id}', 'delete', {
    tags: ['Client · Fulfilment'],
    summary: 'Cancel a reservation',
    responses: { ...ok(ref('Reservation')), ...errors() },
  });
  set('/v1/assistance', 'get', {
    tags: ['Client · Fulfilment'],
    summary: 'The caller’s assistance requests',
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
    responses: { ...ok(listOf('AssistanceRequest')), ...errors() },
  });
  set('/v1/assistance', 'post', {
    tags: ['Client · Fulfilment'],
    summary: 'Call for roadside assistance',
    requestBody: body(
      {
        type: 'object',
        required: ['serviceType', 'lat', 'lng'],
        properties: {
          serviceType: {
            type: 'string',
            enum: ['breakdown', 'tow', 'battery', 'tyre', 'fuel', 'lockout'],
          },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          vehicleId: { type: 'string', format: 'uuid' },
          description: { type: 'string', maxLength: 1000 },
          pickupAddress: { type: 'string', maxLength: 300 },
        },
      },
      { serviceType: 'tow', lat: 36.7538, lng: 3.0588, description: 'Ne démarre plus' },
    ),
    responses: { ...ok(ref('AssistanceRequest')), ...errors() },
  });
  set('/v1/assistance/{id}', 'delete', {
    tags: ['Client · Fulfilment'],
    summary: 'Cancel an assistance request',
    responses: { ...ok(ref('AssistanceRequest')), ...errors() },
  });

  // ── Supplier · Business ───────────────────────────────────────────────
  set('/v1/supplier/fiscal', 'patch', {
    tags: ['Supplier · Business'],
    summary: 'Fiscal identity',
    description:
      'REQUIRED BEFORE ANY INVOICE CAN BE ISSUED. Algerian law makes NIF, NIS, RC and the article d’imposition mandatory mentions on a facture, so until all four are present the invoice reactor refuses to issue rather than produce a document that only looks official. Fields are merged — send one at a time if you like.',
    requestBody: body(
      {
        type: 'object',
        properties: {
          legalName: { type: 'string', maxLength: 200, example: 'SARL PIECES AUTO ALGER' },
          address: { type: 'string', maxLength: 300 },
          nif: { type: 'string', maxLength: 40, example: '000216001234567' },
          nis: { type: 'string', maxLength: 40 },
          rc: { type: 'string', maxLength: 40, example: '16/00-1234567B16' },
          taxArticle: { type: 'string', maxLength: 40 },
        },
      },
      {
        legalName: 'SARL PIECES AUTO ALGER',
        nif: '000216001234567',
        nis: '000216001234567',
        rc: '16/00-1234567B16',
        taxArticle: '16000123456',
      },
    ),
    responses: { ...ok(ref('Supplier')), ...errors() },
  });
  set('/v1/supplier/products', 'get', {
    tags: ['Supplier · Business'],
    summary: 'Products',
    responses: { ...ok(listOf('Product')), ...errors() },
  });
  set('/v1/supplier/products', 'post', {
    tags: ['Supplier · Business'],
    summary: 'Add a product',
    requestBody: body(
      {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          tecdocArticleId: { type: 'integer' },
          reference: { type: 'string', maxLength: 120 },
          categoryKey: { type: 'string', maxLength: 64 },
          amount: ref('Money'),
          quantity: { type: 'integer', minimum: 0 },
          isDeal: { type: 'boolean', description: 'Surfaces it under /v1/supplier/deals.' },
        },
      },
      {
        name: 'Plaquettes de frein avant',
        reference: 'BP-1234',
        amount: { amountMinor: 450000, currency: 'DZD' },
        quantity: 12,
      },
    ),
    responses: { ...ok(ref('Product')), ...errors() },
  });
  set('/v1/supplier/products/{id}', 'patch', {
    tags: ['Supplier · Business'],
    summary: 'Update a product',
    requestBody: body({
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200 },
        reference: { type: 'string', maxLength: 120 },
        categoryKey: { type: 'string', maxLength: 64 },
        amount: ref('Money'),
        quantity: { type: 'integer', minimum: 0 },
        isDeal: { type: 'boolean' },
      },
    }),
    responses: { ...ok(ref('Product')), ...errors() },
  });
  set('/v1/supplier/products/{id}', 'delete', {
    tags: ['Supplier · Business'],
    summary: 'Delete a product',
    responses: { '204': { description: 'Deleted' }, ...errors() },
  });
  set('/v1/supplier/deals', 'get', {
    tags: ['Supplier · Business'],
    summary: 'Products flagged as deals',
    responses: { ...ok(listOf('Product')), ...errors() },
  });
  set('/v1/supplier/offers', 'get', {
    tags: ['Supplier · Business'],
    summary: 'Service offers',
    responses: { ...ok(listOf('ServiceOffer')), ...errors() },
  });
  set('/v1/supplier/offers', 'post', {
    tags: ['Supplier · Business'],
    summary: 'Add a service offer',
    requestBody: body(
      {
        type: 'object',
        required: ['serviceTypeKey', 'name'],
        properties: {
          serviceTypeKey: { type: 'string', maxLength: 64, example: 'oil_change' },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          amount: ref('Money'),
          durationMins: { type: 'integer', minimum: 1 },
        },
      },
      {
        serviceTypeKey: 'oil_change',
        name: 'Vidange + filtre',
        amount: { amountMinor: 350000, currency: 'DZD' },
        durationMins: 45,
      },
    ),
    responses: { ...ok(ref('ServiceOffer')), ...errors() },
  });
  set('/v1/supplier/offers/{id}', 'delete', {
    tags: ['Supplier · Business'],
    summary: 'Delete a service offer',
    responses: { '204': { description: 'Deleted' }, ...errors() },
  });

  // ── Supplier · Calendar & dispatch ────────────────────────────────────
  set('/v1/supplier/reservations', 'get', {
    tags: ['Supplier · Calendar'],
    summary: 'The supplier’s calendar',
    parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
    responses: { ...ok(listOf('Reservation')), ...errors() },
  });
  set('/v1/supplier/reservations/{id}', 'patch', {
    tags: ['Supplier · Calendar'],
    summary: 'Accept / reject / reschedule / complete',
    description: 'A reschedule must carry both slotStart and slotEnd.',
    requestBody: body(
      {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['accept', 'reject', 'reschedule', 'complete'] },
          reason: { type: 'string', maxLength: 500 },
          slotStart: { type: 'string', format: 'date-time' },
          slotEnd: { type: 'string', format: 'date-time' },
        },
      },
      { action: 'accept' },
    ),
    responses: { ...ok(ref('Reservation')), ...errors() },
  });
  set('/v1/supplier/assistance/{id}', 'patch', {
    tags: ['Supplier · Calendar'],
    summary: 'Claim and advance a roadside job',
    description: 'Requires a supplier-scoped token.',
    requestBody: body(
      {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', enum: ['accept', 'en_route', 'complete'] } },
      },
      { action: 'accept' },
    ),
    responses: { ...ok(ref('AssistanceRequest')), ...errors() },
  });

  set('/v1/health', 'get', {
    tags: ['Health'],
    summary: 'Liveness probe',
    security: [],
    responses: { '200': { description: 'OK' } },
  });
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
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
    .addTag('Client · Garage')
    .addTag('Client · Discovery')
    .addTag('Client · Marketplace')
    .addTag('Client · Fulfilment')
    .addTag('Supplier · Calendar')
    .addTag('Social')
    .addTag('Messaging')
    .addTag('Documents')
    .addTag('Media')
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

  return document;
}
