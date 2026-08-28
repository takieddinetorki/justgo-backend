import { Module } from '@nestjs/common';
import { ShowroomVertical } from './showroom.vertical';

@Module({ providers: [ShowroomVertical], exports: [ShowroomVertical] })
export class ShowroomModule {}
