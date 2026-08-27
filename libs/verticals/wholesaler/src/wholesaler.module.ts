import { Module } from '@nestjs/common';
import { WholesalerVertical } from './wholesaler.vertical';

/** The vertical's own Nest module; registered via the app's manifest (§9). */
@Module({
  providers: [WholesalerVertical],
  exports: [WholesalerVertical],
})
export class WholesalerModule {}
