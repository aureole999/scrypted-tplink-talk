import assert from 'node:assert/strict';
import test from 'node:test';
import { MpegTSWriter, StreamTypePCMATapo } from '../src/mpegts-writer';

function packets(data: Buffer): Buffer[] {
    assert.equal(data.length % 188, 0);
    return Array.from({ length: data.length / 188 }, (_, i) => {
        const packet = data.subarray(i * 188, (i + 1) * 188);
        assert.equal(packet[0], 0x47);
        return packet;
    });
}

function payload(packet: Buffer): Buffer {
    return packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
}

function decodePts(pes: Buffer): number {
    const p = pes.subarray(9, 14);
    assert.equal(p[0] & 0xf1, 0x21);
    assert.equal(p[2] & 1, 1);
    assert.equal(p[4] & 1, 1);
    return (p[0] >> 1 & 7) * 2 ** 30 + p[1] * 2 ** 22
        + (p[2] >> 1) * 2 ** 15 + p[3] * 2 ** 7 + (p[4] >> 1);
}

function section(packet: Buffer): Buffer {
    return payload(packet).subarray(1);
}

function sectionLength(value: Buffer): number {
    return 3 + ((value[1] & 15) * 256 + value[2]);
}

function assertCrc(value: Buffer) {
    const length = sectionLength(value);
    let remainder = 0xffffffff;
    for (const byte of value.subarray(0, length)) {
        for (let bit = 7; bit >= 0; bit--) {
            const carry = (remainder >>> 31) ^ ((byte >> bit) & 1);
            remainder <<= 1;
            if (carry)
                remainder ^= 0x04c11db7;
        }
    }
    assert.equal(remainder >>> 0, 0);
}

function writer() {
    const result = new MpegTSWriter();
    result.addPES(68, StreamTypePCMATapo);
    return result;
}

test('PAT and PMT have valid MPEG-2 CRC and 0xff PSI stuffing', () => {
    const mux = writer();
    mux.writePAT();
    mux.writePMT();
    for (const packet of packets(mux.resetBytes())) {
        const value = section(packet);
        const length = sectionLength(value);
        // Polynomial long division over the complete section including its CRC.
        assertCrc(value);
        assert.ok(value.subarray(length).every(byte => byte === 0xff));
    }
});

test('PAT and PMT packets match the expected bytes', () => {
    const expectedPat = '474000100000b00d0001c100000001e0127f737fbf';
    const expectedPmt = '474012100002b0120001c10000e044f00090e044f00009558dab';
    const mux = writer();
    mux.writePAT();
    const pat = packets(mux.resetBytes())[0];
    assert.equal(pat.subarray(0, expectedPat.length / 2).toString('hex'), expectedPat);
    assert.ok(pat.subarray(expectedPat.length / 2).every(byte => byte === 0xff));

    mux.writePMT();
    const pmt = packets(mux.resetBytes())[0];
    assert.equal(pmt.subarray(0, expectedPmt.length / 2).toString('hex'), expectedPmt);
    assert.ok(pmt.subarray(expectedPmt.length / 2).every(byte => byte === 0xff));
});

test('PAT maps program 1 to PMT PID 18 with the correct header bytes', () => {
    const mux = writer();
    mux.writePAT();
    const [packet, ...rest] = packets(mux.resetBytes());

    assert.equal(rest.length, 0);
    assert.equal(packet[1] & 0x40, 0x40); // payload unit start
    assert.equal(packet[1] & 0x1f, 0); // PID 0
    assert.equal(packet[2], 0);
    assert.equal(packet[3] & 0x10, 0x10); // payload only
    assert.equal(packet[3] & 15, 0);
    assert.equal(packet[4], 0); // pointer field
    assert.equal(packet[5], 0); // table_id PAT
    assert.equal(((packet[6] & 15) << 8) | packet[7], 13);
    assert.equal(packet[8], 0); // transport_stream_id
    assert.equal(packet[9], 1);
    assert.equal(packet[10] & 1, 1); // current_next_indicator
    assert.equal(packet[11], 0); // section_number
    assert.equal(packet[12], 0); // last_section_number
    assert.equal(packet[13], 0); // program_number 1
    assert.equal(packet[14], 1);
    assert.equal((packet[15] & 0x1f) << 8 | packet[16], 18);
});

test('PMT lists all audio PIDs and uses the first as PCR PID', () => {
    const mux = new MpegTSWriter();
    mux.addPES(68, StreamTypePCMATapo);
    mux.addPES(69, StreamTypePCMATapo);
    mux.writePMT();
    const [packet, ...rest] = packets(mux.resetBytes());
    const value = section(packet);

    assert.equal(rest.length, 0);
    assert.equal(packet[5], 2); // table_id PMT
    assert.equal(sectionLength(value), 26); // 3-byte header + 13 + 2 * 5
    assert.equal((value[8] & 0x1f) << 8 | value[9], 68); // PCR PID
    assert.deepEqual([...value.subarray(3, 12)], [0, 1, 0xc1, 0, 0, 0xe0, 68, 0xf0, 0]);
    // First stream entry.
    assert.equal(value[12], StreamTypePCMATapo);
    assert.equal((value[13] & 0x1f) << 8 | value[14], 68);
    assert.equal(value[15], 0xf0);
    assert.equal(value[16], 0);
    // Second stream entry.
    assert.equal(value[17], StreamTypePCMATapo);
    assert.equal((value[18] & 0x1f) << 8 | value[19], 69);
    assert.equal(value[20], 0xf0);
    assert.equal(value[21], 0);
});

