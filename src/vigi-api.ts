import { connect, Socket } from 'net';
import { PassThrough, Writable } from 'stream';
import { digestAuthHeader } from './digest-auth';
import { securityEncode } from './security-encode';

export interface VigiConnectOptions {
    host: string;
    port?: number;
    username: string;
    password: string;
}

interface VigiResponse {
    error_code?: number;
    session_id?: string;
    [key: string]: any;
}

export type TalkMode = 'aec' | 'half_duplex';

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
    private seq = 0;
    private requests = new Map<number, Deferred<VigiResponse>>();
    private processMessagesPromise?: Promise<void>;

    static async connect(options: VigiConnectOptions): Promise<VigiApi> {
        if (options.username !== 'admin')
            throw new Error('VIGI two-way audio currently requires the admin account.');
        if (!options.host)
            throw new Error('VIGI host is required.');
        if (!options.password)
            throw new Error('VIGI admin password is required.');

        const port = options.port || 8800;
        const path = '/stream';

        const challenge = await postStream(options.host, port, path);
        if (challenge.statusCode !== 401)
            throw new Error(`Expected 401 status code for VIGI two-way audio init, got ${challenge.statusCode}.`);
        challenge.socket.destroy();

        const wwwAuthenticate = challenge.headers['www-authenticate'];
        const authChallenge = Array.isArray(wwwAuthenticate) ? wwwAuthenticate[0] : wwwAuthenticate;
        if (!authChallenge)
            throw new Error('VIGI camera did not return a Digest authentication challenge.');

        const encodedPassword = securityEncode(options.password);
        const authorization = digestAuthHeader('POST', path, authChallenge, 'admin', encodedPassword);
        const authenticated = await postStream(options.host, port, path, authorization);
        if (authenticated.statusCode !== 200)
            throw new Error(`Expected 200 status code after VIGI authentication, got ${authenticated.statusCode}.`);

        const api = new VigiApi();
        api.stream = authenticated.socket;
        const keyExchange = authenticated.headers['key-exchange'];
        api.keyExchange = Array.isArray(keyExchange) ? keyExchange[0] : keyExchange || '';
        api.stream.on('close', () => api.rejectPending(new Error('VIGI stream closed.')));
        api.stream.on('error', e => api.rejectPending(e));
        return api;
    }

    processMessages(): Promise<void> {
        if (this.processMessagesPromise)
            return this.processMessagesPromise;

        this.processMessagesPromise = this.readMessages();
        this.processMessagesPromise.catch(e => this.rejectPending(e));
        return this.processMessagesPromise;
    }

    async startMpegTsBackchannel(mode: TalkMode = 'aec'): Promise<Writable> {
        if (mode !== 'aec' && mode !== 'half_duplex')
            throw new Error('Unsupported TP-Link talk mode.');
        const response = await this.request({
            talk: {
                mode,
            },
            method: 'get',
        });

        if (response.error_code === -52411)
            throw new Error('The camera talk channel is already in use (-52411). End the other talk session and try again.');
        if (response.error_code)
            throw new Error('Unexpected VIGI talk error: ' + JSON.stringify(response));
        if (!response.session_id)
            throw new Error('VIGI talk response did not include session_id.');

        this.backchannelSessionId = response.session_id;
        const writable = new Writable({
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
        const seq = ++this.seq;
        const request = {
            params,
            seq,
            type: 'request',
        };

        const deferred = new Deferred<VigiResponse>();
        this.requests.set(seq, deferred);

        writeMessage(this.stream, Buffer.from(JSON.stringify(request)), {
            'Content-Type': 'application/json',
        });

        return deferred.promise;
    }

    close(): void {
        this.stream?.destroy();
    }

    private async readMessages(): Promise<void> {
        const pass = new PassThrough();
        this.stream.pipe(pass);

        while (!this.stream.destroyed) {
            const boundary = await readLine(pass);
            if (!boundary)
                continue;
            if (boundary.trim() !== '----device-stream-boundary--')
                throw new Error(`Expected ----device-stream-boundary--, got ${boundary.trim()}.`);

            const headers = await readHeaders(pass);
            const body = await readBody(pass, headers);
            await readLine(pass);

            if (!headers['content-type']?.includes('application/json'))
                continue;

            const json = JSON.parse(body.toString());
            if (json.type !== 'response')
                continue;

            const deferred = this.requests.get(json.seq);
            if (!deferred)
                continue;

            this.requests.delete(json.seq);
            deferred.resolve(json.params || {});
        }
    }

    private rejectPending(error: Error): void {
        for (const deferred of this.requests.values())
            deferred.reject(error);
        this.requests.clear();
    }
}

async function readLine(readable: PassThrough): Promise<string> {
    const chunks: Buffer[] = [];

    while (true) {
        const chunk = readable.read(1) as Buffer;
        if (!chunk) {
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    readable.off('readable', onReadable);
                    readable.off('error', onError);
                    readable.off('end', onEnd);
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
                readable.once('readable', onReadable);
                readable.once('error', onError);
                readable.once('end', onEnd);
            });
            if (readable.readableEnded)
                return Buffer.concat(chunks).toString();
            continue;
        }

        chunks.push(chunk);
        if (chunk[0] !== 0x0A)
            continue;

        return Buffer.concat(chunks).toString().replace(/\r?\n$/, '');
    }
}

