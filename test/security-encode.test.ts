import assert from 'node:assert/strict';
import test from 'node:test';
import { securityEncode } from '../src/security-encode';

test('securityEncode matches known VIGI vectors', () => {
    assert.equal(securityEncode(''), 'tyWcQbhc9TefbwK');
    assert.equal(securityEncode('admin'), 'WaQ7xbhc9TefbwK');
    assert.equal(securityEncode('password'), 'xHVQ3wiB9TefbwK');
    assert.equal(securityEncode('long-password-1234567890'), '4430UtxvyPU0wDKVkcMQfXq7');
});

test('securityEncode output length is max(password, 15)', () => {
    // The published short key "RDpbLfCPsJZ7fiv" is 15 characters.
    assert.equal(securityEncode('').length, 15);
    assert.equal(securityEncode('a').length, 15);
    assert.equal(securityEncode('a'.repeat(15)).length, 15);
    assert.equal(securityEncode('a'.repeat(16)).length, 16);
    assert.equal(securityEncode('a'.repeat(100)).length, 100);
});

test('securityEncode is deterministic and password-sensitive', () => {
    assert.equal(securityEncode('admin'), securityEncode('admin'));
    assert.notEqual(securityEncode('admin'), securityEncode('Admin'));
    assert.notEqual(securityEncode('admin'), securityEncode('admin '));
    // Every output character must come from the published charset.
    assert.match(securityEncode('test'), /^[A-Za-z0-9]+$/);
});
