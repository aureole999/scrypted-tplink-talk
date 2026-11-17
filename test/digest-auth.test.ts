import assert from 'node:assert/strict';
import test from 'node:test';
import { digestAuthHeader, parseDigestHeader } from '../src/digest-auth';

const challenge = 'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';

test('parseDigestHeader extracts challenge values', () => {
    assert.deepEqual(parseDigestHeader(challenge), {
        realm: 'testrealm@host.com',
        qop: 'auth',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    });
});

test('parseDigestHeader handles quoted commas, escapes and unquoted values', () => {
    assert.deepEqual(parseDigestHeader(
        'Digest Realm="a,b", qop="auth,auth-int", algorithm=MD5, nonce="a\\"b", stale=false',
    ), {
        realm: 'a,b',
        qop: 'auth,auth-int',
        algorithm: 'MD5',
        nonce: 'a"b',
        stale: 'false',
    });
});

test('digestAuthHeader builds the RFC 2617 example response', () => {
    const header = digestAuthHeader('GET', '/dir/index.html', challenge, 'Mufasa', 'Circle Of Life', {
        cnonce: '0a4f113b',
        nc: 1,
    });

    assert.match(header, /^Digest /);
    assert.match(header, /username="Mufasa"/);
    assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
    assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
    assert.match(header, /qop=auth/);
    assert.match(header, /nc=00000001/);
    assert.match(header, /algorithm=MD5/);
});

test('digestAuthHeader builds the RFC 2069 example when qop is absent', () => {
    // RFC 2069 uses the password "CircleOfLife" (no spaces), unlike the
    // RFC 2617 qop example below.
    const header = digestAuthHeader('GET', '/dir/index.html',
        'Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"',
        'Mufasa', 'CircleOfLife', { cnonce: '0a4f113b', nc: 1 });

    assert.match(header, /response="1949323746fe6a43ef61f9606e7febea"/);
    assert.doesNotMatch(header, /qop=/);
    assert.doesNotMatch(header, /nc=/);
    assert.doesNotMatch(header, /cnonce=/);
});

test('digestAuthHeader picks auth from a qop list and pads the nonce count', () => {
    const header = digestAuthHeader('POST', '/stream',
        'Digest realm="vigi", qop="auth-int, auth", nonce="n", opaque="o"',
        'admin', 'password', { cnonce: 'c', nc: 42 });

    assert.match(header, /qop=auth,/);
    assert.match(header, /nc=00000042/);
    assert.match(header, /cnonce="c"/);
});

test('digestAuthHeader rejects unsupported algorithms and qop values', () => {
    assert.throws(() => digestAuthHeader('POST', '/stream',
        'Digest realm="vigi", qop="auth", nonce="n", algorithm=SHA-256',
        'admin', 'password'), /Unsupported digest algorithm/);
    assert.throws(() => digestAuthHeader('POST', '/stream',
        'Digest realm="vigi", qop="auth-int", nonce="n"',
        'admin', 'password'), /Unsupported digest qop/);
    assert.throws(() => digestAuthHeader('POST', '/stream',
        'Digest realm="vigi", qop="auth", nonce="n"',
        'admin', 'password', { nc: 100000000 }), /nonce count is out of range/);
    assert.throws(() => digestAuthHeader('POST', '/stream',
        'Digest realm="vigi", qop="auth", nonce="n"',
        'admin', 'password', { nc: -1 }), /nonce count is out of range/);
    assert.throws(() => digestAuthHeader('POST', '/stream',
        'Digest realm="vigi", qop="auth", nonce="n"',
        'admin', 'password', { nc: 1.5 }), /nonce count is out of range/);
});

test('digestAuthHeader rejects a challenge without realm or nonce', () => {
    assert.throws(() => digestAuthHeader('POST', '/stream', 'Digest qop="auth"', 'admin', 'password'),
        /missing realm or nonce/);
    assert.throws(() => digestAuthHeader('POST', '/stream', 'Digest realm="vigi"', 'admin', 'password'),
        /missing realm or nonce/);
});
