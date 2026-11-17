import crypto from 'crypto';
import net, { AddressInfo, Socket } from 'net';
import { parseDigestHeader } from '../../src/digest-auth';

export interface MultipartPart {
    headers: Record<string, string>;
    body: Buffer;
}

const clientBoundary = '----client-stream-boundary--\r\n';
const deviceBoundary = '----device-stream-boundary--';

export class ClientMultipartParser {
    private buffer = Buffer.alloc(0);
    private parts: MultipartPart[] = [];

    get parsed(): MultipartPart[] {
        return this.parts;
    }

    feed(data: Buffer): MultipartPart[] {
        this.buffer = Buffer.concat([this.buffer, data]);
        const added: MultipartPart[] = [];

        while (true) {
            // Tolerate stray CRLF between parts.
            while (this.buffer.length >= 2 && this.buffer[0] === 0x0d && this.buffer[1] === 0x0a)
                this.buffer = this.buffer.subarray(2);

            if (!this.buffer.subarray(0, clientBoundary.length).equals(Buffer.from(clientBoundary)))
                break;

            const headerEnd = this.buffer.indexOf('\r\n\r\n', clientBoundary.length);
            if (headerEnd === -1)
                break;

            const headerLines = this.buffer.subarray(clientBoundary.length, headerEnd).toString().split('\r\n');
            const headers: Record<string, string> = {};
            for (const line of headerLines) {
                const separator = line.indexOf(':');
                if (separator === -1)
                    continue;
                headers[line.substring(0, separator).trim().toLowerCase()] = line.substring(separator + 1).trim();
            }

            const contentLength = parseInt(headers['content-length'] || '0', 10);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + contentLength;
            if (this.buffer.length < bodyEnd + 2)
                break;

            const part: MultipartPart = {
                headers,
                body: Buffer.from(this.buffer.subarray(bodyStart, bodyEnd)),
            };
            this.parts.push(part);
            added.push(part);
            this.buffer = this.buffer.subarray(bodyEnd + 2);
        }

        return added;
    }
}

export interface MockCameraOptions {
    /** Reject this many authenticated POSTs with a fresh 401 before accepting. */
    rejectAuthenticatedRequests?: number;
    /** Return this status for every authenticated POST instead of 200. */
    authenticatedStatus?: number;
    /** Sends the 401 response in small chunks. */
    splitHeaders?: boolean;
    /** Omit the Digest challenge entirely. */
    noChallenge?: boolean;
    /** Send a 401 without a WWW-Authenticate header. */
    noChallengeHeader?: boolean;
    /** Send a non-401 status for the first request. */
    initialStatus?: number;
    /** Called for every JSON part. Defaults to a successful session response. */
    onTalk?: (request: any, camera: MockCamera, socket: Socket, connection: MockConnection) => void;
    /** Delay before the default talk response. */
    talkDelayMilliseconds?: number;
    /** Send a benign JSON part in the same TCP write as the 200 headers. */
    sendInitialPartWith200?: boolean;
    /** Split that first part so it spans two reads. */
    splitInitialPartWith200?: boolean;
    /** End the multipart stream immediately in the 200 write. */
    sendClosingDelimiterWith200?: boolean;
    /** Bytes appended after the 401 body (e.g. a stray CRLF). */
    challengeTrailingBytes?: Buffer;
    /** End the server side when the client half-closes, like a real camera. */
    closeOnEnd?: boolean;
    /** Keep the server write side open after the client half-closes. */
    allowHalfOpen?: boolean;
    /** Only one connection may hold a talk session; others get -52411. */
    singleTalkSession?: boolean;
    keyExchange?: string;
    challenge?: string;
}

export interface MockConnection {
    index: number;
    socket: Socket;
    authenticated: boolean;
    authorized: boolean;
    authAttempts: number;
    challengeNonce?: string;
    parts: ClientMultipartParser;
    httpBuffer: Buffer;
    requestCount: number;
    httpRequests: string[];
}

export class MockCamera {
    server: net.Server;
    connections: MockConnection[] = [];
    options: MockCameraOptions;
    expectedPassword = '';
    expectedUsername = 'admin';
    closed = false;
    activeTalkConnectionIndex?: number;
    private authRejectionsRemaining: number;

    constructor(options: MockCameraOptions = {}) {
        this.options = options;
        this.authRejectionsRemaining = options.rejectAuthenticatedRequests || 0;
        this.server = net.createServer({ allowHalfOpen: !!options.allowHalfOpen }, socket => this.handleConnection(socket));
    }

