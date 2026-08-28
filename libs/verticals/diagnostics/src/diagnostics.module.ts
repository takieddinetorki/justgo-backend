import { Module } from '@nestjs/common';
import { DiagnosticsVertical } from './diagnostics.vertical';

/** The vertical's own Nest module; registered via the app manifest (§9). */
@Module({ providers: [DiagnosticsVertical], exports: [DiagnosticsVertical] })
export class DiagnosticsModule {}
