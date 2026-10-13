import type { Request } from 'express';
import { CallerThrottlerGuard } from './throttle.guard';

/*
  The tracker is the whole guard. If it returns one value for many callers the
  limit becomes a shared outage; if it returns a value the caller controls, the
  limit does nothing at all. Both failures are silent, which is why these exist.
*/

class Probe extends CallerThrottlerGuard {
  constructor() {
    super({ throttlers: [] } as never, {} as never, {} as never);
  }
  track(req: Partial<Request>): Promise<string> {
    return this.getTracker(req as Request);
  }
}

const guard = new Probe();

const withToken = (token: string): Partial<Request> => ({
  headers: { authorization: `Bearer ${token}` },
  ip: '154.246.135.170',
});

describe('CallerThrottlerGuard tracker', () => {
  it('gives each bearer token its own bucket', async () => {
    const a = await guard.track(withToken('token-aaa'));
    const b = await guard.track(withToken('token-bbb'));
    expect(a).not.toBe(b);
    expect(a.startsWith('tok:')).toBe(true);
  });

  /*
    THE POINT OF KEYING ON THE TOKEN. Algerian carriers use CGNAT heavily, so
    many real users share one public address. Keyed on the address, a limit
    tight enough to stop abuse would lock all of them out at once.
  */
  it('separates two users sharing one address', async () => {
    const shared = '41.102.0.1';
    const a = await guard.track({ ...withToken('user-a'), ip: shared });
    const b = await guard.track({ ...withToken('user-b'), ip: shared });
    expect(a).not.toBe(b);
  });

  it('is stable for the same token', async () => {
    expect(await guard.track(withToken('same'))).toBe(await guard.track(withToken('same')));
  });

  it('does not leak the token into the key', async () => {
    const secret = 'eyJhbGciOiJIUzI1NiJ9.super-secret-payload.signature';
    const key = await guard.track(withToken(secret));
    expect(key).not.toContain('super-secret-payload');
    expect(key).not.toContain(secret);
  });

  it('accepts the scheme in any case', async () => {
    const lower = await guard.track({ headers: { authorization: 'bearer tok' }, ip: '1.1.1.1' });
    const upper = await guard.track({ headers: { authorization: 'Bearer tok' }, ip: '1.1.1.1' });
    expect(lower).toBe(upper);
  });

  describe('anonymous callers', () => {
    it('fall back to the address', async () => {
      expect(await guard.track({ headers: {}, ip: '203.0.113.9' })).toBe('ip:203.0.113.9');
    });

    it('fall back when the scheme is present but the token is empty', async () => {
      expect(await guard.track({ headers: { authorization: 'Bearer ' }, ip: '203.0.113.9' })).toBe(
        'ip:203.0.113.9',
      );
    });

    it('fall back for a non-bearer scheme', async () => {
      expect(await guard.track({ headers: { authorization: 'Basic abc' }, ip: '203.0.113.9' })).toBe(
        'ip:203.0.113.9',
      );
    });

    it('use the socket address when express has no ip', async () => {
      expect(
        await guard.track({ headers: {}, socket: { remoteAddress: '198.51.100.4' } } as never),
      ).toBe('ip:198.51.100.4');
    });

    /*
      Never throw. A tracker that raises on an odd request turns a rate limit
      into a 500 on a path that was working.
    */
    it('survive a request with nothing on it', async () => {
      await expect(guard.track({} as never)).resolves.toBe('ip:unknown');
    });
  });

  /*
    X-Forwarded-For is NOT consulted, because nothing proxies this API — it is
    published straight off the container and Express sees the real peer
    (measured from the public internet, not assumed). Honouring the header
    with no proxy in front would let any caller choose their own bucket and
    walk around the limit.
  */
  it('ignores a spoofed forwarding header', async () => {
    const key = await guard.track({
      headers: { 'x-forwarded-for': '9.9.9.9' },
      ip: '203.0.113.9',
    } as never);
    expect(key).toBe('ip:203.0.113.9');
  });
});
