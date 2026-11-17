import child_process from 'child_process';
import dgram from 'dgram';
import type { FFmpegInput } from '@scrypted/sdk';
import { VigiError } from './vigi-error';

export interface AudioForwarder {
    kill(): void;
    killPromise: Promise<void>;
}

export function redactLogLine(value: string): string {
    return value
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, '$1***@')
        .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)=)([^&\s]+)/gi, '$1***');
}

export const maxForwarderLogLineBytes = 8192;

// Pipe chunks are not log lines: credentials can straddle any chunk boundary.
// Drop an overlong line in its entirety rather than logging an unsafe prefix.
class RedactedLineLogger {
    private buffer = Buffer.alloc(maxForwarderLogLineBytes);
    private length = 0;
    private discarding = false;

    constructor(private log: (line: string) => void) {
    }

    push(data: Buffer): void {
        let offset = 0;
        while (offset < data.length) {
            const newline = data.indexOf(0x0a, offset);
            const end = newline === -1 ? data.length : newline;
            if (!this.discarding) {
                if (this.length + end - offset > this.buffer.length) {
                    this.length = 0;
                    this.discarding = true;
                    this.log('[ffmpeg log line omitted: too long]');
                }
                else {
                    this.length += data.copy(this.buffer, this.length, offset, end);
                }
            }
            if (newline === -1)
                return;
            this.end();
            offset = newline + 1;
        }
    }

    end(): void {
        if (!this.discarding && this.length) {
            const line = redactLogLine(this.buffer.toString('utf8', 0, this.length)).trim();
            if (line)
                this.log(line);
        }
        this.length = 0;
        this.discarding = false;
    }
}

export interface AudioForwarderDependencies {
    getFFmpegPath: () => Promise<string>;
    // Injectable for tests; production uses child_process.spawn.
    spawn?: typeof child_process.spawn;
    createSocket?: () => dgram.Socket;
    /** SIGKILL fallback delay after SIGTERM. Defaults to 1 second. */
    killTimeoutMilliseconds?: number;
    /** Cancels a pending ffmpeg-path lookup / forwarder startup. */
    signal?: AbortSignal;
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal)
        return promise;
    if (signal.aborted)
        return Promise.reject(new VigiError('VIGI connection aborted.', 'config', { retryable: false }));

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            action();
        };
        const onAbort = () => finish(() => reject(new VigiError('VIGI connection aborted.', 'config', { retryable: false })));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}

export function buildPcmaRtpArguments(ffmpegInput: Pick<FFmpegInput, 'inputArguments' | 'url' | 'urls'>, port: number): string[] {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new VigiError(`Invalid RTP port: ${port}.`, 'config');

    let inputArguments = ffmpegInput.inputArguments || [];
    if (!inputArguments.length) {
        const url = ffmpegInput.url || ffmpegInput.urls?.find(value => !!value);
        if (!url)
            throw new VigiError('FFmpeg input does not include inputArguments or a URL.', 'config');
        inputArguments = ['-i', url];
    }
    if (inputArguments.some(argument => /^pipe:/i.test(argument)))
        throw new VigiError('FFmpeg pipe inputs are not supported by the VIGI talk forwarder; use a live URL or inputArguments with a real input.', 'config');

    return [
        '-hide_banner', '-loglevel', 'warning', '-nostats',
        ...inputArguments,
        // The intercom source is live, so do not add -re: it is only useful
        // for finite files and would slow a live input down.
        '-vn', '-sn', '-dn',
        // VIGI talkback is always G.711 A-law, 8 kHz, mono. 16 kHz is played
        // back at half speed by the camera and is not a usable talkback rate.
        '-acodec', 'pcm_alaw',
        '-ar', '8000',
        '-ac', '1',
        '-f', 'rtp',
        '-payload_type', '8',
        `udp://127.0.0.1:${port}?pkt_size=1200`,
    ];
}

