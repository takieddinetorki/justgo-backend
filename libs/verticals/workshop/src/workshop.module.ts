import { Module } from '@nestjs/common';
import { WorkshopVertical } from './workshop.vertical';

/** The vertical's own Nest module; registered via the app manifest (§9). */
@Module({ providers: [WorkshopVertical], exports: [WorkshopVertical] })
export class WorkshopModule {}
