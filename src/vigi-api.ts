import { connect, Socket } from 'net';
import { PassThrough, Writable } from 'stream';
import { digestAuthHeader } from './digest-auth';
import { securityEncode } from './security-encode';
import { backchannelHighWaterMark } from './pcma-backchannel';
import { VigiError } from './vigi-error';
import type { VigiErrorKind } from './vigi-error';

export interface VigiConnectOptions {
    host: string;
    port?: number;
    username: string;
    password: string;
    /** How long to wait for the camera's JSON response. Defaults to 10 seconds. */
    requestTimeoutMilliseconds?: number;
    /** How long to wait for the HTTP handshake response. Defaults to 10 seconds. */
    handshakeTimeoutMilliseconds?: number;
}

interface VigiResponse {
    error_code?: number | string;
    session_id?: string;
    [key: string]: any;
}

export type TalkMode = 'aec' | 'half_duplex';

export function normalizeTalkMode(value: unknown): TalkMode {
    // Legacy/unknown stored values safely use the default AEC mode.
    return value === 'half_duplex' ? 'half_duplex' : 'aec';
}

// JSON responses are small. Video parts are ignored, so they are streamed
// through a discard path instead of being buffered.
export const maxJsonBodyBytes = 1 * 1024 * 1024;
export const maxDiscardedBodyBytes = 32 * 1024 * 1024;
export const maxProtocolLineBytes = 8 * 1024;
export const maxProtocolHeaderBytes = 32 * 1024;
export const maxProtocolHeaderCount = 64;
export const maxHandshakeBodyBytes = 64 * 1024;

function boundedTimeout(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.max(1, Math.min(60_000, Math.round(parsed)));
}

class Deferred<T> {
    promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: any) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

export class VigiApi {
    stream!: Socket;
    keyExchange = '';
    backchannelSessionId?: string;
    private initialData?: Buffer;
    private abortSignal?: AbortSignal;
    private streamEnded?: Error;
    private closing = false;
    private seq = 0;
    private requests = new Map<number, Deferred<VigiResponse>>();
    private processMessagesPromise?: Promise<void>;
    private requestTimeoutMilliseconds = 10000;