async function readHeaders(readable: PassThrough): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    while (true) {
        const line = await readLine(readable);
        if (!line)
            return headers;

        const separator = line.indexOf(':');
        if (separator === -1)
            continue;

        const key = line.substring(0, separator).trim().toLowerCase();
        const value = line.substring(separator + 1).trim();
        headers[key] = value;
    }
}

async function readBody(readable: PassThrough, headers: Record<string, string>): Promise<Buffer> {
    const length = parseInt(headers['content-length'] || '0', 10);
    if (!length)
        return Buffer.alloc(0);

    const chunks: Buffer[] = [];
    let remaining = length;

    while (remaining > 0) {
        const chunk = readable.read(remaining) as Buffer;
        if (!chunk) {
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    readable.off('readable', onReadable);
                    readable.off('error', onError);
                };
                const onReadable = () => {
                    cleanup();
                    resolve();
                };
                const onError = (e: Error) => {
                    cleanup();
                    reject(e);
                };
                readable.once('readable', onReadable);
                readable.once('error', onError);
            });
            continue;
        }

        chunks.push(chunk);
        remaining -= chunk.length;
    }

    return Buffer.concat(chunks);
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

async function postStream(host: string, port: number, path: string, authorization?: string): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    socket: Socket;
}> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, host);
        socket.setNoDelay(true);
        let buffer = Buffer.alloc(0);
        let settled = false;

        const cleanup = () => {
            socket.off('data', onData);
            socket.off('error', onError);
        };
        const onError = (e: Error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(e);
        };
        const onData = (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1)
                return;

            const header = buffer.subarray(0, headerEnd).toString();
            const leftover = buffer.subarray(headerEnd + 4);
            if (leftover.length)
                socket.unshift(leftover);
            const lines = header.split('\r\n');
            const statusLine = lines.shift() || '';
            const statusCode = parseInt(statusLine.split(' ')[1] || '0', 10);
            const headers: Record<string, string> = {};

            for (const line of lines) {
                const separator = line.indexOf(':');
                if (separator === -1)
                    continue;
                headers[line.substring(0, separator).trim().toLowerCase()] = line.substring(separator + 1).trim();
            }

            settled = true;
            cleanup();
            resolve({
                statusCode,
                headers,
                socket,
            });
        };

        socket.once('error', onError);
        socket.on('data', onData);
        socket.once('connect', () => {
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
        });
    });
}
