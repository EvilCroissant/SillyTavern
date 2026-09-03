import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-get-'));
const configPath = path.join(tempDirectory, 'config.yaml');
fs.writeFileSync(configPath, '{}\n');

// These values are read while settings.js and its dependencies are imported.
process.env.SILLYTAVERN_EXTENSIONS_ENABLED = 'true';
process.env.SILLYTAVERN_EXTENSIONS_AUTOUPDATE = 'false';
process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'false';
process.env.SILLYTAVERN_PERUSERBASICAUTH = 'false';
process.env.SILLYTAVERN_SSO_AUTHELIAAUTH = 'false';
process.env.SILLYTAVERN_SSO_AUTHENTIKAUTH = 'false';
process.env.SILLYTAVERN_SSO_TRUSTEDPROXIES = '["127.0.0.1"]';
process.env.SILLYTAVERN_PERFORMANCE_REQUESTCOMPRESSION_ENABLED = 'true';
process.env.SILLYTAVERN_PERFORMANCE_REQUESTCOMPRESSION_MINPAYLOADSIZE = '1kb';
process.env.SILLYTAVERN_PERFORMANCE_REQUESTCOMPRESSION_MAXPAYLOADSIZE = '2mb';
process.env.SILLYTAVERN_PERFORMANCE_REQUESTCOMPRESSION_TIMEOUT = '1500';

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configPath);

/** @type {import('node:http').Server} */
let server;
let baseUrl;
let directories;

function makeDirectories(root) {
    const names = [
        'novelAI_Settings',
        'openAI_Settings',
        'textGen_Settings',
        'koboldAI_Settings',
        'worlds',
        'themes',
        'movingUI',
        'quickreplies',
        'instruct',
        'context',
        'sysprompt',
        'reasoning',
        'backups',
    ];

    const result = { root };
    for (const name of names) {
        result[name] = path.join(root, name);
        fs.mkdirSync(result[name], { recursive: true });
    }
    return result;
}

function writeJson(directory, name, value) {
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
}

beforeAll(async () => {
    directories = makeDirectories(path.join(tempDirectory, 'user'));
    fs.writeFileSync(path.join(directories.root, 'settings.json'), '{"theme":"dark"}');

    writeJson(directories.novelAI_Settings, 'zeta.json', { name: 'zeta' });
    writeJson(directories.novelAI_Settings, 'Alpha.json', { name: 'alpha' });
    fs.writeFileSync(path.join(directories.novelAI_Settings, 'invalid.json'), '{');

    writeJson(directories.openAI_Settings, 'openai.json', { name: 'openai' });
    writeJson(directories.textGen_Settings, 'textgen.json', { name: 'textgen' });
    writeJson(directories.koboldAI_Settings, 'kobold.json', { name: 'kobold' });

    writeJson(directories.worlds, 'World B.json', {});
    writeJson(directories.worlds, 'world-a.JSON', {});
    fs.writeFileSync(path.join(directories.worlds, 'ignored.txt'), 'ignored');

    writeJson(directories.themes, 'theme.json', { id: 'theme' });
    fs.writeFileSync(path.join(directories.themes, 'invalid.json'), '{');
    writeJson(directories.movingUI, 'moving.json', { id: 'moving' });
    writeJson(directories.quickreplies, 'quick.json', { id: 'quick' });
    writeJson(directories.instruct, 'instruct.json', { id: 'instruct' });
    writeJson(directories.context, 'context.json', { id: 'context' });
    writeJson(directories.sysprompt, 'sysprompt.json', { id: 'sysprompt' });
    writeJson(directories.reasoning, 'reasoning.json', { id: 'reasoning' });

    const { default: express } = await import('express');
    const { router } = await import('../src/endpoints/settings.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: 'test-user' },
            directories,
        };
        next();
    });
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

async function getSettings() {
    const response = await fetch(`${baseUrl}/get`, { method: 'POST' });
    return { response, body: await response.json() };
}

describe('POST /get', () => {
    test('preserves the complete settings payload and ordering', async () => {
        const { response, body } = await getSettings();

        expect(response.status).toBe(200);
        expect(body.settings).toBe('{"theme":"dark"}');
        expect(body.novelai_setting_names).toEqual(['Alpha', 'zeta']);
        expect(body.novelai_settings).toEqual([
            '{"name":"alpha"}',
            '{"name":"zeta"}',
        ]);
        expect(body.openai_setting_names).toEqual(['openai']);
        expect(body.textgenerationwebui_preset_names).toEqual(['textgen']);
        expect(body.koboldai_setting_names).toEqual(['kobold']);
        expect(body.world_names).toEqual(['World B', 'world-a']);
        expect(body.themes).toEqual([{ id: 'theme' }]);
        expect(body.movingUIPresets).toEqual([{ id: 'moving' }]);
        expect(body.quickReplyPresets).toEqual([{ id: 'quick' }]);
        expect(body.instruct).toEqual([{ id: 'instruct' }]);
        expect(body.context).toEqual([{ id: 'context' }]);
        expect(body.sysprompt).toEqual([{ id: 'sysprompt' }]);
        expect(body.reasoning).toEqual([{ id: 'reasoning' }]);
        expect(body).toEqual(expect.objectContaining({
            enable_extensions: true,
            enable_extensions_auto_update: false,
            enable_accounts: false,
            request_compression: {
                enabled: true,
                minPayloadSize: 1024,
                maxPayloadSize: 2 * 1024 * 1024,
                timeout: 1500,
            },
        }));
    });

    test('returns 500 when the settings file is unavailable', async () => {
        fs.renameSync(
            path.join(directories.root, 'settings.json'),
            path.join(directories.root, 'settings.json.missing'),
        );

        try {
            const response = await fetch(`${baseUrl}/get`, { method: 'POST' });
            expect(response.status).toBe(500);
        } finally {
            fs.renameSync(
                path.join(directories.root, 'settings.json.missing'),
                path.join(directories.root, 'settings.json'),
            );
        }
    });
});
