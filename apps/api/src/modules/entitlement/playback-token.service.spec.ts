import { InvalidPlaybackTokenException } from '../../common/exceptions';
import { PlaybackTokenService } from './playback-token.service';

const SECRET = 'a-test-secret-that-is-long-enough-32';

const service = (overrides: Partial<{ ttl: number; bindIp: boolean; secret: string }> = {}) =>
  new PlaybackTokenService({
    playbackTokenSecret: overrides.secret ?? SECRET,
    playbackTokenTtlSeconds: overrides.ttl ?? 300,
    bindTokenToIp: overrides.bindIp ?? false,
  } as never);

const CLAIMS = { userId: 'user-1', lectureId: 'lecture-1', assetId: 'asset-1' };

describe('PlaybackTokenService', () => {
  afterEach(() => jest.useRealTimers());

  it('round-trips the claims it signed', () => {
    const tokens = service();
    const { token } = tokens.issue(CLAIMS);
    const verified = tokens.verify(token, {});

    expect(verified.userId).toBe('user-1');
    expect(verified.lectureId).toBe('lecture-1');
    expect(verified.assetId).toBe('asset-1');
  });

  describe('what a stolen token cannot be changed to', () => {
    /** The claim that matters most: a token for one lecture must not open another. */
    it('rejects a token whose lecture id was edited', () => {
      const tokens = service();
      const { token } = tokens.issue(CLAIMS);

      const [payload, signature] = token.split('.');
      const tampered = Buffer.from(payload, 'base64url')
        .toString('utf8')
        .replace('lecture-1', 'lecture-9');
      const forged = `${Buffer.from(tampered).toString('base64url')}.${signature}`;

      expect(() => tokens.verify(forged, {})).toThrow(InvalidPlaybackTokenException);
    });

    it('rejects a token signed with a different secret', () => {
      const { token } = service({ secret: 'a-completely-different-secret-3232' }).issue(CLAIMS);
      expect(() => service().verify(token, {})).toThrow(InvalidPlaybackTokenException);
    });

    it('rejects a token with no signature at all', () => {
      const [payload] = service().issue(CLAIMS).token.split('.');
      expect(() => service().verify(payload, {})).toThrow(InvalidPlaybackTokenException);
      expect(() => service().verify(`${payload}.`, {})).toThrow(InvalidPlaybackTokenException);
    });

    it('rejects garbage', () => {
      for (const bad of ['', '.', 'nonsense', 'a.b', '....']) {
        expect(() => service().verify(bad, {})).toThrow(InvalidPlaybackTokenException);
      }
    });

    /**
     * The signature has to be checked before any claim is read. Reading `expiresAt` from an
     * unverified payload and trusting it is the classic shape of this bug — so a token whose
     * expiry was pushed into the future must still fail, on the signature.
     */
    it('rejects an expiry extended by the holder', () => {
      const tokens = service();
      const { token } = tokens.issue(CLAIMS);

      const [payload, signature] = token.split('.');
      const fields = Buffer.from(payload, 'base64url').toString('utf8').split('|');
      fields[4] = String(Number(fields[4]) + 86_400);
      const forged = `${Buffer.from(fields.join('|')).toString('base64url')}.${signature}`;

      expect(() => tokens.verify(forged, {})).toThrow(InvalidPlaybackTokenException);
    });
  });

  describe('expiry', () => {
    it('is valid up to the last second and dead after it', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
      const tokens = service({ ttl: 300 });
      const { token, expiresAt } = tokens.issue(CLAIMS);

      jest.setSystemTime(new Date('2026-09-03T12:04:59Z'));
      expect(tokens.verify(token, {}).expiresAt).toBe(expiresAt);

      jest.setSystemTime(new Date('2026-09-03T12:05:00Z'));
      expect(() => tokens.verify(token, {})).toThrow(InvalidPlaybackTokenException);
    });
  });

  describe('address binding', () => {
    it('binds the token to the caller when enabled', () => {
      const tokens = service({ bindIp: true });
      const { token } = tokens.issue({ ...CLAIMS, ip: '203.0.113.7' });

      expect(tokens.verify(token, { ip: '203.0.113.7' }).ip).toBe('203.0.113.7');
      expect(() => tokens.verify(token, { ip: '198.51.100.4' })).toThrow(
        InvalidPlaybackTokenException,
      );
      // A leaked URL replayed from somewhere that presents no address at all.
      expect(() => tokens.verify(token, {})).toThrow(InvalidPlaybackTokenException);
    });

    it('carries no binding when it is disabled', () => {
      const tokens = service({ bindIp: false });
      const { token } = tokens.issue({ ...CLAIMS, ip: '203.0.113.7' });

      expect(tokens.verify(token, { ip: '198.51.100.4' }).ip).toBeUndefined();
    });

    /**
     * A token minted while binding was off must keep working when the flag is switched on
     * mid-deploy — otherwise every player mid-lecture breaks at the moment of the rollout.
     */
    it('does not retroactively reject unbound tokens when binding is switched on', () => {
      const { token } = service({ bindIp: false }).issue({ ...CLAIMS, ip: '203.0.113.7' });
      expect(() => service({ bindIp: true }).verify(token, { ip: '198.51.100.4' })).not.toThrow();
    });
  });

  /** `|` is the field separator; a value carrying one could move a claim between fields. */
  it('refuses to sign a claim containing the reserved separator', () => {
    expect(() => service().issue({ ...CLAIMS, lectureId: 'lecture|9' })).toThrow(
      InvalidPlaybackTokenException,
    );
  });
});
