import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { SOCIAL_PORT } from './contract/social.port';
import { SocialService, SOCIAL_REPOSITORY } from './application/social.service';
import { PgSocialRepository } from './infra/pg-social.repository';
import { SocialController } from './social.controller';

/** Owns the `social` schema. Extract-ready: it keeps its own Pool (§4.8). */
@Module({
  controllers: [SocialController],
  providers: [
    {
      provide: SOCIAL_REPOSITORY,
      useFactory: () => {
        const url = process.env['DATABASE_URL'];
        if (!url) throw new Error('DATABASE_URL is required for the social module');
        return new PgSocialRepository(new Pool({ connectionString: url, max: 5 }));
      },
    },
    { provide: SOCIAL_PORT, useClass: SocialService },
    SocialService,
  ],
  exports: [SOCIAL_PORT],
})
export class SocialModule {}
