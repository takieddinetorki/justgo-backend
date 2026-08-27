import { Module, type DynamicModule, Logger } from '@nestjs/common';
import { MEDIA_PORT } from './contract/media.port';
import { OCR_PROVIDER } from './contract/ocr.port';
import { SupabaseStorageAdapter, SupabaseStorageHttp } from './infra/supabase-storage.adapter';
import { StubStorageAdapter } from './infra/stub-storage.adapter';
import { StubOcrProvider } from './infra/stub-ocr.provider';
import { MediaController } from './media.controller';

export interface MediaModuleOptions {
  supabaseUrl?: string;
  serviceKey?: string;
}

/**
 * Media + OCR (§14). Uses the real Supabase Storage adapter when configured,
 * else a local stub (dev/CI). OCR is the deterministic stub for now, behind
 * OCR_PROVIDER for a later cloud/self-hosted swap.
 */
@Module({})
export class MediaModule {
  static forRoot(options: MediaModuleOptions = {}): DynamicModule {
    const supabaseUrl = options.supabaseUrl ?? process.env['SUPABASE_URL'];
    const serviceKey = options.serviceKey ?? process.env['SUPABASE_SERVICE_KEY'];
    return {
      module: MediaModule,
      controllers: [MediaController],
      providers: [
        {
          provide: MEDIA_PORT,
          useFactory: () => {
            const logger = new Logger(MediaModule.name);
            if (supabaseUrl && serviceKey) {
              logger.log('Media: Supabase Storage adapter');
              return new SupabaseStorageAdapter(
                new SupabaseStorageHttp({ supabaseUrl, serviceKey }),
                supabaseUrl,
              );
            }
            logger.log('Media: stub storage adapter (no Supabase configured)');
            return new StubStorageAdapter();
          },
        },
        { provide: OCR_PROVIDER, useClass: StubOcrProvider },
      ],
      exports: [MEDIA_PORT, OCR_PROVIDER],
    };
  }
}
