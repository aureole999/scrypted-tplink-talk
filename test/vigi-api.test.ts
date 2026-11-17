import assert from 'node:assert/strict';
import net, { AddressInfo } from 'net';
import test from 'node:test';
import { backchannelHighWaterMark } from '../src/pcma-backchannel';
import { securityEncode } from '../src/security-encode';
import { VigiApi, TalkMode, maxHandshakeBodyBytes, maxJsonBodyBytes, maxProtocolHeaderBytes, maxProtocolHeaderCount, maxProtocolLineBytes, normalizeTalkMode } from '../src/vigi-api';
import { VigiError } from '../src/vigi-error';
import { MockCamera, MockCameraOptions, MockConnection } from './helpers/mock-camera';

const password = 'password';

async function createCamera(options: MockCameraOptions = {}) {
    const camera = new MockCamera(options);
    camera.expectedPassword = securityEncode(password);
    const address = await camera.listen();
    const connect = (requestTimeoutMilliseconds = 2000, signal?: AbortSignal) => VigiApi.connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'admin',
        password,
        requestTimeoutMilliseconds,
    }, signal);
    return { camera, address, connect };
}

async function waitFor(predicate: () => boolean, timeout = 2000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            throw new Error('timed out waiting for condition');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

function jsonParts(connection: MockConnection) {
    return connection.parts.parsed.filter(part => part.headers['content-type']?.includes('application/json'));
}

test('authenticates with a valid Digest on one connection and writes one-buffer audio parts', async t => {
    const { camera, connect } = await createCamera();
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    assert.equal(camera.connections.length, 1);
    assert.equal(camera.connections[0].authorized, true);
    assert.match(api.keyExchange, /cipher="AES_256_CBC"/);

    const messages = api.processMessages();
    assert.equal(api.processMessages(), messages);

    const writes: Buffer[] = [];
    const originalWrite = api.stream.write.bind(api.stream);
    (api.stream as any).write = (chunk: any, callback?: any) => {
        if (Buffer.isBuffer(chunk))
            writes.push(Buffer.from(chunk));
        return originalWrite(chunk, callback);
    };

    const writable = await api.startMpegTsBackchannel();
    assert.equal(writable.writableHighWaterMark, backchannelHighWaterMark);
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    writable.write(audio);

    await waitFor(() => camera.connections[0].parts.parsed.some(part => part.headers['content-type']?.includes('audio/mp2t')));
    const parts = camera.connections[0].parts.parsed;
    const talk = JSON.parse(jsonParts(camera.connections[0])[0].body.toString());
    assert.equal(talk.type, 'request');
    assert.equal(talk.seq, 1);
    assert.equal(talk.params.method, 'get');
    assert.deepEqual(talk.params.talk, { mode: 'aec' });

    const audioPart = parts.find(part => part.headers['content-type']?.includes('audio/mp2t'))!;
    assert.equal(audioPart.headers['x-if-encrypt'], '0');
    assert.equal(audioPart.headers['x-session-id'], 'session-1');
    assert.equal(audioPart.headers['content-length'], '5');
    assert.deepEqual(audioPart.body, audio);

    const audioWrite = writes.find(write => write.includes(Buffer.from('Content-Type: audio/mp2t')))!;
    assert.ok(audioWrite);
    assert.equal(audioWrite.toString('latin1').match(/----client-stream-boundary--/g)?.length, 1);
    assert.deepEqual(audioWrite.subarray(audioWrite.length - 2), Buffer.from('\r\n'));
    const headerEnd = audioWrite.indexOf('\r\n\r\n');
    assert.deepEqual(audioWrite.subarray(headerEnd + 4, audioWrite.length - 2), audio);

    const http = camera.connections[0].httpRequests;
    assert.equal(http.length, 2);
    assert.match(http[0], /^POST \/stream HTTP\/1\.1/);
    assert.match(http[1], /^POST \/stream HTTP\/1\.1/);
    assert.match(http[1], /Authorization: Digest username="admin"/);
    assert.match(http[1], /uri="\/stream"/);
});

test('normalizeTalkMode defaults unknown and legacy values to aec', () => {
    assert.equal(normalizeTalkMode('aec'), 'aec');
    assert.equal(normalizeTalkMode('half_duplex'), 'half_duplex');
    assert.equal(normalizeTalkMode('vad'), 'aec');
    assert.equal(normalizeTalkMode(undefined), 'aec');
});

test('startMpegTsBackchannel starts the read loop by itself', async t => {
    const { camera, connect } = await createCamera();
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const writable = await api.startMpegTsBackchannel();
    assert.equal(api.backchannelSessionId, 'session-1');
    writable.destroy();
});

for (const [mode, channel, expectChannel] of [
    [undefined, 0, false],
    ['aec', 0, false],
    ['half_duplex', 3, true],
    ['aec', 256, true],
] as const) {
    test(`talk request mode ${mode || 'default'} channel ${channel} ${expectChannel ? 'includes' : 'omits'} channel`, async t => {
        const { camera, connect } = await createCamera();
        const api = await connect();
        t.after(() => api.close());
        t.after(() => camera.close());
        api.processMessages();

        const writable = await api.startMpegTsBackchannel(mode as TalkMode, channel);
        await waitFor(() => jsonParts(camera.connections[0]).length === 1);
        const talk = JSON.parse(jsonParts(camera.connections[0])[0].body.toString()).params.talk;

        assert.equal(talk.mode, mode || 'aec');
        assert.equal('channel' in talk, expectChannel);
        if (expectChannel)
            assert.equal(talk.channel, channel);
        writable.destroy();
    });
}

for (const splitInitialPartWith200 of [false, true]) {
    test(`handles a 200 response and the first multipart part in one TCP read (${splitInitialPartWith200 ? 'split' : 'complete'} part)`, async t => {
        const { camera, connect } = await createCamera({ sendInitialPartWith200: true, splitInitialPartWith200 });
        const api = await connect();
        t.after(() => api.close());
        t.after(() => camera.close());

        api.processMessages();
        const writable = await api.startMpegTsBackchannel();
        assert.equal(api.backchannelSessionId, 'session-1');
        await waitFor(() => (api as any).initialData === undefined);
        writable.destroy();
    });
}

test('ignores stray bytes after the 401 body', async t => {
    const { camera, connect } = await createCamera({ challengeTrailingBytes: Buffer.from('\r\n') });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());
    assert.equal(camera.connections[0].authorized, true);
});