    static async connect(options: VigiConnectOptions, signal?: AbortSignal): Promise<VigiApi> {
        if (signal?.aborted)
            throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
        if (options.username !== 'admin')
            throw new VigiError('VIGI two-way audio currently requires the admin account.', 'config');
        if (!options.host)
            throw new VigiError('VIGI host is required.', 'config');
        if (!options.password)
            throw new VigiError('VIGI admin password is required.', 'config');

        const port = options.port || 8800;
        const path = '/stream';
        const handshakeTimeoutMilliseconds = boundedTimeout(options.handshakeTimeoutMilliseconds, 10000);
        let lastError: Error | undefined;

        // One fresh challenge/connection retry: some firmware binds the Digest
        // nonce to the TCP connection. Keep this bounded to two password
        // attempts so a wrong password cannot contribute to an account lockout.
        for (let attempt = 0; attempt < 2; attempt++) {
            if (signal?.aborted)
                throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
            // The challenge and the authenticated POST must use the same TCP
            // connection. Some camera firmwares bind the Digest nonce to the
            // connection; reusing a nonce from a discarded socket then fails
            // with a second 401.
            let challenge;
            try {
                challenge = await postStream(options.host, port, path, undefined, undefined, handshakeTimeoutMilliseconds, signal);
            }
            catch (e) {
                lastError = asVigiError(e);
                if (lastError instanceof VigiError && lastError.kind === 'protocol')
                    throw lastError;
                continue;
            }
            if (challenge.statusCode !== 401) {
                challenge.socket.destroy();
                throw new VigiError(
                    `Expected 401 status code for VIGI two-way audio init, got ${challenge.statusCode}.`,
                    'protocol',
                    { status: challenge.statusCode },
                );
            }

            const wwwAuthenticate = challenge.headers['www-authenticate'];
            const authChallenge = Array.isArray(wwwAuthenticate) ? wwwAuthenticate[0] : wwwAuthenticate;
            if (!authChallenge) {
                challenge.socket.destroy();
                throw new VigiError('VIGI camera did not return a Digest authentication challenge.', 'protocol');
            }

            const encodedPassword = securityEncode(options.password);
            let authorization: string;
            try {
                authorization = digestAuthHeader('POST', path, authChallenge, 'admin', encodedPassword);
            }
            catch (e) {
                challenge.socket.destroy();
                throw e;
            }

            let authenticated;
            try {
                // Do not feed challenge.leftover into the authenticated HTTP
                // response parser: a trailing CRLF/chunk terminator would
                // become part of the 200 status line. The camera sends the
                // 401 body with an exact Content-Length.
                authenticated = await postStream(options.host, port, path, authorization, challenge.socket, handshakeTimeoutMilliseconds, signal);
            }
            catch (e) {
                challenge.socket.destroy();
                lastError = asVigiError(e);
                if (lastError instanceof VigiError && lastError.kind === 'protocol')
                    throw lastError;
                continue;
            }

            if (authenticated.statusCode === 200) {
                if (signal?.aborted) {
                    authenticated.socket.destroy();
                    throw new VigiError('VIGI connection aborted.', 'config', { retryable: false });
                }
                const api = new VigiApi();
                api.stream = authenticated.socket;
                api.initialData = authenticated.leftover;
                api.abortSignal = signal;
                api.requestTimeoutMilliseconds = boundedTimeout(options.requestTimeoutMilliseconds, 10000);
                const keyExchange = authenticated.headers['key-exchange'];
                api.keyExchange = Array.isArray(keyExchange) ? keyExchange[0] : keyExchange || '';
                api.stream.on('close', () => api.rejectPending(api.closedError()));
                api.stream.on('error', e => api.rejectPending(api.closing ? api.closedError() : asVigiError(e)));
                return api;
            }

            authenticated.socket.destroy();
            const authenticationError = new VigiError(
                `Expected 200 status code after VIGI authentication, got ${authenticated.statusCode}.`,
                authenticated.statusCode === 401 || authenticated.statusCode === 403 ? 'auth' : 'protocol',
                { status: authenticated.statusCode },
            );
            // Only a 401 gets the single fresh-nonce retry. A 403 or a server
            // failure is not a nonce problem; repeating the password can only
            // count toward an account lockout.
            if (authenticated.statusCode !== 401)
                throw authenticationError;
            lastError = authenticationError;
        }

        throw lastError || new Error('VIGI authentication failed.');
    }

    processMessages(): Promise<void> {
        if (this.processMessagesPromise)
            return this.processMessagesPromise;

        this.processMessagesPromise = this.readMessages();
        this.processMessagesPromise.catch(e => this.rejectPending(e));
        return this.processMessagesPromise;
    }

    async startMpegTsBackchannel(mode: TalkMode = 'aec', channel?: number): Promise<Writable> {
        if (mode !== 'aec' && mode !== 'half_duplex')
            throw new VigiError('Unsupported TP-Link talk mode.', 'config');
        // Channels are 0..256.
        if (channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel > 256))
            throw new VigiError('Unsupported VIGI channel (expected an integer from 0 to 256).', 'config');
        // Reading is idempotent and must be running before the talk response
        // can be observed.
        this.processMessages().catch(() => undefined);
        const talk: { mode: TalkMode; channel?: number } = { mode };
        // Standalone cameras use channel 0 and the verified talk request omits
        // it. Only send the field when targeting a non-zero NVR channel.
        if (channel !== undefined && channel > 0)
            talk.channel = channel;
        const response = await this.request({
            talk,
            method: 'get',
        });

        const errorCode = response.error_code;
        if (errorCode === -52411 || errorCode === '-52411')
            throw new VigiError(
                'The camera talk channel is already in use (-52411). End the other talk session and try again.',
                'camera',
                { code: -52411, retryable: false },
            );
        if (errorCode !== undefined && errorCode !== 0 && errorCode !== '0') {
            const numericCode = Number(errorCode);
            throw new VigiError(
                'Unexpected VIGI talk error: ' + JSON.stringify(response),
                'camera',
                { code: Number.isFinite(numericCode) ? numericCode : undefined, retryable: false },
            );
        }
        if (!response.session_id)
            throw new VigiError('VIGI talk response did not include session_id.', 'protocol');

