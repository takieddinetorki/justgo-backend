import { Module } from '@nestjs/common';
import { InsuranceVertical } from './insurance.vertical';

@Module({ providers: [InsuranceVertical], exports: [InsuranceVertical] })
export class InsuranceModule {}