test('handles the 401 body and 200 headers split across TCP segments', async t => {
    const { camera, connect } = await createCamera({ splitHeaders: true });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    assert.equal(camera.connections.length, 1);
    assert.equal(camera.connections[0].authorized, true);
    assert.match(api.keyExchange, /AES_256_CBC/);
});

test('a busy talk session returns -52411 and clears when the old socket closes', async t => {
    const { camera, connect } = await createCamera({ singleTalkSession: true, closeOnEnd: true });
    t.after(() => camera.close());

    const first = await connect();
    const firstWritable = await first.startMpegTsBackchannel();

    const second = await connect();
    await assert.rejects(second.startMpegTsBackchannel(), error => {
        assert.ok(error instanceof VigiError);
        assert.equal(error.kind, 'camera');
        assert.equal(error.code, -52411);
        assert.match(error.message, /already in use \(-52411\)/);
        return true;
    });

    await first.close(true);
    await waitFor(() => camera.activeTalkConnectionIndex === undefined);

    const secondWritable = await second.startMpegTsBackchannel();
    assert.equal(second.backchannelSessionId, 'session-1');
    await second.close(true);
    firstWritable.destroy();
    secondWritable.destroy();
});

test('a rejected Digest attempt retries once on a fresh connection', async t => {
    const { camera, connect } = await createCamera({ rejectAuthenticatedRequests: 1 });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    assert.equal(camera.connections.length, 2);
    assert.equal(camera.connections[0].authorized, true);
    assert.equal(camera.connections[1].authenticated, true);
});

