import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'stream';
import { audioSendModes, AudioSendingStatistics, PcmaBackchannel, pcmaRtpPayload } from '../src/pcma-backchannel';

class FakeClock {
    time = 0;
    private tasks = new Map<object, { at: number; callback: () => void }>();
    now = () => this.time;
    schedule = (callback: () => void, milliseconds: number) => {
        const id = {};
        this.tasks.set(id, { at: this.time + milliseconds, callback });
        return id;
    };
    cancel = (id: unknown) => { this.tasks.delete(id as object); };
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

function audio(ts: Buffer): Buffer {
    const pes: Buffer[] = [];
    for (let i = 0; i < ts.length; i += 188) {
        const packet = ts.subarray(i, i + 188);
        pes.push(packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4));
    }
    return Buffer.concat(pes).subarray(14);
}

test('reassembles arbitrary RTP sizes into 1024-sample PES at 128 ms intervals', () => {
    const clock = new FakeClock();
    const writes: { at: number; data: Buffer }[] = [];
    const output = new Writable({ write(data, _, callback) {
        writes.push({ at: clock.now(), data: Buffer.from(data) }); callback();
    } });
    const sender = new PcmaBackchannel(output, { clock });
    const samples = Buffer.from(Array.from({ length: 3072 }, (_, i) => i % 251));
    for (let offset = 0; offset < samples.length; offset += 160)
        sender.pushRtp(rtp(samples.subarray(offset, offset + 160)));
    assert.equal(writes.length, 2); // tables and first complete frame
    clock.advance(127);
    assert.equal(writes.length, 2);
    clock.advance(129);
    assert.deepEqual(writes.slice(1).map(w => w.at), [0, 128, 256]);
    assert.deepEqual(Buffer.concat(writes.slice(1).map(w => audio(w.data))), samples);
    sender.stop();
});

test('late timers do not burst and stop cancels queued audio', () => {
    const clock = new FakeClock();
    const times: number[] = [];
    const output = new Writable({ write(_data, _, callback) { times.push(clock.now()); callback(); } });
    const sender = new PcmaBackchannel(output, { clock });
    sender.pushRtp(rtp(Buffer.alloc(4096)));
    clock.time = 500; // simulate a stalled event loop
    clock.advance(0);
    assert.deepEqual(times, [0, 0, 500]);
    clock.advance(127);
    assert.equal(times.length, 3);
    sender.stop();
    clock.advance(1000);
    sender.pushRtp(rtp(Buffer.alloc(1024)));
    assert.equal(times.length, 3);
});

test('bounded queue retains recent audio when the network is backpressured', async () => {
    const clock = new FakeClock();
    const writes: Buffer[] = [];
    let complete: (() => void) | undefined;
    const output = new Writable({ highWaterMark: 1, write(data, _, callback) {
        writes.push(Buffer.from(data)); complete = callback;
    } });
    const sender = new PcmaBackchannel(output, { clock });
    sender.pushRtp(rtp(Buffer.concat([Buffer.alloc(8192, 0x11), Buffer.alloc(8192, 0x22)])));
    clock.advance(256);
    assert.equal(writes.length, 1); // only PAT/PMT until TCP drains
    complete!();
    await new Promise<void>(resolve => setImmediate(resolve));
    clock.advance(128);
    assert.equal(writes.length, 2);
    assert.deepEqual(audio(writes[1]), Buffer.alloc(1024, 0x22));
    sender.stop();
    complete!();
    output.destroy();
});

test('RTP parser skips CSRC, extension and padding; rejects malformed packets', () => {
    const packet = Buffer.alloc(12 + 4 + 8 + 3 + 2);
    packet.set([0xb1, 8]); // padding, extension, one CSRC
    packet.writeUInt16BE(1, 18); // one extension word after four-byte header
    packet.set([0x11, 0x22, 0x33], 24);
    packet[packet.length - 1] = 2;
    assert.deepEqual(pcmaRtpPayload(packet), Buffer.from([0x11, 0x22, 0x33]));
    assert.equal(pcmaRtpPayload(Buffer.alloc(3)), undefined);
    assert.equal(pcmaRtpPayload(Buffer.from([0x90, 8, ...Buffer.alloc(10)])), undefined);
    packet[packet.length - 1] = 200;
    assert.equal(pcmaRtpPayload(packet), undefined);
    assert.equal(pcmaRtpPayload(Buffer.from([0x80, 0, ...Buffer.alloc(20)])), undefined);
});


