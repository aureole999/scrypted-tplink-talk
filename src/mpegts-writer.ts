export const StreamTypePCMATapo = 0x90;

const packetSize = 188;
const pmtPID = 18;
const ptsWrap = 2 ** 33;

// MPEG-2 PSI uses a non-reflected CRC, unlike the IEEE CRC used by crc-32.
function mpegCrc(data: Buffer): number {
    let crc = 0xffffffff;
    for (const value of data) {
        crc ^= value << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
    }
    return crc;
}

export class MpegTSWriter {
    private buffers: Buffer[] = [];
    private streams = new Map<number, { type: number; samples: number }>();
    private counters = new Map<number, number>();

    resetBytes(): Buffer {
        const data = Buffer.concat(this.buffers);
        this.buffers = [];
        return data;
    }

    addPES(pid: number, streamType: number): void {
        this.streams.set(pid, { type: streamType, samples: 0 });
    }

    writePAT(): void {
        this.writeTable(0, Buffer.from([
            0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0,
            0, 1, 0xe0 | (pmtPID >> 8), pmtPID & 0xff,
        ]));
    }

    writePMT(): void {
        const pids = [...this.streams.keys()];
        if (!pids.length)
            throw new Error('Add an elementary stream before writing the PMT.');
        const sectionLength = 13 + pids.length * 5;
        const entries = pids.flatMap(pid => [
            this.streams.get(pid)!.type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0,
        ]);
        this.writeTable(pmtPID, Buffer.from([
            2, 0xb0 | (sectionLength >> 8), sectionLength & 0xff,
            0, 1, 0xc1, 0, 0, 0xe0 | (pids[0] >> 8), pids[0] & 0xff, 0xf0, 0,
            ...entries,
        ]));
    }

    writePES(pid: number, streamId: number, payload: Buffer): void {
        const stream = this.streams.get(pid);
        if (!stream)
            throw new Error(`Unknown elementary stream PID: ${pid}`);
        if (payload.length > 65527)
            throw new Error('Audio PES payload is too large.');

        // PCMA has one byte per sample at 8 kHz; MPEG PTS runs at 90 kHz.
        // Derive PTS from total samples so fractional ticks do not accumulate error.
        const pts = Math.floor(stream.samples * 90000 / 8000) % ptsWrap;
        const header = Buffer.alloc(14);
        header.set([0, 0, 1, streamId]);
        header.writeUInt16BE(payload.length + 8, 4);
        header.set([0x80, 0x80, 5], 6);
        header[9] = 0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1);
        header[10] = Math.floor(pts / 2 ** 22) & 0xff;
        header[11] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1;
        header[12] = Math.floor(pts / 2 ** 7) & 0xff;
        header[13] = ((pts & 0x7f) << 1) | 1;
        this.writePackets(pid, Buffer.concat([header, payload]));
        if (stream.type === StreamTypePCMATapo)
            stream.samples += payload.length;
    }

    private writeTable(pid: number, section: Buffer): void {
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(mpegCrc(section));
        // The pointer field precedes the section; PSI stuffing is 0xff.
        this.writePackets(pid, Buffer.concat([Buffer.from([0]), section, checksum]), true);
    }

    private writePackets(pid: number, data: Buffer, psi = false): void {
        let first = true;
        while (data.length) {
            const packet = Buffer.alloc(packetSize, 0xff);
            const counter = this.counters.get(pid) || 0;
            this.counters.set(pid, (counter + 1) & 15);
            packet[0] = 0x47;
            packet[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
            packet[2] = pid & 0xff;
            packet[3] = 0x10 | counter;
            const length = Math.min(184, data.length);
            let offset = 4;
            if (!psi && length < 184) {
                packet[3] |= 0x20;
                packet[4] = 183 - length;
                if (packet[4])
                    packet[5] = 0; // adaptation flags, followed by 0xff stuffing
                offset = 188 - length;
            }
            data.copy(packet, offset, 0, length);
            this.buffers.push(packet);
            data = data.subarray(length);
            first = false;
        }
    }
}
