import { addMoney, compareMoney, money, multiplyMoney } from './money';
import { err, isErr, isOk, ok, unwrap } from './result';
import { asId, isUuid, newId } from './ids';
import { FixedClock } from './clock';
import { ConflictError, NotFoundError, ValidationError } from './errors';

describe('money', () => {
  it('creates and adds integer minor units', () => {
    const a = money(1050, 'EUR');
    const b = money(950, 'EUR');
    expect(addMoney(a, b)).toEqual({ amountMinor: 2000, currency: 'EUR' });
    expect(multiplyMoney(a, 3).amountMinor).toBe(3150);
    expect(compareMoney(a, b)).toBeGreaterThan(0);
  });

  it('rejects floats and bad currencies', () => {
    expect(() => money(10.5, 'EUR')).toThrow(TypeError);
    expect(() => money(100, 'eur')).toThrow(TypeError);
    expect(() => money(100, 'EURO')).toThrow(TypeError);
  });

  it('rejects cross-currency arithmetic', () => {
    expect(() => addMoney(money(1, 'EUR'), money(1, 'USD'))).toThrow(TypeError);
  });
});

describe('result', () => {
  it('discriminates ok/err', () => {
    const good = ok(42);
    const bad = err(new Error('nope'));
    expect(isOk(good) && good.value).toBe(42);
    expect(isErr(bad)).toBe(true);
    expect(unwrap(good)).toBe(42);
    expect(() => unwrap(bad)).toThrow('nope');
  });
});

describe('ids', () => {
  it('generates and validates UUIDs', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(asId(id)).toBe(id);
    expect(() => asId('not-a-uuid')).toThrow(TypeError);
  });
});

describe('clock', () => {
  it('is controllable in tests', () => {
    const clock = new FixedClock(new Date('2026-07-20T00:00:00Z'));
    clock.advanceMs(60_000);
    expect(clock.now().toISOString()).toBe('2026-07-20T00:01:00.000Z');
  });
});

describe('errors', () => {
  it('maps to the API envelope with stable codes', () => {
    const e = new ConflictError('ILLEGAL_TRANSITION', 'Quote already accepted', { from: 'accepted' });
    expect(e.httpStatus).toBe(409);
    expect(e.toEnvelope('trace-1')).toEqual({
      error: {
        code: 'ILLEGAL_TRANSITION',
        message: 'Quote already accepted',
        details: { from: 'accepted' },
      },
      traceId: 'trace-1',
    });
    expect(new ValidationError('bad').httpStatus).toBe(400);
    expect(new NotFoundError('Vehicle', 'abc').details).toEqual({ id: 'abc' });
  });
});
