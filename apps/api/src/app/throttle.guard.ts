import { createHash } from 'node:crypto';
import type { Request } from 'express';

/**
 * Rate limiting, keyed per CALLER rather than per address.
 *
 * WHY NOT PLAIN IP. Algerian mobile carriers use carrier-grade NAT heavily,
 * so a single public address can front a large number of real users. An
 * IP-keyed limit tight enough to stop abuse would lock out everyone sharing
 * that address, and loose enough not to would not be a limit at all.
 *
 * So an authenticated caller is keyed on a HASH OF THEIR BEARER TOKEN, which
 * gives each user their own bucket regardless of the address they share.
 *
 * WHY THE TOKEN AND NOT THE ACCOUNT ID. The account id lives on the
 * AuthContext that `RbacGuard` attaches, and guard execution order between
 * two global guards is not something to build a security control on. Reading
 * an unverified `sub` claim out of the token would be worse: an attacker
 * could mint a fresh bucket per request by editing the payload. Hashing the
 * whole token avoids both — forging one requires credentials, and a
 * legitimate user holds exactly one at a time.
 *
 * Rotating a token (which the app does after every GoTrue refresh) starts a
 * fresh bucket. That is lenient, not dangerous — getting a new token requires
 * authenticating again.
 *
 * Anonymous callers fall back to the address, which is correct for the public
 * endpoints that have no caller: the tight limits those carry are low enough
 * to stop enumeration and still far above anything a human does by hand, even
 * sharing an address with a city.
 *
 * WHY A FUNCTION AND NOT A ThrottlerGuard SUBCLASS. The obvious shape here is
 * `class extends ThrottlerGuard` with `getTracker` overridden, and it crashed
 * the API on boot: `Class constructor ThrottlerGuard cannot be invoked
 * without 'new'`. Nx configures swc-loader with `loose: true` and NO
 * `jsc.target`, so SWC falls back to ES5 and compiles `extends` to prototype
 * calls — which cannot construct a native class from a package that ships
 * modern output. Invisible to tsc and to jest, which never see the webpack
 * bundle. The module takes `getTracker` as an option, so passing a plain
 * function sidesteps inheritance altogether and cannot be downlevelled wrong.
 */
export function callerTracker(req: Request): string {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) {
      // Truncated: a bucket key needs to be unique, not irreversible, and a
      // shorter key keeps the in-memory map small.
      return `tok:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
    }
  }

  /*
    `req.ip` is the real client address here because nothing proxies the API:
    it is published straight off the container and Express sees the peer.
    Measured, not assumed — a probe from the public internet arrives with the
    caller own address and no X-Forwarded-For.

    TRUST PROXY IS DELIBERATELY NOT SET. With no proxy in front, trusting
    X-Forwarded-For would let any caller spoof an address and so pick their
    own bucket, which defeats the whole control. WHOEVER PUTS CADDY OR A LOAD
    BALANCER IN FRONT OF THIS MUST set `trust proxy` to exactly the number of
    hops they add, in the same change — otherwise every request arrives from
    the proxy and all anonymous traffic shares one bucket.
  */
  return `ip:${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}`;
}
