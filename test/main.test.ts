import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import test from 'node:test';
import vm from 'vm';
import ts from 'typescript';
import { VigiError } from '../src/vigi-error';

// Exercise the actual SDK glue with just the SDK runtime replaced. Loading it
// normally requires a running Scrypted plugin host.
function createMixin(convert: () => Promise<any>, getSettings = async (): Promise<any[]> => []) {
    const filename = path.join(__dirname, '../src/main.ts');
    const localRequire = createRequire(filename);
    class Base {
        console = { log() {}, error() {} };
        mixinDevice = { getSettings };
    }
    class StorageSettings {
        values = { host: 'camera', username: 'admin', password: 'synthetic-password', port: 8800 };
    }
    const sdk = { mediaManager: { convertMediaObjectToJSON: convert } };
    const sandbox = {
        exports: {} as any,
        require(name: string) {
            if (name === '@scrypted/sdk')
                return { __esModule: true, default: sdk, ScryptedDeviceBase: Base, ScryptedMimeTypes: { FFmpegInput: 'ffmpeg' } };
            if (name === '@scrypted/sdk/settings-mixin')
                return { SettingsMixinDeviceBase: Base };
            if (name === '@scrypted/sdk/storage-settings')
                return { StorageSettings };
            return localRequire(name);
        },
        process, console, Buffer, AbortController,
    };
    const source = readFileSync(filename, 'utf8') + '\nexport { TpLinkTalkMixin };';
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
    });
    vm.runInNewContext(outputText, sandbox, { filename });
    const mixin = new sandbox.exports.TpLinkTalkMixin();
    let active = true;
    let starts = 0;
    mixin.session = {
        async stop() { active = false; },
        async start() { active = true; starts++; },
    };
    return { mixin, active: () => active, starts: () => starts };
}

for (const action of ['stopIntercom', 'dispose'] as const) {
    test(`${action} cancels a stalled conversion and skips cancelled queued conversions`, { timeout: 2000 }, async () => {
        let conversions = 0;
        let rejectConversion!: (error: Error) => void;
        const { mixin, active, starts } = createMixin(() => {
            conversions++;
            return new Promise((_resolve, reject) => rejectConversion = reject);
        });
        const pending = Array.from({ length: 3 }, () => mixin.startIntercom({}).catch((e: unknown) => e));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(conversions, 1);
        assert.equal(active(), false, 'replacement stops the old microphone before converting media');

        await mixin[action]();
        const results = await Promise.all(pending);
        assert.ok(results.every(error => error instanceof VigiError && /aborted/.test(error.message)));
        assert.equal(conversions, 1, 'cancelled queued starts must not call the media manager');
        assert.equal(active(), false);
        assert.equal(starts(), 0);
        rejectConversion(new Error('late SDK failure is observed, not unhandled'));
        await new Promise<void>(resolve => setImmediate(resolve));
    });
}

test('stop cancels a stalled settings lookup and a later start still works', { timeout: 2000 }, async () => {
    let lookups = 0;
    let resolveSettings!: (settings: any[]) => void;
    const { mixin, active, starts } = createMixin(
        async () => ({ inputArguments: ['-i', 'unused'] }),
        () => ++lookups === 1 ? new Promise(resolve => resolveSettings = resolve) : Promise.resolve([]),
    );
    const first = mixin.startIntercom({}).catch((e: unknown) => e);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lookups, 1);
    await mixin.stopIntercom();
    assert.match((await first).message, /aborted/);
    resolveSettings([]);
    assert.equal(active(), false);
    await mixin.startIntercom({});
    assert.equal(starts(), 1);
    assert.equal(active(), true);
    await mixin.stopIntercom();
});
