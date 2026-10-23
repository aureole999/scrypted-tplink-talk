import { performance } from 'perf_hooks';
import { Writable } from 'stream';
import { MpegTSWriter, StreamTypePCMATapo } from './mpegts-writer';

export const pcmaFrameSamples = 1024;
export const pcmaFrameMilliseconds = pcmaFrameSamples * 1000 / 8000;
const maximumBufferedSamples = pcmaFrameSamples * 8;

export const audioSendModes = {
    paced: '1024 samples / 128 ms',
    vigi: 'VIGI RTP / immediate',
} as const;
export type AudioSendMode = typeof audioSendModes[keyof typeof audioSendModes];

interface Clock {
    now(): number;
    schedule(callback: () => void, milliseconds: number): unknown;
    cancel(timer: unknown): void;
}

const realClock: Clock = {
    now: () => performance.now(),
    schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as NodeJS.Timeout),
};

interface BackchannelOptions {
    mode?: AudioSendMode;
    clock?: Clock;
}

// FFmpeg RTP boundaries are not camera audio frame boundaries.
export function pcmaRtpPayload(rtp: Buffer): Buffer | undefined {
    if (rtp.length < 12 || rtp[0] >> 6 !== 2 || (rtp[1] & 0x7f) !== 8)
        return;
    let offset = 12 + (rtp[0] & 15) * 4;
    if (offset > rtp.length)
        return;
    if (rtp[0] & 0x10) {
        if (offset + 4 > rtp.length)
            return;
        offset += 4 + rtp.readUInt16BE(offset + 2) * 4;
    }
    const padding = rtp[0] & 0x20 ? rtp[rtp.length - 1] : 0;
    if ((rtp[0] & 0x20) && !padding)
        return;
    const end = rtp.length - padding;
    if (offset >= end)
        return;
    return rtp.subarray(offset, end);
}

export class PcmaBackchannel {
    private pending = Buffer.alloc(0);
    private timer?: unknown;
    private stopped = false;
    private nextSendAt = 0;
    private writer = new MpegTSWriter();
    private clock: Clock;
    private mode: AudioSendMode;
    private immediateFrames: Buffer[] = [];
    private immediateSamples = 0;

    constructor(private output: Writable, options: BackchannelOptions = {}) {
        this.clock = options.clock || realClock;
        this.mode = options.mode || audioSendModes.paced;
        this.writer.addPES(68, StreamTypePCMATapo);
        this.writer.writePAT();
        this.writer.writePMT();
        output.write(this.writer.resetBytes());
        output.once('close', this.stop);
        if (this.mode === audioSendModes.vigi)
            output.on('drain', this.flushImmediate);
    }

    pushRtp(rtp: Buffer): void {
        if (this.stopped)
            return;
        if (this.output.destroyed) {
            this.stop();
            return;
        }
        const payload = pcmaRtpPayload(rtp);
        if (!payload)
            return;
        if (this.mode === audioSendModes.vigi) {
            // Match upstream's framing/cadence: one PES per arriving RTP payload,
            // with no 1024-sample aggregation or 128 ms timer.
            this.immediateFrames.push(payload);
            this.immediateSamples += payload.length;
            while (this.immediateSamples > maximumBufferedSamples && this.immediateFrames.length > 1)
                this.immediateSamples -= this.immediateFrames.shift()!.length;
            this.flushImmediate();
            return;
        }
        this.pending = Buffer.concat([this.pending, payload]);
        // UDP cannot be backpressured. Drop old whole audio frames on overload
        // rather than letting live talkback latency grow without a bound.
        if (this.pending.length > maximumBufferedSamples) {
            const drop = Math.ceil((this.pending.length - maximumBufferedSamples) / pcmaFrameSamples) * pcmaFrameSamples;
            this.pending = this.pending.subarray(drop);
        }
        this.pump();
    }

    stop = (): void => {
        this.stopped = true;
        if (this.timer !== undefined)
            this.clock.cancel(this.timer);
        this.timer = undefined;
        this.pending = Buffer.alloc(0);
        this.immediateFrames = [];
        this.immediateSamples = 0;
        this.output.off('close', this.stop);
        this.output.off('drain', this.flushImmediate);
    };

    private flushImmediate = (): void => {
        while (!this.stopped && !this.output.destroyed && !this.output.writableNeedDrain && this.immediateFrames.length) {
            const payload = this.immediateFrames.shift()!;
            this.immediateSamples -= payload.length;
            this.writeFrame(payload);
        }
    };

    private writeFrame(payload: Buffer): void {
        this.writer.writePES(68, 192, payload);
        this.output.write(this.writer.resetBytes());
    }

    private pump(): void {
        if (this.stopped || this.timer !== undefined || this.pending.length < pcmaFrameSamples)
            return;
        if (this.output.destroyed) {
            this.stop();
            return;
        }
        const delay = this.nextSendAt - this.clock.now();
        if (delay > 0 || this.output.writableNeedDrain) {
            this.timer = this.clock.schedule(() => {
                this.timer = undefined;
                this.pump();
            }, delay > 0 ? delay : pcmaFrameMilliseconds);
            return;
        }
        this.writeFrame(this.pending.subarray(0, pcmaFrameSamples));
        this.pending = this.pending.subarray(pcmaFrameSamples);
        // A delayed event loop must not cause a burst of catch-up frames.
        this.nextSendAt = this.clock.now() + pcmaFrameMilliseconds;
        this.pump();
    }
}