        this.backchannelSessionId = response.session_id;
        const writable = new Writable({
            // Keep the socket queue small so a stalled camera cannot add
            // seconds of stale audio behind the application-level queue.
            highWaterMark: backchannelHighWaterMark,
            write: (data: Buffer, _encoding, callback) => {
                writeMessage(this.stream, data, {
                    'Content-Type': 'audio/mp2t',
                    'X-If-Encrypt': '0',
                    'X-Session-Id': this.backchannelSessionId,
                }, callback);
            },
        });

        this.stream.on('close', () => writable.destroy());
        return writable;
    }

    async request(params: any): Promise<VigiResponse> {
        if (this.closing)
            throw new VigiError('The VIGI connection is closed.', 'config');
        // Preserve a camera-side failure as a transport error; only a local
        // close is reported as a configuration/closed state.
        if (this.streamEnded)
            throw this.streamEnded;
        if (!this.stream || this.stream.destroyed)
            throw new VigiError('VIGI stream is not connected.', 'config');
        if (this.stream.writableEnded)
            throw new VigiError('VIGI stream is closing.', 'config');

        const seq = ++this.seq;
        const request = {
            params,
            seq,
            type: 'request',
        };

        const deferred = new Deferred<VigiResponse>();
        this.requests.set(seq, deferred);
        let sent = false;
        const timeout = setTimeout(() => {
            if (this.requests.delete(seq))
                deferred.reject(new VigiError(
                    `Timed out waiting for VIGI response to request ${seq}.`,
                    'transport',
                    { retryable: false, sent },
                ));
        }, this.requestTimeoutMilliseconds);
        timeout.unref();

        const signal = this.abortSignal;
        const onAbort = () => {
            // Only tear down the connection if this request was still
            // pending. An abort after a response must not kill a subsequent
            // request on a reused API instance.
            if (this.requests.delete(seq)) {
                deferred.reject(new VigiError(
                    'VIGI connection aborted.',
                    'transport',
                    { retryable: false, sent },
                ));
                this.stream?.destroy();
            }
        };
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        deferred.promise.then(cleanup, cleanup);
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return deferred.promise;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
            writeMessage(this.stream, Buffer.from(JSON.stringify(request)), {
                'Content-Type': 'application/json',
            });
            sent = true;
        }
        catch (e) {
            this.requests.delete(seq);
            cleanup();
            throw asVigiError(e, 'transport');
        }

        return deferred.promise;
    }

    close(graceful = false): Promise<void> {
        if (!this.stream)
            return Promise.resolve();
        this.closing = true;
        if (!graceful || this.stream.destroyed) {
            this.stream.destroy();
            return Promise.resolve();
        }

        return new Promise<void>(resolve => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.stream.off('close', finish);
                if (!this.stream.destroyed)
                    this.stream.destroy();
                resolve();
            };
            // Give queued tail audio a moment to reach the camera before
            // tearing the socket down. The camera releases the talk session
            // when the socket closes, so callers that are about to reconnect
            // should await this promise.
            const timer = setTimeout(finish, 500);
            timer.unref();
            this.stream.once('close', finish);
            if (!this.stream.writableEnded)
                this.stream.end();
        });
    }

    private async readMessages(): Promise<void> {
        const pass = new PassThrough();
        pass.on('error', () => { /* delivered to the pending read, if any */ });
        // Bytes that arrived in the same TCP read as the HTTP 200 belong to
        // the multipart body, not to HTTP. Seed them before the socket pipe.
        if (this.initialData?.length) {
            pass.write(this.initialData);
            this.initialData = undefined;
        }
        // Errors are not forwarded by pipe(); destroy the pass-through so a
        // pending readLine/readBody cannot wait forever after a socket error.
        const onError = (e: Error) => pass.destroy(e);
        const onClose = () => pass.destroy();
        this.stream.on('error', onError);
        this.stream.on('close', onClose);
        this.stream.pipe(pass);

        try {
            while (!this.stream.destroyed && !pass.destroyed) {
                let boundary = await readLine(pass);
                // Tolerate blank lines before a boundary.
                while (boundary === '')
                    boundary = await readLine(pass);
                if (boundary === undefined) {
                    const error = new VigiError('VIGI stream ended.', 'transport');
                    this.streamEnded = error;
                    this.rejectPending(error);
                    // A normal socket close is handled by the 'close' listener
                    // and main's close hook. A half-open readable side is not:
                    // throw so the session is torn down instead of lingering.
                    if (!this.stream.destroyed)
                        throw error;
                    return;
                }
                const delimiter = boundary.trim();
                if (delimiter === '----device-stream-boundary----') {
                    // A clean MIME close means the camera ended the talk
                    // stream. Reject anything still waiting and let main tear
                    // the session down instead of waiting for the request
                    // timeout.
                    const error = new VigiError('VIGI device stream ended.', 'transport');
                    this.rejectPending(error);
                    throw error;
                }
                if (delimiter !== '----device-stream-boundary--')
                    throw new VigiError(`Expected ----device-stream-boundary--, got ${delimiter}.`, 'protocol');

                const headers = await readHeaders(pass);
                const keepBody = headers['content-type']?.includes('application/json') ?? false;
                const body = await readBody(pass, headers, keepBody);
                await readLine(pass);

                if (!keepBody)
                    continue;

                let json: any;
                try {
                    json = JSON.parse(body.toString());
                }
                catch {
                    throw new VigiError('The camera sent malformed JSON.', 'protocol');
                }
                // A null/array/scalar JSON part is not a response envelope.
                // Treat it as malformed instead of letting `json.type` throw a
                // TypeError that would surface as a transport failure.
                if (!json || typeof json !== 'object' || Array.isArray(json))
                    throw new VigiError('The camera sent a non-object JSON part.', 'protocol');
                if (json.type !== 'response')
                    continue;

                const deferred = this.requests.get(json.seq);
                if (!deferred)
                    continue;

                this.requests.delete(json.seq);
                deferred.resolve(json.params || {});
            }
        }
        catch (e) {
            this.streamEnded = asVigiError(e, 'transport');
            throw this.streamEnded;
        }
        finally {
            this.stream.off('error', onError);
            this.stream.off('close', onClose);
            pass.destroy();
        }
    }

    private closedError(): VigiError {
        // A local close/stop is not a camera failure; keep it distinct so a
        // stop does not surface as a transport error from the talk session.
        return this.closing
            ? new VigiError('The VIGI connection is closed.', 'config')
            : new VigiError('VIGI stream closed.', 'transport');
    }

    private rejectPending(error: Error): void {
        for (const deferred of this.requests.values())
            deferred.reject(error);
        this.requests.clear();
    }
}

