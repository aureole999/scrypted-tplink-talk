import { performance } from 'perf_hooks';
import { Writable } from 'stream';
import { MpegTSWriter, StreamTypePCMATapo } from './mpegts-writer';

export const pcmaFrameSamples = 1024;
export const pcmaFrameMilliseconds = pcmaFrameSamples * 1000 / 8000;
const maximumBufferedSamples = pcmaFrameSamples * 8;

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

    constructor(private output: Writable, private clock: Clock = realClock) {
        this.writer.addPES(68, StreamTypePCMATapo);
        this.writer.writePAT();
        this.writer.writePMT();
        output.write(this.writer.resetBytes());
        output.once('close', this.stop);
    }

    pushRtp(rtp: Buffer): void {
        if (this.stopped)
            return;
        const payload = pcmaRtpPayload(rtp);
        if (!payload)
            return;
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
        this.output.off('close', this.stop);
    };

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
        this.writer.writePES(68, 192, this.pending.subarray(0, pcmaFrameSamples));
        this.pending = this.pending.subarray(pcmaFrameSamples);
        this.output.write(this.writer.resetBytes());
        // A delayed event loop must not cause a burst of catch-up frames.
        this.nextSendAt = this.clock.now() + pcmaFrameMilliseconds;
        this.pump();
    }
}
