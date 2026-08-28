import { Module } from '@nestjs/common';
import { RoadsideVertical } from './roadside.vertical';

@Module({ providers: [RoadsideVertical], exports: [RoadsideVertical] })
export class RoadsideModule {}