    async listen(): Promise<AddressInfo> {
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        return this.server.address() as AddressInfo;
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const connection of this.connections)
            connection.socket.destroy();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    writePart(socket: Socket, contentType: string, body: Buffer, headers: Record<string, string> = {}) {
        const lines = [
            deviceBoundary,
            `Content-Type: ${contentType}`,
            ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
            `Content-Length: ${body.length}`,
            '',
            '',
        ];
        socket.write(lines.join('\r\n'));
        socket.write(body);
        socket.write('\r\n');
    }

    writeResponse(socket: Socket, seq: number, params: any) {
        this.writePart(socket, 'application/json', Buffer.from(JSON.stringify({
            type: 'response',
            seq,
            params,
        })));
    }

    writePartSplit(socket: Socket, contentType: string, body: Buffer, chunkSize = 5) {
        const header = Buffer.from([
            deviceBoundary,
            `Content-Type: ${contentType}`,
            `Content-Length: ${body.length}`,
            '',
            '',
        ].join('\r\n'));
        const data = Buffer.concat([header, body, Buffer.from('\r\n')]);
        for (let offset = 0; offset < data.length; offset += chunkSize)
            socket.write(data.subarray(offset, Math.min(data.length, offset + chunkSize)));
    }

    private handleConnection(socket: Socket) {
        const connection: MockConnection = {
            index: this.connections.length,
            socket,
            authenticated: false,
            authorized: false,
            authAttempts: 0,
            parts: new ClientMultipartParser(),
            httpBuffer: Buffer.alloc(0),
            requestCount: 0,
            httpRequests: [],
        };
        this.connections.push(connection);

        socket.on('error', () => undefined);
        socket.on('close', () => {
            if (this.activeTalkConnectionIndex === connection.index)
                this.activeTalkConnectionIndex = undefined;
        });
        if (this.options.closeOnEnd)
            socket.on('end', () => socket.end());
        socket.on('data', data => this.handleData(connection, data));
    }

    private handleData(connection: MockConnection, data: Buffer) {
        if (connection.authenticated) {
            this.handleClientStream(connection, data);
            return;
        }

        connection.httpBuffer = Buffer.concat([connection.httpBuffer, data]);
        while (true) {
            const headerEnd = connection.httpBuffer.indexOf('\r\n\r\n');
            if (headerEnd === -1)
                return;

            const request = connection.httpBuffer.subarray(0, headerEnd).toString();
            connection.httpBuffer = connection.httpBuffer.subarray(headerEnd + 4);
            connection.requestCount++;
            connection.httpRequests.push(request);

            if (this.options.initialStatus && connection.requestCount === 1) {
                this.writeRawResponse(connection, this.options.initialStatus, {});
                continue;
            }

            if (!request.includes('Authorization:')) {
                if (this.options.noChallenge) {
                    this.writeRawResponse(connection, 200, {});
                    continue;
                }
                this.writeChallenge(connection);
                continue;
            }

            connection.authAttempts++;
            const authorization = (request.match(/Authorization:\s*(.*)/i) || [])[1] || '';
            connection.authorized = this.verifyDigest(authorization, connection);
            if (!connection.authorized) {
                this.writeChallenge(connection);
                continue;
            }
            if (this.options.authenticatedStatus && this.options.authenticatedStatus !== 200) {
                this.writeRawResponse(connection, this.options.authenticatedStatus, {});
                continue;
            }
            if (this.authRejectionsRemaining > 0) {
                this.authRejectionsRemaining--;
                this.writeChallenge(connection);
                continue;
            }

            connection.authenticated = true;
            const headers = [
                'HTTP/1.1 200 OK',
                'Content-Type: multipart/mixed; boundary=--device-stream-boundary--',
                `Key-Exchange: ${this.options.keyExchange || 'cipher="AES_256_CBC" username="admin" padding="PKCS7_16" algorithm="HKDF" nonce="abc" salt="def"'}`,
                'Content-Length: 0',
                '',
                '',
            ].join('\r\n');
            if (this.options.sendClosingDelimiterWith200) {
                connection.socket.write(Buffer.concat([
                    Buffer.from(headers),
                    Buffer.from('----device-stream-boundary----\r\n'),
                ]));
            }
            else if (this.options.sendInitialPartWith200) {
                // A real camera can send the first multipart part in the same
                // TCP segment as the HTTP headers. This used to re-enter
                // postStream's unshift() path.
                const part = Buffer.from([
                    deviceBoundary,
                    'Content-Type: application/json',
                    'Content-Length: 2',
                    '',
                    '{}',
                ].join('\r\n') + '\r\n');
                if (this.options.splitInitialPartWith200) {
                    // Split inside the boundary line: if the client drops
                    // initialData, the remaining bytes start mid-boundary and
                    // the parser must fail.
                    const splitAt = 10;
                    connection.socket.write(Buffer.concat([Buffer.from(headers), part.subarray(0, splitAt)]));
                    setImmediate(() => connection.socket.write(part.subarray(splitAt)));
                }
                else {
                    connection.socket.write(Buffer.concat([Buffer.from(headers), part]));
                }
            }
            else {
                socketWriteMaybeSplit(connection.socket, headers, !!this.options.splitHeaders);
            }
            // A talk request may already be in the same packet as the
            // authenticated POST headers only if HTTP pipelining was used;
            // the client sends it after receiving 200, so this is normally empty.
            if (connection.httpBuffer.length) {
                const leftover = connection.httpBuffer;
                connection.httpBuffer = Buffer.alloc(0);
                this.handleClientStream(connection, leftover);
            }
        }
    }