test('two rejected Digest attempts give a clear error', async t => {
    const { camera, connect } = await createCamera({ rejectAuthenticatedRequests: 2 });
    t.after(() => camera.close());

    await assert.rejects(connect(), error =>
        error instanceof VigiError
        && error.kind === 'auth'
        && error.status === 401
        && /Expected 200 status code after VIGI authentication, got 401/.test(error.message));
    assert.equal(camera.connections.length, 2);
});

test('an authenticated 403 or server failure is not retried', async t => {
    for (const status of [403, 500]) {
        const { camera, connect } = await createCamera({ authenticatedStatus: status });
        await assert.rejects(connect(), error =>
            error instanceof VigiError
            && error.status === status
            && error.kind === (status === 403 ? 'auth' : 'protocol'));
        assert.equal(camera.connections.length, 1, `HTTP ${status} must send only one password attempt`);
        await camera.close();
    }
});

test('a non-401 challenge response fails fast', async t => {
    const { camera, connect } = await createCamera({ initialStatus: 500 });
    t.after(() => camera.close());
    await assert.rejects(connect(), error =>
        error instanceof VigiError
        && error.kind === 'protocol'
        && error.status === 500
        && /Expected 401 status code for VIGI two-way audio init, got 500/.test(error.message));
});

test('a 401 without a WWW-Authenticate header fails actionably', async t => {
    const { camera, connect } = await createCamera({ noChallengeHeader: true });
    t.after(() => camera.close());
    await assert.rejects(connect(), /did not return a Digest authentication challenge/);
});

test('an unexpected 200 before authentication fails fast', async t => {
    const { camera, connect } = await createCamera({ noChallenge: true });
    t.after(() => camera.close());
    await assert.rejects(connect(), /Expected 401 status code/);
});

test('an unsupported Digest algorithm destroys the challenge socket', async t => {
    const { camera, connect } = await createCamera({
        challenge: 'Digest realm="vigi", nonce="n", algorithm=SHA-256',
    });
    t.after(() => camera.close());
    await assert.rejects(connect(), error =>
        error instanceof VigiError
        && error.kind === 'protocol'
        && /Unsupported digest algorithm/.test(error.message));
    await waitFor(() => camera.connections[0].socket.destroyed);
});

test('a silent HTTP handshake times out and destroys the sockets', async t => {
    const sockets: net.Socket[] = [];
    const server = net.createServer(socket => sockets.push(socket));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        for (const socket of sockets)
            socket.destroy();
        server.close();
    });
    const address = server.address() as AddressInfo;

    await assert.rejects(VigiApi.connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'admin',
        password: 'password',
        handshakeTimeoutMilliseconds: 50,
    }), error => error instanceof VigiError && error.kind === 'transport' && /handshake timed out/.test(error.message));
    assert.equal(sockets.length, 2); // one retry
});

test('AbortSignal cancels a silent handshake promptly', async t => {
    const sockets: net.Socket[] = [];
    const server = net.createServer(socket => sockets.push(socket));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        for (const socket of sockets)
            socket.destroy();
        server.close();
    });
    const address = server.address() as AddressInfo;
    const controller = new AbortController();
    const started = Date.now();
    const pending = VigiApi.connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'admin',
        password: 'password',
        handshakeTimeoutMilliseconds: 10000,
    }, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(pending, /aborted/);
    assert.ok(Date.now() - started < 500, 'expected abort, not the handshake timeout');
});

test('AbortSignal cancels a pending talk response', async t => {
    const { camera, connect } = await createCamera({ onTalk: () => undefined });
    const controller = new AbortController();
    const api = await connect(5000, controller.signal);
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    const pending = api.startMpegTsBackchannel();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /aborted/);
});

