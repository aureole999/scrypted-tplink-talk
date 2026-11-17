import assert from 'node:assert/strict';
import test from 'node:test';
import { VigiError, describeVigiError, isVigiError } from '../src/vigi-error';

test('authLike covers auth kinds, HTTP statuses and the confirmed camera code', () => {
    assert.equal(new VigiError('x', 'auth').authLike, true);
    assert.equal(new VigiError('x', 'camera', { status: 401 }).authLike, true);
    assert.equal(new VigiError('x', 'protocol', { status: 403 }).authLike, true);
    assert.equal(new VigiError('x', 'transport').authLike, false);
    assert.equal(new VigiError('x', 'camera', { code: -40401 }).authLike, true);
    // -40211/-52202 are unconfirmed guesses, not hardware-confirmed auth codes.
    assert.equal(new VigiError('x', 'camera', { code: -40211 }).authLike, false);
    assert.equal(new VigiError('x', 'camera', { code: -52202 }).authLike, false);
    assert.equal(new VigiError('x', 'camera', { code: -52411 }).authLike, false);
    assert.equal(new VigiError('x', 'camera', { status: 500 }).authLike, false);
});

test('describeVigiError maps the talk-busy camera code and keeps other errors readable', () => {
    assert.equal(
        describeVigiError(new VigiError('raw', 'camera', { code: -52411 })),
        'The camera talk channel is already in use. End the other talk session and try again. (-52411)',
    );
    assert.equal(
        describeVigiError(new VigiError('raw', 'camera', { code: -40401 })),
        'The camera rejected the login or session. Check the admin password. (-40401)',
    );
    assert.equal(
        describeVigiError(new VigiError('Camera request failed (error_code -40211).', 'camera', { code: -40211 })),
        'Camera request failed (error_code -40211).',
    );
    assert.equal(describeVigiError(new VigiError('raw camera message', 'camera', { code: -99999 })), 'raw camera message');
    assert.equal(describeVigiError(new Error('plain error')), 'plain error');
    assert.equal(describeVigiError('text'), 'text');
    assert.equal(describeVigiError(42), '42');
});

test('isVigiError recognizes only VigiError instances', () => {
    assert.equal(isVigiError(new VigiError('x', 'config')), true);
    assert.equal(isVigiError(new Error('x')), false);
    assert.equal(isVigiError('x'), false);
});
