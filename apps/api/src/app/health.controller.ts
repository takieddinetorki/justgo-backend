import { Controller, Get } from '@nestjs/common';
import { Public } from '@justgo/auth';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health(): { status: 'ok'; service: string; now: string } {
    return { status: 'ok', service: 'justgo-api', now: new Date().toISOString() };
  }
}