test('an abort after a resolved request leaves the stream open', async t => {
    const { camera, connect } = await createCamera();
    const controller = new AbortController();
    const api = await connect(2000, controller.signal);
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    const writable = await api.startMpegTsBackchannel();
    controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(api.stream.destroyed, false);
    writable.destroy();
});

test('an already-aborted request reports sent false', async t => {
    const { camera, connect } = await createCamera();
    const controller = new AbortController();
    const api = await connect(2000, controller.signal);
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    controller.abort();
    await assert.rejects(api.request({ method: 'get' }), error =>
        error instanceof VigiError
        && error.kind === 'transport'
        && error.retryable === false
        && error.sent === false);
});

test('request rejects while a graceful close is in progress', async t => {
    const { camera, connect } = await createCamera();
    const api = await connect();
    t.after(() => camera.close());

    const closing = api.close(true);
    await assert.rejects(api.request({ method: 'get' }), error =>
        error instanceof VigiError && error.kind === 'config' && /closed|stream is closing/i.test(error.message));
    await closing;
});

test('connect requires the admin account, a host and a password', async () => {
    for (const [options, message] of [
        [{ host: 'camera', username: 'user', password: 'p' }, /admin account/],
        [{ host: '', username: 'admin', password: 'p' }, /host is required/],
        [{ host: 'camera', username: 'admin', password: '' }, /password is required/],
    ] as const) {
        await assert.rejects(VigiApi.connect(options), error =>
            error instanceof VigiError && error.kind === 'config' && message.test(error.message));
    }
});

test('talk errors are reported before any audio is sent', async t => {
    for (const [params, expected] of [
        [{ error_code: -52411 }, /already in use \(-52411\)/],
        [{ error_code: -1 }, /Unexpected VIGI talk error/],
        [{ error_code: 0 }, /did not include session_id/],
    ] as const) {
        const { camera, connect } = await createCamera({
            onTalk: (request, mock, socket) => mock.writeResponse(socket, request.seq, params),
        });
        const api = await connect();
        t.after(() => api.close());
        t.after(() => camera.close());
        api.processMessages();
        await assert.rejects(api.startMpegTsBackchannel(), expected);
    }
});

test('invalid modes and channels are rejected before a camera request', async () => {
    const api = new VigiApi();
    api.request = async () => { assert.fail('invalid talk mode reached the camera'); };
    await assert.rejects(api.startMpegTsBackchannel('invalid' as TalkMode), error =>
        error instanceof VigiError && error.kind === 'config' && /Unsupported TP-Link talk mode/.test(error.message));

    for (const channel of [-1, 257, 1.5, NaN]) {
        const instance = new VigiApi();
        instance.request = async () => { assert.fail('invalid channel reached the camera'); };
        await assert.rejects(instance.startMpegTsBackchannel('aec', channel), error =>
            error instanceof VigiError && error.kind === 'config' && /Unsupported VIGI channel/.test(error.message));
    }
});

test('a missing talk response times out and clears the pending request', async t => {
    const { camera, connect } = await createCamera({ onTalk: () => undefined });
    const api = await connect(100);
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    await assert.rejects(api.startMpegTsBackchannel(), error =>
        error instanceof VigiError
        && error.kind === 'transport'
        && error.retryable === false
        && error.sent === true
        && /Timed out waiting for VIGI response to request 1/.test(error.message));
    assert.equal((api as any).requests.size, 0);
});

test('the audio Writable enforces the 2 KiB high-water mark', async t => {
    const { camera, connect } = await createCamera();
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    const writable = await api.startMpegTsBackchannel();
    const data = Buffer.alloc(4096, 0x47);
    assert.equal(writable.write(data), false);
    await new Promise<void>((resolve, reject) => {
        writable.once('drain', resolve);
        writable.once('error', reject);
    });
    await waitFor(() => camera.connections[0].parts.parsed.some(part =>
        part.headers['content-type']?.includes('audio/mp2t') && part.body.length === data.length));
});