export async function startPcmaRtpForwarder(console: Console, ffmpegInput: FFmpegInput, onRtp: (rtp: Buffer) => void, dependencies: AudioForwarderDependencies): Promise<AudioForwarder> {
    const createSocket = dependencies.createSocket || (() => dgram.createSocket('udp4'));
    const spawn = dependencies.spawn || child_process.spawn;
    const server = createSocket();
    let terminateChild: (() => void) | undefined;
    let serverClosed = false;
    const closeServer = () => {
        if (serverClosed)
            return;
        serverClosed = true;
        try {
            server.close();
        }
        catch {
        }
    };

    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off('error', onError);
                reject(error);
            };
            server.once('error', onError);
            server.bind(0, '127.0.0.1', () => {
                server.off('error', onError);
                resolve();
            });
        });

        server.on('message', onRtp);
        let child: child_process.ChildProcess | undefined;
        let fatalError: Error | undefined;
        let exited = false;
        let killTimer: NodeJS.Timeout | undefined;
        server.on('error', error => {
            fatalError = error;
            console.error('TP-Link audio forwarder socket failed:', error.message);
            if (terminateChild) {
                terminateChild();
            }
            else {
                try {
                    child?.kill('SIGTERM');
                }
                catch {
                }
            }
            closeServer();
        });

        const address = server.address();
        const port = typeof address === 'string' ? undefined : address.port;
        if (!port)
            throw new Error('Failed to allocate UDP port for audio forwarder.');

        const ffmpegPath = ffmpegInput.ffmpegPath
            || await withAbort(dependencies.getFFmpegPath(), dependencies.signal);
        if (fatalError)
            throw fatalError;
        if (dependencies.signal?.aborted)
            throw new Error('VIGI connection aborted.');
        const args = buildPcmaRtpArguments(ffmpegInput, port);
        const cp = spawn(ffmpegPath, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: ffmpegInput.env ? { ...process.env, ...ffmpegInput.env } : process.env,
        });
        child = cp;

        const terminate = () => {
            if (exited)
                return;
            try {
                if (!cp.killed)
                    cp.kill('SIGTERM');
            }
            catch {
            }
            if (!killTimer) {
                killTimer = setTimeout(() => {
                    killTimer = undefined;
                    if (exited)
                        return;
                    try {
                        cp.kill('SIGKILL');
                    }
                    catch {
                    }
                }, dependencies.killTimeoutMilliseconds ?? 1000);
                killTimer.unref();
            }
        };
        terminateChild = terminate;

        const stderr = new RedactedLineLogger(line => console.log(line));
        cp.stderr?.on('data', data => stderr.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        cp.stderr?.once('end', () => stderr.end());

        const killPromise = new Promise<void>(resolve => {
            let settled = false;
            const finish = (error?: Error) => {
                if (settled)
                    return;
                settled = true;
                exited = true;
                if (killTimer)
                    clearTimeout(killTimer);
                killTimer = undefined;
                if (error)
                    console.error('TP-Link audio encoder stopped:', redactLogLine(error.message));
                closeServer();
                resolve();
            };
            cp.once('error', finish);
            cp.once('exit', () => finish());
        });

        // spawn() returns a ChildProcess even for ENOENT/EACCES. Do not report
        // a successful intercom until Node confirms that the encoder spawned.
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                cp.off('spawn', onSpawn);
                cp.off('error', onError);
                cp.off('exit', onExit);
                dependencies.signal?.removeEventListener('abort', onAbort);
            };
            const onSpawn = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const onExit = () => onError(new Error('The TP-Link audio encoder exited during startup.'));
            const onAbort = () => onError(new VigiError('VIGI connection aborted.', 'config', { retryable: false }));
            cp.once('spawn', onSpawn);
            cp.once('error', onError);
            cp.once('exit', onExit);
            dependencies.signal?.addEventListener('abort', onAbort, { once: true });
            if (fatalError)
                onError(fatalError);
            else if (dependencies.signal?.aborted)
                onAbort();
        });
        if (fatalError)
            throw fatalError;
        if (dependencies.signal?.aborted)
            throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
        if (exited)
            throw new Error('The TP-Link audio encoder exited during startup.');

        return {
            kill() {
                terminate();
                closeServer();
            },
            killPromise,
        };
    }
    catch (e) {
        terminateChild?.();
        closeServer();
        if (e instanceof VigiError)
            throw e;
        throw new VigiError(
            e instanceof Error ? e.message : String(e),
            'transport',
            { retryable: true, sent: false },
        );
    }
}
