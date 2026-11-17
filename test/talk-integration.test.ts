import assert from 'node:assert/strict';
import { Writable } from 'stream';
import test from 'node:test';
import { PcmaBackchannel } from '../src/pcma-backchannel';
import { securityEncode } from '../src/security-encode';
import { VigiApi } from '../src/vigi-api';
import { MockCamera } from './helpers/mock-camera';

class FakeClock {
    time = 0;
    private tasks = new Map<object, { at: number; callback: () => void }>();
    now = () => this.time;
    schedule = (callback: () => void, milliseconds: number) => {
        const id = {};
        this.tasks.set(id, { at: this.time + milliseconds, callback });
        return id;
    };
    cancel = (id: unknown) => {
        this.tasks.delete(id as object);
    };
    advance(milliseconds: number) {
        const end = this.time + milliseconds;
        while (true) {
            const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > end)
                break;
            this.time = Math.max(this.time, next[1].at);
            this.tasks.delete(next[0]);
            next[1].callback();
        }
        this.time = end;
    }
}

function rtp(payload: Buffer) {
    const header = Buffer.alloc(12);
    header.set([0x80, 8]);
    return Buffer.concat([header, payload]);
}

function packets(data: Buffer) {
    assert.equal(data.length % 188, 0);
    return Array.from({ length: data.length / 188 }, (_, index) => data.subarray(index * 188, (index + 1) * 188));
}

function tsPayload(packet: Buffer) {
    return packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
}

function audioPayload(body: Buffer) {
    const pes = Buffer.concat(packets(body).map(tsPayload));
    assert.deepEqual([...pes.subarray(0, 4)], [0, 0, 1, 0xc0]);
    return pes.subarray(14);
}

function decodePts(body: Buffer) {
    const pes = Buffer.concat(packets(body).map(tsPayload));
    const p = pes.subarray(9, 14);
    return (p[0] >> 1 & 7) * 2 ** 30 + p[1] * 2 ** 22
        + (p[2] >> 1) * 2 ** 15 + p[3] * 2 ** 7 + (p[4] >> 1);
}

async function waitFor(predicate: () => boolean, timeout = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            throw new Error('timed out waiting for condition');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

test('VigiApi and PcmaBackchannel produce the verified multipart MPEG-TS talk stream', async t => {
    const camera = new MockCamera({
        onTalk: (request, mock, socket) => {
            // Interleave a non-JSON media part with the talk response.
            mock.writePart(socket, 'video/mp2t', Buffer.from([0, 1, 2, 3]));
            mock.writeResponse(socket, request.seq, { error_code: 0, session_id: 'session-1' });
        },
    });
    camera.expectedPassword = securityEncode('password');
    const address = await camera.listen();
    t.after(() => camera.close());

    const api = await VigiApi.connect({
        host: '127.0.0.1',
        port: address.port,
        username: 'admin',
        password: 'password',
        requestTimeoutMilliseconds: 2000,
    });
    t.after(() => api.close());
    api.processMessages();

    const writable = await api.startMpegTsBackchannel();
    const clock = new FakeClock();
    const sender = new PcmaBackchannel(writable, { clock });

    const frames = [
        Buffer.from(Array.from({ length: 512 }, (_, index) => index & 255)),
        Buffer.from(Array.from({ length: 512 }, (_, index) => (index + 1) & 255)),
        Buffer.from(Array.from({ length: 512 }, (_, index) => (index + 2) & 255)),
    ];
    for (const frame of frames)
        sender.pushRtp(rtp(frame));
    clock.advance(64);
    clock.advance(64);

    const stopping = Promise.resolve(sender.stop(true));
    let settled = false;
    stopping.then(() => settled = true, () => settled = true);
    for (let i = 0; i < 40 && !settled; i++) {
        clock.advance(64);
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(settled, 'tail flush must finish within its bounded fake-clock budget');
    await stopping;
    api.close(true);

    await waitFor(() => camera.connections[0]?.parts.parsed.length >= 8);
    const connection = camera.connections[0];

    const json = connection.parts.parsed.find(part => part.headers['content-type']?.includes('application/json'))!;
    const talk = JSON.parse(json.body.toString());
    assert.deepEqual(talk.params.talk, { mode: 'aec' });

    const audioParts = connection.parts.parsed.filter(part => part.headers['content-type']?.includes('audio/mp2t'));
    assert.ok(audioParts.length >= 7);

    for (const part of audioParts) {
        assert.equal(part.headers['x-if-encrypt'], '0');
        assert.equal(part.headers['x-session-id'], 'session-1');
        assert.equal(parseInt(part.headers['content-length']), part.body.length);
    }

    // The first part is PAT + PMT.
    const tables = packets(audioParts[0].body);
    assert.equal(tables.length, 2);
    assert.equal((tables[0][1] & 0x1f) << 8 | tables[0][2], 0);
    assert.equal((tables[1][1] & 0x1f) << 8 | tables[1][2], 18);
    const pmt = tsPayload(tables[1]);
    assert.equal(pmt[0], 0); // pointer field
    assert.equal(pmt[1], 2); // table_id PMT
    assert.equal(pmt[13], 0x90); // first stream_type is TP-Link PCMA

    const audio = audioParts.slice(1).map(part => audioPayload(part.body));
    assert.deepEqual(audio.slice(0, 3), frames);
    for (let i = 3; i < 6; i++)
        assert.ok(audio[i].every(value => value === 0xd5));

    // PTS advances by 512 samples = 5760 ticks at 90 kHz.
    assert.equal(decodePts(audioParts[1].body), 0);
    assert.equal(decodePts(audioParts[2].body), 5760);
    assert.equal(decodePts(audioParts[3].body), 11520);

    // Audio continuity counters are per PID and increment across parts.
    const audioCounters = audioParts.slice(1).map(part => packets(part.body).map(packet => packet[3] & 15));
    assert.deepEqual(audioCounters[0], [0, 1, 2]);
    assert.deepEqual(audioCounters[1], [3, 4, 5]);
    assert.deepEqual(audioCounters[2], [6, 7, 8]);
});