test('a synchronous socket write failure rejects the request and clears it', async t => {
    const { camera, connect } = await createCamera();
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    (api.stream as any).write = () => {
        throw new Error('write failed');
    };
    await assert.rejects(api.request({ method: 'get' }), /write failed/);
    assert.equal((api as any).requests.size, 0);
});

test('close rejects a pending request and request fails after close', async t => {
    const { camera, connect } = await createCamera({ onTalk: () => undefined });
    const api = await connect(5000);
    t.after(() => camera.close());
    api.processMessages();

    const pending = api.request({ method: 'get' });
    await waitFor(() => jsonParts(camera.connections[0]).length === 1);
    api.close();
    await assert.rejects(pending, error =>
        error instanceof VigiError && error.kind === 'config' && /connection is closed/i.test(error.message));

    await assert.rejects(api.request({ method: 'get' }), error =>
        error instanceof VigiError && error.kind === 'config' && /closed|not connected/i.test(error.message));
});

test('a request after a camera-side stream failure stays a transport error', async t => {
    const { camera, connect } = await createCamera();
    const api = await connect();
    const messages = api.processMessages().catch(() => undefined);
    await camera.close();
    await messages;
    await assert.rejects(api.request({ method: 'get' }), error =>
        error instanceof VigiError && error.kind === 'transport' && /stream ended|stream closed/i.test(error.message));
});

test('oversized JSON parts are rejected before allocation grows without bound', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            mock.writePart(socket, 'application/json', Buffer.alloc(maxJsonBodyBytes + 1, 0x20));
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const messages = api.processMessages();
    const pending = api.startMpegTsBackchannel();
    await assert.rejects(messages, /JSON part is too large/);
    await assert.rejects(pending, /JSON part is too large/);
});

for (const [name, payload] of [
    ['unterminated line', 'X-Pad: ' + 'x'.repeat(maxProtocolLineBytes + 1)],
    ['header count', 'X-Pad: x\r\n'.repeat(maxProtocolHeaderCount + 1)],
    ['total header bytes', ('X-Pad: ' + 'x'.repeat(1024) + '\r\n').repeat(Math.ceil(maxProtocolHeaderBytes / 1024))],
] as const) {
    test(`multipart ${name} is bounded even after the talk request has settled`, async t => {
        const { camera, connect } = await createCamera();
        const api = await connect();
        t.after(() => api.close());
        t.after(() => camera.close());
        const writable = await api.startMpegTsBackchannel();
        const messages = api.processMessages();
        camera.connections[0].socket.write('----device-stream-boundary--\r\n' + payload);
        await assert.rejects(messages, error =>
            error instanceof VigiError && error.kind === 'protocol' && /too large/.test(error.message));
        writable.destroy();
    });
}