test('PES header uses stream_id 0xC0, PTS-only flags and a 90 kHz timestamp', () => {
    const mux = writer();
    mux.writePES(68, 0xc0, Buffer.alloc(160));
    const ts = packets(mux.resetBytes());
    const pes = Buffer.concat(ts.map(payload));

    assert.deepEqual([...pes.subarray(0, 9)], [0, 0, 1, 0xc0, 0, 168, 0x80, 0x80, 5]);
    assert.equal(decodePts(pes), 0);
    assert.equal(pes.length, 174);
});

for (const size of [1, 160, 169, 170, 171, 354, 355, 1024]) {
    test(`PES preserves ${size} PCMA samples and continuity across PES boundaries`, () => {
        const mux = writer();
        const audio = Buffer.from(Array.from({ length: size }, (_, i) => i & 255));
        let nextCounter = 0;
        for (let frame = 0; frame < 20; frame++) {
            mux.writePES(68, 192, audio);
            const ts = packets(mux.resetBytes());
            for (let i = 0; i < ts.length; i++) {
                assert.equal(ts[i][3] & 15, nextCounter);
                nextCounter = (nextCounter + 1) & 15;
                assert.equal(!!(ts[i][1] & 0x40), i === 0);
            }
            const pes = Buffer.concat(ts.map(payload));
            assert.equal(pes.readUInt16BE(4), size + 8);
            assert.equal(decodePts(pes), Math.floor(frame * size * 90000 / 8000));
            assert.deepEqual(pes.subarray(14), audio);
        }
    });
}

test('last PES packet uses a valid adaptation field for sizes below 184 bytes', () => {
    for (const size of [1, 160, 169, 170, 171, 183, 184, 185, 368, 369]) {
        const mux = writer();
        const audio = Buffer.alloc(size, 0x5a);
        mux.writePES(68, 192, audio);
        const ts = packets(mux.resetBytes());
        const last = ts[ts.length - 1];
        const total = size + 14;
        const remaining = total % 184 || 184;
        if (remaining < 184) {
            assert.equal(last[3] & 0x20, 0x20, `size ${size} should use an adaptation field`);
            assert.equal(last[4], 183 - remaining);
            if (last[4] > 0)
                assert.equal(last[5], 0);
            assert.equal(188 - remaining, 5 + last[4]);
            const lastPayload = last.subarray(188 - remaining);
            // A single-packet PES still starts with its 14-byte header.
            assert.ok(lastPayload.subarray(ts.length === 1 ? 14 : 0).every(byte => byte === 0x5a));
        }
        else {
            assert.equal(last[3] & 0x20, 0, `size ${size} should not need adaptation`);
        }
    }
});

test('continuity counters are independent per PID and wrap at 16', () => {
    const mux = new MpegTSWriter();
    mux.addPES(68, StreamTypePCMATapo);
    mux.addPES(69, StreamTypePCMATapo);

    for (let i = 0; i < 20; i++) {
        mux.writePES(68, 192, Buffer.alloc(1));
        const audio = packets(mux.resetBytes());
        assert.equal(audio[0][3] & 15, i & 15);
        assert.equal(audio[0][2], 68);
    }

    mux.writePES(69, 193, Buffer.alloc(160));
    const other = packets(mux.resetBytes());
    assert.equal(other[0][3] & 15, 0);
    assert.equal(other[0][2], 69);
});

test('PES timestamps are independent per PID', () => {
    const mux = new MpegTSWriter();
    mux.addPES(68, StreamTypePCMATapo);
    mux.addPES(69, StreamTypePCMATapo);
    mux.writePES(68, 192, Buffer.alloc(1024));
    mux.resetBytes();
    mux.writePES(69, 193, Buffer.alloc(160));
    const ts = packets(mux.resetBytes());
    assert.equal(ts[0][3] & 15, 0);
    assert.equal(decodePts(Buffer.concat(ts.map(payload))), 0);
    mux.writePES(68, 192, Buffer.alloc(1024));
    assert.equal(decodePts(Buffer.concat(packets(mux.resetBytes()).map(payload))), 11520);
});

test('PTS wraps at 2^33 and is derived from total samples', () => {
    const mux = writer();
    const stream = (mux as any).streams.get(68);
    stream.samples = 2 ** 33 - 512;
    mux.writePES(68, 192, Buffer.alloc(1024));
    const pts = decodePts(Buffer.concat(packets(mux.resetBytes()).map(payload)));
    const expected = Number((BigInt(stream.samples - 1024) * 90000n / 8000n) % (1n << 33n));
    assert.equal(pts, expected);
    assert.ok(pts >= 0 && pts < 2 ** 33);
});

test('writePES rejects unknown PIDs and oversized payloads', () => {
    const mux = writer();
    assert.throws(() => mux.writePES(99, 192, Buffer.alloc(1)), /Unknown elementary stream PID/);
    assert.throws(() => mux.writePES(68, 192, Buffer.alloc(65528)), /too large/);
    assert.doesNotThrow(() => mux.writePES(68, 192, Buffer.alloc(65527)));
});

test('writePMT requires an elementary stream', () => {
    assert.throws(() => new MpegTSWriter().writePMT(), /Add an elementary stream/);
});
