import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import path from 'path';
import { Writable } from 'stream';
import test from 'node:test';
import { startPcmaRtpForwarder } from '../src/audio-forwarder';
import { audioSendModes } from '../src/pcma-backchannel';
import { securityEncode } from '../src/security-encode';
import { TalkSession } from '../src/talk-session';
import { VigiApi } from '../src/vigi-api';
import { VigiError } from '../src/vigi-error';
import { MockCamera } from './helpers/mock-camera';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class FakeStream extends EventEmitter {
    destroyed = false;
}

class FakeClient {
    stream = new FakeStream();
    writes: Buffer[] = [];
    closed = false;
    closeGraceful?: boolean;
    closeGate?: Promise<void>;
    talkMode?: string;
    talkChannel?: number;
    failTalk?: unknown;
    process = deferred<void>();
    writable = new Writable({
        write: (data, _encoding, callback) => {
            this.writes.push(Buffer.from(data));
            callback();
        },
    });

    processMessages() {
        return this.process.promise;
    }

    async startMpegTsBackchannel(mode: string, channel?: number) {
        this.talkMode = mode;
        this.talkChannel = channel;
        if (this.failTalk)
            throw this.failTalk;
        return this.writable;
    }

    async close(graceful = false) {
        if (this.closeGate)
            await this.closeGate;
        this.closed = true;
        this.closeGraceful = graceful;
        this.stream.destroyed = true;
        this.stream.emit('close');
    }
}

class FakeForwarder {
    killed = false;
    killCount = 0;
    exit = deferred<void>();

    kill() {
        this.killed = true;
        this.killCount++;
        this.exit.resolve();
    }

    get killPromise() {
        return this.exit.promise;
    }
}

function createTestSession() {
    const client = new FakeClient();
    const forwarder = new FakeForwarder();
    const connects: any[] = [];
    const forwards: any[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const console = {
        log: (message: string) => logs.push(message),
        error: (message: string) => errors.push(message),
    } as unknown as Console;

    const session = new TalkSession(console, {
        connect: (async (options: any, signal?: AbortSignal) => {
            connects.push({ options, signal });
            return client as unknown as VigiApi;
        }) as any,
        startForwarder: (async (_console: Console, input: any, onRtp: any, dependencies: any) => {
            forwards.push({ input, onRtp, dependencies });
            return forwarder as any;
        }) as any,
        getFFmpegPath: async () => 'ffmpeg',
        onStatistics: (statistics: any) => logs.push(`stats:${statistics.mode}`),
    });

    return { session, client, forwarder, connects, forwards, logs, errors };
}

const connection = {
    host: '192.168.1.50',
    port: 8800,
    username: 'admin',
    password: 'secret',
};

test('TalkSession connects, starts talk/audio, and stops in order', async () => {
    const { session, client, forwarder, connects, forwards, errors } = createTestSession();
    await session.start({
        ffmpegInput: { inputArguments: ['-i', 'input'] } as any,
        connection,
        mode: 'aec',
        audioSendMode: audioSendModes.paced,
        channel: 3,
    });

    assert.deepEqual(connects[0].options, connection);
    assert.equal(client.talkMode, 'aec');
    assert.equal(client.talkChannel, 3);
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].dependencies.getFFmpegPath instanceof Function, true);
    assert.ok(client.writes.length >= 1); // PAT/PMT
    assert.equal((session as any).startupAbort, undefined);
    assert.equal((session as any).externalAbortCleanup, undefined);

    await session.stop();
    assert.equal(client.closed, true);
    assert.equal(client.closeGraceful, true);
    assert.equal(client.writable.writableEnded, true);
    assert.equal(forwarder.killed, true);
    assert.deepEqual(errors, []);
});

test('TalkSession normalizes unknown mode and channel values', async () => {
    const { session, client } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'vad',
        audioSendMode: 'unknown',
        channel: 256,
    });
    assert.equal(client.talkMode, 'aec');
    assert.equal(client.talkChannel, 256);
    await session.stop();
});

test('an aborted signal prevents connect', async () => {
    const { session, connects } = createTestSession();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
        signal: controller.signal,
    }), /aborted/);
    assert.equal(connects.length, 0);
});

test('a connect failure leaves no session behind', async () => {
    const { session } = createTestSession();
    (session as any).dependencies.connect = async () => {
        throw new VigiError('connect failed', 'transport');
    };
    await assert.rejects(session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    }), /connect failed/);
    assert.equal((session as any).client, undefined);
    assert.equal((session as any).backchannel, undefined);
    assert.equal((session as any).forwarder, undefined);
    assert.equal((session as any).startupAbort, undefined);
    assert.equal((session as any).externalAbortCleanup, undefined);
});

