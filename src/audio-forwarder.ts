import sdk, { FFmpegInput } from '@scrypted/sdk';
import child_process from 'child_process';
import dgram from 'dgram';

export interface AudioForwarder {
    kill(): void;
    killPromise: Promise<void>;
}

export async function startPcmaRtpForwarder(console: Console, ffmpegInput: FFmpegInput, onRtp: (rtp: Buffer) => void): Promise<AudioForwarder> {
    const server = dgram.createSocket('udp4');
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
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.bind(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    server.on('message', onRtp);

    const address = server.address();
    const port = typeof address === 'string' ? undefined : address.port;
    if (!port) {
        closeServer();
        throw new Error('Failed to allocate UDP port for audio forwarder.');
    }

    const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
    const args = [
        '-hide_banner', '-loglevel', 'warning', '-nostats',
        ...(ffmpegInput.inputArguments || []),
        '-vn', '-sn', '-dn',
        '-acodec', 'pcm_alaw',
        '-ar', '8000',
        '-ac', '1',
        '-f', 'rtp',
        '-payload_type', '8',
        `udp://127.0.0.1:${port}?pkt_size=1200`,
    ];

    const cp = child_process.spawn(ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    cp.stderr.on('data', data => console.log(data.toString().trim()));

    const killPromise = new Promise<void>(resolve => {
        cp.once('exit', () => {
            closeServer();
            resolve();
        });
    });

    return {
        kill() {
            if (!cp.killed)
                cp.kill('SIGTERM');
            closeServer();
        },
        killPromise,
    };
}
