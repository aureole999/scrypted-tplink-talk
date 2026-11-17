import crypto from 'crypto';
import { VigiError } from './vigi-error';

// Quoted-string values may contain commas (for example qop="auth,auth-int"),
// so parse the challenge as a sequence of key/value pairs instead of splitting
// on every comma.
const authKeyValue = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
const ncPad = '00000000';

export interface DigestAuthOptions {
    cnonce?: string;
    nc?: number;
}

export function parseDigestHeader(header: string): Record<string, string> {
    const digest = header.trim().replace(/^Digest\s+/i, '');
    const options: Record<string, string> = {};

    for (const match of digest.matchAll(authKeyValue)) {
        const value = match[2] ?? match[3] ?? '';
        options[match[1].toLowerCase()] = value.replace(/\\(.)/g, '$1');
    }

    return options;
}

function md5(value: string): string {
    return crypto.createHash('md5').update(value).digest('hex');
}

export function digestAuthHeader(method: string, uri: string, wwwAuthenticate: string, username: string, password: string, options: DigestAuthOptions = {}): string {
    const digest = parseDigestHeader(wwwAuthenticate);

    if (!digest.realm || !digest.nonce)
        throw new VigiError('Invalid digest challenge: missing realm or nonce.', 'protocol');

    const algorithm = (digest.algorithm || 'MD5').toUpperCase();
    if (algorithm !== 'MD5')
        throw new VigiError(`Unsupported digest algorithm: ${digest.algorithm}.`, 'protocol');

    const qopValues = (digest.qop || '').split(',').map(value => value.trim()).filter(Boolean);
    // Only qop=auth is implemented: qop=auth-int requires hashing the request
    // body, and the VIGI stream request has an empty body.
    const qop = qopValues.includes('auth') ? 'auth' : qopValues[0] || '';
    if (qop && qop !== 'auth')
        throw new VigiError(`Unsupported digest qop: ${qop}.`, 'protocol');

    const ncNumber = options.nc ?? 1;
    if (!Number.isInteger(ncNumber) || ncNumber < 0 || ncNumber > 99999999)
        throw new VigiError(`Digest nonce count is out of range: ${ncNumber}.`, 'config');
    const nc = String(ncNumber).padStart(ncPad.length, '0');

    const cnonce = options.cnonce ?? crypto.randomBytes(8).toString('hex');
    const ha1 = md5(`${username}:${digest.realm}:${password}`);
    const ha2 = md5(`${method.toUpperCase()}:${uri}`);

    let responseBase = `${ha1}:${digest.nonce}`;
    if (qop)
        responseBase += `:${nc}:${cnonce}:${qop}`;
    responseBase += `:${ha2}`;

    const response = md5(responseBase);

    const values = [
        `Digest username="${username}"`,
        `realm="${digest.realm}"`,
        `nonce="${digest.nonce}"`,
        `uri="${uri}"`,
        `response="${response}"`,
    ];

    if (digest.opaque)
        values.push(`opaque="${digest.opaque}"`);
    if (qop)
        values.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (digest.algorithm)
        values.push(`algorithm=${digest.algorithm}`);
    else
        values.push('algorithm=MD5');

    return values.join(', ');
}