for (const [name, response] of [
    ['unterminated headers', 'HTTP/1.1 401 Unauthorized\r\nX-Pad: ' + 'x'.repeat(maxProtocolHeaderBytes + 1)],
    ['oversized line', 'HTTP/1.1 401 Unauthorized\r\nX-Pad: ' + 'x'.repeat(maxProtocolLineBytes + 1) + '\r\n\r\n'],
    ['header count', 'HTTP/1.1 401 Unauthorized\r\n' + 'X-Pad: x\r\n'.repeat(maxProtocolHeaderCount + 1) + '\r\n'],
    ['total header bytes', 'HTTP/1.1 401 Unauthorized\r\n' + ('X-Pad: ' + 'x'.repeat(1024) + '\r\n').repeat(33) + '\r\n'],
    ...[String(maxHandshakeBodyBytes + 1), 'NaN', '-1', '12junk', '1e6', ''].map(length => [
        `invalid challenge length ${JSON.stringify(length)}`,
        `HTTP/1.1 401 Unauthorized\r\nContent-Length: ${length}\r\n\r\n`,
    ]),
]) {
    test(`HTTP ${name} fails promptly without retrying malformed responses`, async t => {
        const sockets: net.Socket[] = [];
        const server = net.createServer(socket => {
            sockets.push(socket);
            socket.on('error', () => undefined);
            socket.once('data', () => socket.write(response));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => {
            for (const socket of sockets)
                socket.destroy();
            server.close();
        });
        await assert.rejects(VigiApi.connect({
            host: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
            username: 'admin',
            password,
            handshakeTimeoutMilliseconds: 1000,
        }), error => error instanceof VigiError && error.kind === 'protocol' && /too large/.test(error.message));
        assert.equal(sockets.length, 1);
        await waitFor(() => sockets[0].destroyed);
    });
}

test('a zero-length video part is skipped', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            mock.writePart(socket, 'video/mp2t', Buffer.alloc(0));
            mock.writeResponse(socket, request.seq, { error_code: 0, session_id: 'session-1' });
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    const writable = await api.startMpegTsBackchannel();
    assert.equal(api.backchannelSessionId, 'session-1');
    writable.destroy();
});

test('large video parts are discarded and the talk response still parses', async t => {
    const video = Buffer.alloc(2 * 1024 * 1024, 0x47);
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            mock.writePart(socket, 'video/mp2t', video);
            mock.writeResponse(socket, request.seq, { error_code: 0, session_id: 'session-1' });
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    const writable = await api.startMpegTsBackchannel();
    assert.equal(api.backchannelSessionId, 'session-1');
    writable.destroy();
});

test('processMessages ignores video parts, unrelated responses and events', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            mock.writePart(socket, 'video/mp2t', Buffer.from([0, 1, 2, 3]));
            mock.writeResponse(socket, 999, { ignored: true });
            mock.writePart(socket, 'application/json', Buffer.from(JSON.stringify({
                type: 'event', seq: request.seq, params: { ignored: true },
            })));
            mock.writePartSplit(socket, 'application/json', Buffer.from(JSON.stringify({
                type: 'response',
                seq: request.seq,
                params: { error_code: 0, session_id: 'split-session' },
            })), 1);
            mock.writeResponse(socket, request.seq, { error_code: 0, session_id: 'later-response' });
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());
    api.processMessages();

    const writable = await api.startMpegTsBackchannel();
    assert.equal(api.backchannelSessionId, 'split-session');
    writable.destroy();
});

test('accepts a closing multipart delimiter and ends the read loop', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            mock.writeResponse(socket, request.seq, { error_code: 0, session_id: 'closed' });
            socket.write('----device-stream-boundary----\r\n');
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const messages = api.processMessages();
    const writable = await api.startMpegTsBackchannel();
    assert.equal(api.backchannelSessionId, 'closed');
    await assert.rejects(messages, /device stream ended/);
    writable.destroy();
});

test('a closing delimiter coalesced with the 200 rejects a new talk request promptly', async t => {
    const { camera, connect } = await createCamera({ sendClosingDelimiterWith200: true });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const started = Date.now();
    await assert.rejects(api.startMpegTsBackchannel(), /device stream ended/);
    assert.ok(Date.now() - started < 500, 'expected the ended-stream error, not the request timeout');
});

test('a closing delimiter without a response rejects pending requests promptly', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            socket.write('----device-stream-boundary----\r\n');
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const messages = api.processMessages();
    const pending = api.startMpegTsBackchannel();
    await assert.rejects(pending, /device stream ended/);
    await assert.rejects(messages, /device stream ended/);
});

