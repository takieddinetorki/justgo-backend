import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const controller = moduleRef.get(HealthController);
    const res = controller.health();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('justgo-api');
    expect(new Date(res.now).getTime()).not.toBeNaN();
  });
});