async function readLine(readable: PassThrough): Promise<string | undefined> {
    // One bounded allocation, not one retained Buffer object per input byte.
    const line = Buffer.alloc(maxProtocolLineBytes);
    let length = 0;
    const result = () => length ? line.toString('utf8', 0, length).replace(/\r?\n$/, '') : undefined;

    while (true) {
        const chunk = readable.read(Math.min(readable.readableLength, maxProtocolLineBytes - length + 1)) as Buffer;
        if (!chunk) {
            const errored = readableErrored(readable);
            if (errored)
                throw errored;
            if (readable.destroyed || readable.readableEnded)
                return result();

            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    readable.off('readable', onReadable);
                    readable.off('error', onError);
                    readable.off('end', onEnd);
                    readable.off('close', onClose);
                };
                const onReadable = () => {
                    cleanup();
                    resolve();
                };
                const onError = (e: Error) => {
                    cleanup();
                    reject(e);
                };
                const onEnd = () => {
                    cleanup();
                    resolve();
                };
                const onClose = () => {
                    cleanup();
                    resolve();
                };
                readable.once('readable', onReadable);
                readable.once('error', onError);
                readable.once('end', onEnd);
                readable.once('close', onClose);
            });

            const postWaitError = readableErrored(readable);
            if (postWaitError)
                throw postWaitError;
            if (readable.destroyed)
                return result();
            if (readable.readableEnded)
                return result();
            continue;
        }

        const newline = chunk.indexOf(0x0a);
        const used = newline === -1 ? chunk.length : newline + 1;
        if (length + used > maxProtocolLineBytes)
            throw new VigiError('The camera protocol line is too large.', 'protocol');
        chunk.copy(line, length, 0, used);
        length += used;
        if (newline !== -1) {
            if (used < chunk.length)
                readable.unshift(chunk.subarray(used));
            return result();
        }
    }
}