test('forwarder startup failures are typed and cleaned up', async () => {
    const { session, client } = createTestSession();
    (session as any).dependencies.startForwarder = async () => {
        throw new Error('no ffmpeg');
    };
    await assert.rejects(session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    }), error => error instanceof VigiError && error.kind === 'transport' && /no ffmpeg/.test(error.message));
    assert.equal(client.closed, true);
});

test('read-loop and transport errors tear down the session', async () => {
    const { session, client, forwarder } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    client.process.reject(new VigiError('malformed boundary', 'protocol'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(forwarder.killed, true);
    assert.equal(client.closed, true);
    assert.equal((session as any).client, undefined);
    assert.equal((session as any).backchannel, undefined);
    assert.equal((session as any).forwarder, undefined);
    assert.equal((session as any).startupAbort, undefined);
    assert.equal((session as any).externalAbortCleanup, undefined);

    const second = createTestSession();
    await second.session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    second.client.writable.emit('error', new VigiError('socket failed', 'transport'));
    assert.equal(second.forwarder.killed, true);
    assert.equal(second.client.closed, true);
});

test('forwarder exit tears down quietly and does not log a failure', async () => {
    const { session, client, forwarder, errors } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    forwarder.exit.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(client.closed, true);
    assert.equal(client.writable.writableEnded, true);
    assert.deepEqual(errors, []);
});

test('a read-loop failure aborts a pending forwarder startup', async () => {
    const { session, client, forwards } = createTestSession();
    const forwarderStarted = deferred<void>();
    let aborted = false;
    (session as any).dependencies.startForwarder = (_console: Console, _input: any, _onRtp: any, dependencies: any) => {
        forwarderStarted.resolve();
        return new Promise((_resolve, reject) => {
            const onAbort = () => {
                aborted = true;
                reject(new VigiError('aborted', 'config'));
            };
            if (dependencies.signal?.aborted)
                onAbort();
            else
                dependencies.signal?.addEventListener('abort', onAbort, { once: true });
        });
    };

    const starting = session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    await forwarderStarted.promise;
    client.process.reject(new VigiError('malformed boundary', 'protocol'));
    await assert.rejects(starting, /aborted|malformed/);
    assert.equal(aborted, true);
    assert.equal(client.closed, true);
    assert.equal(forwards.length, 0);
});

test('a stop during connect invalidates the pending start', async () => {
    const { session } = createTestSession();
    let connectSignal: AbortSignal | undefined;
    (session as any).dependencies.connect = (_options: any, signal?: AbortSignal) => {
        connectSignal = signal;
        return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new VigiError('aborted', 'config')), { once: true });
        });
    };

    const starting = session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    await session.stop();
    assert.equal(connectSignal?.aborted, true);
    await assert.rejects(starting, /aborted|superseded/);
});

test('the session forwards backchannel statistics', async () => {
    const { session, client, forwarder, forwards, logs } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    const rtp = Buffer.alloc(12 + 160);
    rtp.set([0x80, 8]);
    forwards[0].onRtp(rtp);
    const stopping = session.stop();
    assert.equal(forwarder.killed, true, 'stop capturing before playing the buffered tail');
    assert.equal(client.closed, false, 'keep the transport alive during tail playback');
    await stopping;
    assert.ok(logs.some(line => line.startsWith('stats:')), 'expected the statistics callback');
});

test('a real ffmpeg spawn failure rejects session startup and releases the camera', async t => {
    const camera = new MockCamera({ closeOnEnd: true, singleTalkSession: true });
    camera.expectedPassword = securityEncode('password');
    const { port } = await camera.listen();
    t.after(() => camera.close());
    const session = new TalkSession({ log() {}, error() {} } as unknown as Console, {
        connect: VigiApi.connect,
        startForwarder: startPcmaRtpForwarder,
        getFFmpegPath: async () => path.join(__dirname, 'missing-ffmpeg'),
    });
    t.after(() => session.stop());
    await assert.rejects(session.start({
        connection: { host: '127.0.0.1', port, username: 'admin', password: 'password' },
        ffmpegInput: { inputArguments: ['-i', 'unused'] } as any,
        mode: 'aec',
    }), /ENOENT/);
    assert.equal((session as any).client, undefined);
    assert.equal((session as any).forwarder, undefined);
    assert.equal((session as any).backchannel, undefined);
});

