import { Module } from '@nestjs/common';
import { BodyPaintVertical } from './body-paint.vertical';

/** The vertical's own Nest module; registered via the app manifest (§9). */
@Module({ providers: [BodyPaintVertical], exports: [BodyPaintVertical] })
export class BodyPaintModule {}
