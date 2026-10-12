import { Module, type DynamicModule } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { DOCUMENTS_PORT } from './contract/documents.port';
import { DOCUMENT_SIGNER } from './contract/signer.port';
import {
  DocumentsService,
  DOCUMENTS_CONFIG,
  DOCUMENTS_REPOSITORY,
  type DocumentsConfig,
} from './application/documents.service';
import { Ed25519DocumentSigner } from './infra/ed25519-signer';
import { PgDocumentsRepository } from './infra/pg-documents.repository';
import { DocumentsController } from './documents.controller';
import { ReservationDocumentReactor } from './application/reservation-document.reactor';

export interface DocumentsModuleOptions {
  /** PKCS#8 PEM. Omit ONLY in dev — see the warning in the factory. */
  signingKeyPem?: string;
  /** Path to a PEM file. Preferred over the inline value; see the factory. */
  signingKeyPath?: string;
  signingKeyId?: string;
  retiredPublicKeys?: Array<{ keyId: string; publicKeyPem: string }>;
  bucket?: string;
  verifyBaseUrl?: string;
}

/**
 * Owns the `documents` schema: issuance, sealing, verification, voiding.
 *
 * The signer is a PORT (see signer.port.ts). Ed25519 today; a qualified
 * AECE seal later becomes a second adapter and a config change, with no
 * migration of anything already issued.
 */
@Module({})
export class DocumentsModule {
  static forRoot(options: DocumentsModuleOptions = {}): DynamicModule {
    return {
      module: DocumentsModule,
      /*
        MEDIA_PORT injects because MediaModule.forRoot is `global: true`
        (made so for this). Documents writes and re-reads sealed bytes
        through it rather than owning a second storage client.
      */
      controllers: [DocumentsController],
      providers: [
        {
          provide: DOCUMENTS_REPOSITORY,
          useFactory: () => {
            const url = process.env['DATABASE_URL'];
            if (!url) throw new Error('DATABASE_URL is required for the documents module');
            return new PgDocumentsRepository(new Pool({ connectionString: url, max: 5 }));
          },
        },
        {
          provide: DOCUMENT_SIGNER,
          useFactory: () => {
            /*
              A FILE is the primary source, not an env var.

              A PEM is multi-line and an env file cannot carry that —
              Docker's `env_file` rejects the continuation lines outright.
              Escaping the newlines does work, but it puts the private key
              into `docker inspect`, process listings and any log that
              dumps the environment. A mounted file keeps it out of all of
              them, which is how container secrets are meant to arrive.

              The escaped inline form stays as a fallback for platforms
              that only offer environment variables.
            */
            const keyPath = options.signingKeyPath ?? process.env['DOCUMENT_SIGNING_KEY_FILE'];
            const inline = options.signingKeyPem ?? process.env['DOCUMENT_SIGNING_KEY'];
            const pem = keyPath
              ? readFileSync(keyPath, 'utf8').trim()
              : inline
                ? inline.split(String.raw`\n`).join('\n').trim()
                : undefined;
            const keyId = options.signingKeyId ?? process.env['DOCUMENT_SIGNING_KEY_ID'] ?? 'dev';

            if (pem) {
              return new Ed25519DocumentSigner({
                privateKeyPem: pem,
                keyId,
                retiredPublicKeys: options.retiredPublicKeys,
              });
            }

            /*
              EPHEMERAL DEV KEY. Generated per process, so every restart
              invalidates every document signed by the previous one.
              That is deliberate: a hardcoded fallback key would look like
              it worked and would make the signatures worthless, which is
              a far worse failure than documents that stop verifying
              loudly after a restart.

              Set DOCUMENT_SIGNING_KEY for anything that must survive.
            */
            const { privateKey } = generateKeyPairSync('ed25519');
            console.warn(
              '[documents] No DOCUMENT_SIGNING_KEY_FILE or DOCUMENT_SIGNING_KEY set — using an EPHEMERAL key. ' +
                'Documents sealed now will NOT verify after a restart.',
            );
            return new Ed25519DocumentSigner({
              privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
              keyId: `ephemeral-${Date.now()}`,
            });
          },
        },
        {
          provide: DOCUMENTS_CONFIG,
          useValue: {
            bucket: options.bucket ?? process.env['DOCUMENTS_BUCKET'] ?? 'documents',
            verifyBaseUrl:
              options.verifyBaseUrl ??
              process.env['DOCUMENTS_VERIFY_URL'] ??
              'http://localhost:3100/v1/documents/verify',
          } satisfies DocumentsConfig,
        },
        { provide: DOCUMENTS_PORT, useClass: DocumentsService },
        DocumentsService,
        ReservationDocumentReactor,
      ],
      exports: [DOCUMENTS_PORT, DOCUMENT_SIGNER],
    };
  }
}