async function readHeaders(readable: PassThrough): Promise<Record<string, string>> {
    const headers: Record<string, string> = Object.create(null);
    let bytes = 0;
    let count = 0;

    while (true) {
        const line = await readLine(readable);
        if (!line)
            return headers;
        bytes += Buffer.byteLength(line) + 2;
        if (bytes > maxProtocolHeaderBytes || ++count > maxProtocolHeaderCount)
            throw new VigiError('The camera multipart headers are too large.', 'protocol');

        const separator = line.indexOf(':');
        if (separator === -1)
            continue;

        const key = line.substring(0, separator).trim().toLowerCase();
        const value = line.substring(separator + 1).trim();
        headers[key] = value;
    }
}

async function readBody(readable: PassThrough, headers: Record<string, string>, keep: boolean): Promise<Buffer> {
    const rawLength = headers['content-length'];
    if (rawLength === undefined || rawLength.trim() === '')
        throw new VigiError('The camera multipart part is missing Content-Length.', 'protocol');
    const length = Number(rawLength);
    if (!Number.isInteger(length) || length < 0)
        throw new VigiError(`The camera multipart Content-Length is invalid (${rawLength}).`, 'protocol');
    if (length === 0)
        return Buffer.alloc(0);

    const maximum = keep ? maxJsonBodyBytes : maxDiscardedBodyBytes;
    if (length > maximum) {
        throw new VigiError(
            keep
                ? `The camera JSON part is too large (${length} bytes).`
                : `The camera media part is too large (${length} bytes).`,
            'protocol',
            { retryable: false, sent: true },
        );
    }

    const chunks: Buffer[] = [];
    let remaining = length;

    while (remaining > 0) {
        // read(n) returns null when fewer than n bytes are buffered, so read
        // only what is available and accumulate it. Asking for the whole
        // remaining body can make the readable event resolve repeatedly and
        // spin the event loop on a fragment.
        const chunk = readable.read(Math.min(remaining, readable.readableLength)) as Buffer;
        if (!chunk) {
            const errored = readableErrored(readable);
            if (errored)
                throw errored;
            if (readable.destroyed || readable.readableEnded)
                throw new VigiError('VIGI stream ended while reading a multipart body.', 'transport');

            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    readable.off('readable', onReadable);
                    readable.off('error', onError);
                    readable.off('end', onEnd);
                    readable.off('close', onClose);
                };
                const onReadable = () => {
                    cleanup();
                    resolve();
                };
                const onError = (e: Error) => {
                    cleanup();
                    reject(e);
                };
                const onEnd = () => {
                    cleanup();
                    reject(new VigiError('VIGI stream ended while reading a multipart body.', 'transport'));
                };
                const onClose = () => {
                    cleanup();
                    reject(new VigiError('VIGI stream closed while reading a multipart body.', 'transport'));
                };
                readable.once('readable', onReadable);
                readable.once('error', onError);
                readable.once('end', onEnd);
                readable.once('close', onClose);
            });
            continue;
        }

        if (keep)
            chunks.push(chunk);
        remaining -= chunk.length;
    }

    return keep ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function readableErrored(readable: PassThrough): Error | undefined {
    return (readable as PassThrough & { errored?: Error }).errored;
}

function asVigiError(error: unknown, kind: VigiErrorKind = 'transport'): VigiError {
    if (error instanceof VigiError)
        return error;
    return new VigiError(
        error instanceof Error ? error.message : String(error),
        kind,
        { retryable: true },
    );
}