    private handleClientStream(connection: MockConnection, data: Buffer) {
        const parts = connection.parts.feed(data);
        for (const part of parts) {
            if (!part.headers['content-type']?.includes('application/json'))
                continue;

            let request: any;
            try {
                request = JSON.parse(part.body.toString());
            }
            catch {
                continue;
            }

            if (this.options.onTalk) {
                this.options.onTalk(request, this, connection.socket, connection);
                continue;
            }

            if (!request?.params?.talk)
                continue;

            if (this.options.singleTalkSession) {
                if (this.activeTalkConnectionIndex !== undefined && this.activeTalkConnectionIndex !== connection.index) {
                    this.writeResponse(connection.socket, request.seq, { error_code: -52411 });
                    continue;
                }
                this.activeTalkConnectionIndex = connection.index;
            }

            const respond = () => this.writeResponse(connection.socket, request.seq, {
                error_code: 0,
                session_id: 'session-1',
            });
            if (this.options.talkDelayMilliseconds)
                setTimeout(respond, this.options.talkDelayMilliseconds);
            else
                respond();
        }
    }

    private writeChallenge(connection: MockConnection) {
        const challenge = this.options.challenge
            || `Digest realm="vigi", qop="auth,auth-int", nonce="nonce-${connection.index}-${connection.authAttempts}", opaque="opaque"`;
        connection.challengeNonce = parseDigestHeader(challenge).nonce;
        const body = 'nope\r\n\r\n';
        const response = Buffer.concat([
            Buffer.from([
                'HTTP/1.1 401 Unauthorized',
                ...(this.options.noChallengeHeader ? [] : [`WWW-Authenticate: ${challenge}`]),
                `Content-Length: ${Buffer.byteLength(body)}`,
                '',
                body,
            ].join('\r\n')),
            this.options.challengeTrailingBytes || Buffer.alloc(0),
        ]);
        if (this.options.splitHeaders) {
            for (let offset = 0; offset < response.length; offset += 7)
                connection.socket.write(response.subarray(offset, Math.min(response.length, offset + 7)));
        }
        else {
            connection.socket.write(response);
        }
    }

    private writeRawResponse(connection: MockConnection, status: number, headers: Record<string, string>) {
        const lines = [
            `HTTP/1.1 ${status} Mock`,
            ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
            'Content-Length: 0',
            '',
            '',
        ];
        connection.socket.write(lines.join('\r\n'));
    }

    verifyDigest(authorization: string, connection: MockConnection): boolean {
        if (!authorization.startsWith('Digest '))
            return false;
        const values = parseDigestHeader(authorization);
        if (!values.realm || !values.nonce || !values.uri || !values.response)
            return false;
        if (values.username !== this.expectedUsername)
            return false;
        // Model nonce-to-connection binding: a nonce issued on one socket must
        // not be accepted on another.
        if (values.nonce !== connection.challengeNonce)
            return false;

        const md5 = (value: string) => crypto.createHash('md5').update(value).digest('hex');
        const ha1 = md5(`${values.username}:${values.realm}:${this.expectedPassword}`);
        const ha2 = md5(`POST:${values.uri}`);
        let expected: string;
        if (values.qop) {
            expected = md5(`${ha1}:${values.nonce}:${values.nc}:${values.cnonce}:${values.qop}:${ha2}`);
        }
        else {
            expected = md5(`${ha1}:${values.nonce}:${ha2}`);
        }
        return values.response === expected;
    }
}

function socketWriteMaybeSplit(socket: Socket, data: string, split: boolean) {
    if (!split) {
        socket.write(data);
        return;
    }
    // Split inside header names/values to exercise incremental parsing.
    for (let offset = 0; offset < data.length; offset += 7)
        socket.write(data.substring(offset, Math.min(data.length, offset + 7)));
}