test('missing or invalid Content-Length is a protocol error', async t => {
    for (const [header, expected] of [
        ['', /missing Content-Length/],
        ['Content-Length: NaN\r\n', /invalid/],
        ['Content-Length: -1\r\n', /invalid/],
    ] as const) {
        const { camera, connect } = await createCamera({
            onTalk: (request, mock, socket) => {
                socket.write(`----device-stream-boundary--\r\nContent-Type: application/json\r\n${header}\r\n{}`);
            },
        });
        const api = await connect();
        t.after(() => api.close());
        t.after(() => camera.close());
        const messages = api.processMessages();
        const pending = api.startMpegTsBackchannel();
        await assert.rejects(messages, expected);
        await assert.rejects(pending, expected);
    }
});

test('malformed JSON rejects the read loop and pending requests', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            mock.writePart(socket, 'application/json', Buffer.from('{not json'));
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const messages = api.processMessages();
    const pending = api.startMpegTsBackchannel();
    const isProtocol = (error: unknown) => error instanceof VigiError && error.kind === 'protocol';
    await assert.rejects(messages, isProtocol);
    await assert.rejects(pending, isProtocol);
});

test('a JSON null, array or scalar part rejects the read loop as a protocol error', async t => {
    for (const payload of ['null', '[]', '"text"', '42']) {
        const { camera, connect } = await createCamera({
            onTalk: (request, mock, socket) => {
                mock.writePart(socket, 'application/json', Buffer.from(payload));
            },
        });
        const api = await connect();
        const messages = api.processMessages();
        const pending = api.startMpegTsBackchannel();
        const isProtocol = (error: unknown) => error instanceof VigiError && error.kind === 'protocol';
        await assert.rejects(messages, isProtocol);
        await assert.rejects(pending, isProtocol);
        await api.close();
        await camera.close();
    }
});

test('a malformed device boundary rejects the read loop and pending requests', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            socket.write('----wrong-boundary--\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const messages = api.processMessages();
    const pending = api.startMpegTsBackchannel();
    await assert.rejects(messages, /Expected ----device-stream-boundary--/);
    await assert.rejects(pending, /Expected ----device-stream-boundary--/);
});

test('a socket close in the middle of a part rejects the read loop and pending requests', async t => {
    const { camera, connect } = await createCamera({
        onTalk: (request, mock, socket) => {
            socket.write('----device-stream-boundary--\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"type":');
            setTimeout(() => socket.destroy(), 20);
        },
    });
    const api = await connect();
    t.after(() => api.close());
    t.after(() => camera.close());

    const messages = api.processMessages();
    const pending = api.startMpegTsBackchannel();
    await assert.rejects(messages, /multipart body|stream (closed|ended)/);
    await assert.rejects(pending, /multipart body|stream (closed|ended)/);
});

test('close(true) waits for the camera to close the socket', async t => {
    const { camera, connect } = await createCamera({ closeOnEnd: true });
    const api = await connect();
    t.after(() => camera.close());

    const started = Date.now();
    await api.close(true);
    assert.equal(api.stream.destroyed, true);
    assert.ok(Date.now() - started < 400, 'expected the camera-close path, not the 500 ms timeout');
});

test('close(true) destroys the socket if the camera stays half-open', async t => {
    const { camera, connect } = await createCamera({ allowHalfOpen: true });
    const api = await connect();
    t.after(() => camera.close());

    const started = Date.now();
    await api.close(true);
    assert.equal(api.stream.destroyed, true);
    assert.ok(Date.now() - started >= 400, 'expected the graceful close timeout');
});

test('close(true) ends the socket writable side and close() destroys it', async t => {
    const first = await createCamera();
    const api = await first.connect();
    t.after(() => api.close());
    t.after(() => first.camera.close());

    api.close(true);
    assert.equal(api.stream.writableEnded, true);
    assert.equal(api.stream.destroyed, false);

    const second = await createCamera();
    const other = await second.connect();
    t.after(() => second.camera.close());
    other.close();
    assert.equal(other.stream.destroyed, true);
});