function writeMessage(stream: Socket, body: Buffer, headers: Record<string, string | undefined>, callback?: (error?: Error | null) => void): void {
    const normalized = {
        ...headers,
        'Content-Length': body.length.toString(),
    };

    const lines = Object.entries(normalized)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${value}\r\n`);
    stream.write(Buffer.concat([
        Buffer.from('----client-stream-boundary--\r\n' + lines.join('') + '\r\n'),
        body,
        Buffer.from('\r\n'),
    ]), callback);
}

async function postStream(host: string, port: number, path: string, authorization?: string, existingSocket?: Socket, timeoutMilliseconds = 10000, signal?: AbortSignal): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    socket: Socket;
    leftover: Buffer;
}> {
    return new Promise((resolve, reject) => {
        const socket = existingSocket || connect(port, host);
        socket.setNoDelay(true);
        let buffer = Buffer.alloc(0);
        let settled = false;
        let timeout: NodeJS.Timeout | undefined;

        const cleanup = () => {
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            socket.off('connect', sendRequest);
            signal?.removeEventListener('abort', onAbort);
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
        };
        const onError = (e: Error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            socket.destroy();
            reject(asVigiError(e));
        };
        const onAbort = () => onError(new VigiError(
            'VIGI connection aborted.',
            'config',
            { retryable: false, sent: false },
        ));
        const onClose = () => {
            onError(new VigiError(
                'VIGI stream closed during HTTP handshake.',
                'transport',
                { retryable: true, sent: false },
            ));
        };
        const onData = (data: Buffer) => {
            // 'data' can be emitted again while unshifting/unpausing or when
            // the stream is flowing. The first complete HTTP response wins.
            if (settled)
                return;

            buffer = Buffer.concat([buffer, data]);
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                if (buffer.length > maxProtocolHeaderBytes)
                    onError(new VigiError('The camera HTTP headers are too large.', 'protocol'));
                return;
            }
            if (headerEnd + 4 > maxProtocolHeaderBytes) {
                onError(new VigiError('The camera HTTP headers are too large.', 'protocol'));
                return;
            }

            const header = buffer.subarray(0, headerEnd).toString();
            const lines = header.split('\r\n');
            if (lines.length - 1 > maxProtocolHeaderCount || lines.some(line => Buffer.byteLength(line) + 2 > maxProtocolLineBytes)) {
                onError(new VigiError('The camera HTTP headers are too large.', 'protocol'));
                return;
            }
            const statusLine = lines.shift() || '';
            const statusCode = parseInt(statusLine.split(' ')[1] || '0', 10);
            const headers: Record<string, string> = Object.create(null);

            for (const line of lines) {
                const separator = line.indexOf(':');
                if (separator === -1)
                    continue;
                headers[line.substring(0, separator).trim().toLowerCase()] = line.substring(separator + 1).trim();
            }

            // A 401 can have a small body. Consume it so the next response on
            // this connection is not mistaken for the auth response. A 200 is
            // the start of the multipart stream; any bytes already received
            // after the headers are returned to the caller, never pushed back
            // into a flowing socket (which can re-enter this handler).
            const rawLength = headers['content-length'] ?? '0';
            let bodyLength = 0;
            if (statusCode === 401) {
                bodyLength = Number(rawLength);
                if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(bodyLength) || bodyLength > maxHandshakeBodyBytes) {
                    onError(new VigiError('The camera HTTP challenge body length is invalid or too large.', 'protocol'));
                    return;
                }
            }
            const bodyEnd = headerEnd + 4 + bodyLength;
            if (buffer.length < bodyEnd)
                return;

            settled = true;
            cleanup();
            socket.pause();
            resolve({
                statusCode,
                headers,
                socket,
                leftover: buffer.subarray(bodyEnd),
            });
        };
        const sendRequest = () => {
            const hostHeader = host.includes(':') && !host.startsWith('[')
                ? `[${host}]:${port}`
                : `${host}:${port}`;
            const headers = [
                `POST ${path} HTTP/1.1`,
                `Host: ${hostHeader}`,
                'Connection: keep-alive',
                'Content-Length: 0',
                'Content-Type: multipart/mixed; boundary=--client-stream-boundary--',
            ];

            if (authorization)
                headers.push(`Authorization: ${authorization}`);

            socket.write(headers.join('\r\n') + '\r\n\r\n');
        };

        socket.once('error', onError);
        socket.once('close', onClose);
        socket.on('data', onData);
        signal?.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => onError(new VigiError(
            'VIGI HTTP handshake timed out.',
            'transport',
            { retryable: true, sent: false },
        )), timeoutMilliseconds);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        if (existingSocket) {
            if (existingSocket.destroyed) {
                onError(new Error('VIGI stream closed before authentication.'));
                return;
            }
            if (existingSocket.connecting)
                existingSocket.once('connect', sendRequest);
            else {
                existingSocket.resume();
                sendRequest();
            }
        }
        else {
            socket.once('connect', sendRequest);
        }
    });
}