test('VIGI mode preserves RTP frame sizes and sends at arrival time without pacing', () => {
    const clock = new FakeClock();
    const writes: { at: number; data: Buffer }[] = [];
    const output = new Writable({ write(data, _, callback) {
        writes.push({ at: clock.now(), data: Buffer.from(data) }); callback();
    } });
    const sender = new PcmaBackchannel(output, { clock, mode: audioSendModes.vigi });
    const frames = [Buffer.alloc(160, 0x11), Buffer.alloc(1188, 0x22), Buffer.alloc(320, 0x33)];
    sender.pushRtp(rtp(frames[0]));
    clock.advance(7);
    sender.pushRtp(rtp(frames[1]));
    sender.pushRtp(rtp(frames[2]));
    assert.deepEqual(writes.slice(1).map(w => w.at), [0, 7, 7]);
    assert.deepEqual(writes.slice(1).map(w => audio(w.data)), frames);
    clock.advance(1000);
    assert.equal(writes.length, 4);
    sender.stop();
    sender.pushRtp(rtp(Buffer.alloc(160)));
    assert.equal(writes.length, 4);
});

test('VIGI mode respects backpressure and retains recent complete RTP frames', async () => {
    const writes: Buffer[] = [];
    let complete: (() => void) | undefined;
    const output = new Writable({ highWaterMark: 1, write(data, _, callback) {
        writes.push(Buffer.from(data)); complete = callback;
    } });
    const sender = new PcmaBackchannel(output, { mode: audioSendModes.vigi });
    for (let i = 0; i < 10; i++)
        sender.pushRtp(rtp(Buffer.alloc(1024, i)));
    assert.equal(writes.length, 1);
    complete!();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    assert.deepEqual(audio(writes[1]), Buffer.alloc(1024, 2));
    sender.stop();
    complete!();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    assert.equal(output.listenerCount('drain'), 0);
    output.destroy();
});


test('RTP statistics report payload sizes, audio durations and actual arrival intervals', () => {
    const clock = new FakeClock();
    const reports: AudioSendingStatistics[] = [];
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output, {
        clock, mode: audioSendModes.vigi, onStatistics: statistics => reports.push(statistics),
    });
    sender.pushRtp(rtp(Buffer.alloc(160)));
    clock.advance(20);
    sender.pushRtp(rtp(Buffer.alloc(512)));
    clock.advance(64);
    sender.pushRtp(rtp(Buffer.alloc(1024)));
    assert.equal(reports.length, 0);
    clock.advance(4920);
    sender.pushRtp(rtp(Buffer.alloc(160)));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'periodic');
    assert.equal(reports[0].windowMilliseconds, 5004);
    assert.deepEqual(reports[0].rtpReceived, {
        packets: 4,
        audioMilliseconds: 232,
        payloadSizes: [
            { bytes: 160, audioMilliseconds: 20, count: 2 },
            { bytes: 512, audioMilliseconds: 64, count: 1 },
            { bytes: 1024, audioMilliseconds: 128, count: 1 },
        ],
        intervalMilliseconds: { minimum: 20, mean: 1668, maximum: 4920 },
    });
    assert.deepEqual(reports[0].pesWritten, reports[0].rtpReceived);
    sender.stop();
    sender.stop();
    assert.equal(reports.length, 1); // no duplicate empty reports
});

test('paced statistics distinguish incoming RTP sizes from outgoing PES aggregation', () => {
    const clock = new FakeClock();
    const reports: AudioSendingStatistics[] = [];
    const output = new Writable({ write(_data, _, callback) { callback(); } });
    const sender = new PcmaBackchannel(output, {
        clock, onStatistics: statistics => reports.push(statistics),
    });
    for (let i = 0; i < 3; i++)
        sender.pushRtp(rtp(Buffer.alloc(512)));
    clock.advance(128);
    sender.pushRtp(rtp(Buffer.alloc(512)));
    sender.stop();
    sender.stop();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reason, 'stop');
    assert.deepEqual(reports[0].rtpReceived.payloadSizes, [{ bytes: 512, audioMilliseconds: 64, count: 4 }]);
    assert.deepEqual(reports[0].pesWritten.payloadSizes, [{ bytes: 1024, audioMilliseconds: 128, count: 2 }]);
    assert.equal(reports[0].pesWritten.intervalMilliseconds?.mean, 128);
});
