import assert from 'node:assert/strict';
import test from 'node:test';
import net, { AddressInfo } from 'net';
import { VigiApi, TalkMode } from '../src/vigi-api';

function writeDeviceJson(socket: NodeJS.WritableStream, seq: number, params: any) {
    const body = Buffer.from(JSON.stringify({
        type: 'response',
        seq,
        params,
    }));

    socket.write('----device-stream-boundary--\r\n');
    socket.write('Content-Type: application/json\r\n');
    socket.write(`Content-Length: ${body.length}\r\n\r\n`);
    socket.write(body);
    socket.write('\r\n');
}

for (const mode of ['aec', 'half_duplex'] as TalkMode[]) {
    test(`VigiApi authenticates and writes ${mode} talk audio multipart data`, async t => {
        let sawAuthorization = false;
        let sawTalkRequest = false;
        let sawAudio = false;

        const server = net.createServer(socket => {
            let buffer = Buffer.alloc(0);
            let sentHttpResponse = false;
            let authenticated = false;
            let sentTalkResponse = false;

            socket.on('data', data => {
                buffer = Buffer.concat([buffer, data]);

                if (!sentHttpResponse) {
                    const headerEnd = buffer.indexOf('\r\n\r\n');
                    if (headerEnd === -1)
                        return;

                    const request = buffer.subarray(0, headerEnd).toString();
                    buffer = buffer.subarray(headerEnd + 4);
                    sentHttpResponse = true;

                    if (!request.includes('Authorization:')) {
                        socket.write([
                            'HTTP/1.1 401 Unauthorized',
                            'WWW-Authenticate: Digest realm="vigi", qop="auth", nonce="abc", opaque="opaque"',
                            'Content-Length: 0',
                            '',
                            '',
                        ].join('\r\n'));
                        return;
                    }

                    sawAuthorization = request.includes('Digest username="admin"');
                    authenticated = true;
                    socket.write([
                        'HTTP/1.1 200 OK',
                        'Content-Type: multipart/mixed; boundary=--device-stream-boundary--',
                        'Key-Exchange: cipher="AES_128_CBC" username="admin" padding="PKCS7_16" algorithm="MD5" nonce="abc"',
                        'Content-Length: 0',
                        '',
                        '',
                    ].join('\r\n'));
                }

                if (!authenticated)
                    return;

                const text = buffer.toString();
                if (!sentTalkResponse && text.includes('"talk"')) {
                    sentTalkResponse = true;
                    sawTalkRequest = text.includes(`"mode":"${mode}"`);
                    writeDeviceJson(socket, 1, {
                        session_id: 'session-1',
                    });
                }
                if (text.includes('Content-Type: audio/mp2t') && text.includes('X-Session-Id: session-1'))
                    sawAudio = true;
            });
        });

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => server.close());

        const address = server.address() as AddressInfo;
        const api = await VigiApi.connect({
            host: '127.0.0.1',
            port: address.port,
            username: 'admin',
            password: 'password',
        });

        api.processMessages().catch(() => undefined);
        const writable = await api.startMpegTsBackchannel(mode);
        writable.write(Buffer.alloc(188, 0x47));

        await new Promise(resolve => setTimeout(resolve, 50));
        api.close();

        assert.equal(sawAuthorization, true);
        assert.equal(sawTalkRequest, true);
        assert.equal(sawAudio, true);
    });
}

test('busy camera gives an actionable error instead of starting audio', async () => {
    const api = new VigiApi();
    api.request = async () => ({ error_code: -52411 });
    await assert.rejects(api.startMpegTsBackchannel('aec'), /already in use \(-52411\)/);
});

test('invalid talk modes are rejected before sending a camera request', async () => {
    const api = new VigiApi();
    api.request = async () => { assert.fail('invalid mode reached the camera'); };
    await assert.rejects(api.startMpegTsBackchannel('invalid' as TalkMode), /Unsupported/);
});