test('a new start waits for the previous forwarder close', async () => {
    const { session, client, forwarder } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });

    const gate = deferred<void>();
    client.closeGate = gate.promise;
    const secondClient = new FakeClient();
    const secondForwarder = new FakeForwarder();
    let connects = 0;
    (session as any).dependencies.connect = async () => {
        connects++;
        return secondClient;
    };
    (session as any).dependencies.startForwarder = async () => secondForwarder;

    forwarder.exit.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    const secondStart = session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'half_duplex',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(connects, 0, 'new start must wait for the old socket close');

    gate.resolve();
    await secondStart;
    assert.equal(connects, 1);
    assert.equal(client.closed, true);
    await session.stop();
});

test('stop waits for the forwarder close and clears closing', async () => {
    const { session, client, forwarder } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });

    const gate = deferred<void>();
    client.closeGate = gate.promise;
    forwarder.exit.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));

    let stopped = false;
    const stopping = session.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'stop must wait for the old socket close');
    assert.ok((session as any).closing);

    gate.resolve();
    await stopping;
    assert.equal(stopped, true);
    assert.equal((session as any).closing, undefined);
    assert.equal(client.closed, true);
});

test('a real stream close during an active session is reported and tears down', async () => {
    const { session, client, forwarder, errors } = createTestSession();
    await session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });

    client.stream.emit('close');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(errors.some(line => /connection closed/.test(line)));
    assert.equal(forwarder.killed, true);
    assert.equal(client.closed, true);
    assert.equal((session as any).client, undefined);
});

test('TalkSession waits for the real VigiApi socket close before reconnecting', async t => {
    const camera = new MockCamera({ singleTalkSession: true, closeOnEnd: true });
    camera.expectedPassword = securityEncode('password');
    const address = await camera.listen();
    t.after(() => camera.close());

    const console = {
        log: () => undefined,
        error: () => undefined,
    } as unknown as Console;
    const forwarders: FakeForwarder[] = [];
    const session = new TalkSession(console, {
        connect: VigiApi.connect,
        startForwarder: async () => {
            const forwarder = new FakeForwarder();
            forwarders.push(forwarder);
            return forwarder;
        },
        getFFmpegPath: async () => 'ffmpeg',
    });
    t.after(() => session.stop());

    const settings = {
        host: '127.0.0.1',
        port: address.port,
        username: 'admin',
        password: 'password',
    };
    await session.start({
        ffmpegInput: {} as any,
        connection: settings,
        mode: 'aec',
    });
    assert.equal(camera.connections.length, 1);

    forwarders[0].exit.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    await session.start({
        ffmpegInput: {} as any,
        connection: settings,
        mode: 'half_duplex',
    });

    assert.equal(forwarders.length, 2);
    assert.equal(camera.connections.length, 2);
    assert.notEqual(camera.activeTalkConnectionIndex, undefined);
});

test('a late forwarder from an older direct start does not replace the newer session', async () => {
    const { session } = createTestSession();
    const client1 = new FakeClient();
    const client2 = new FakeClient();
    const forwarder1 = new FakeForwarder();
    const forwarder2 = new FakeForwarder();
    const firstForwarder = deferred<FakeForwarder>();
    let connects = 0;
    let forwards = 0;
    (session as any).dependencies.connect = async () => ++connects === 1 ? client1 : client2;
    (session as any).dependencies.startForwarder = async () => ++forwards === 1 ? firstForwarder.promise : forwarder2;

    const firstStart = session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const secondStart = session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'half_duplex',
    });
    await secondStart;

    firstForwarder.resolve(forwarder1);
    await assert.rejects(firstStart, /superseded|aborted/);
    assert.equal(forwarder1.killed, true);
    assert.equal((session as any).forwarder, forwarder2);

    await session.stop();
    assert.equal(forwarder2.killed, true);
    assert.equal(client2.closed, true);
});

test('a stop during forwarder startup invalidates the pending start', async () => {
    const { session, client, errors } = createTestSession();
    const forwarder = deferred<any>();
    (session as any).dependencies.startForwarder = async () => forwarder.promise;
    const starting = session.start({
        ffmpegInput: {} as any,
        connection,
        mode: 'aec',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    await session.stop();
    const lateForwarder = new FakeForwarder();
    forwarder.resolve(lateForwarder);
    await assert.rejects(starting, /superseded|aborted/);
    assert.equal(lateForwarder.killed, true);
    assert.equal(client.closed, true);
    assert.deepEqual(errors, []);
});
