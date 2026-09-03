import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The character and chat routes read these values while importing their modules.
process.env.SILLYTAVERN_PERFORMANCE_MEMORYCACHECAPACITY = '100mb';
process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS = 'false';
process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-chats-'));
const configPath = path.join(testDirectory, 'config.yaml');
fs.writeFileSync(configPath, '{}\n');
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configPath);

let server;
let baseUrl;
let directories;

function writeChat(fileName, message) {
    const data = [
        JSON.stringify({ user_name: 'User', character_name: 'Char', chat_metadata: {} }),
        JSON.stringify({ name: 'Char', mes: message, send_date: '2026-01-01T00:00:00.000Z' }),
    ].join('\n');
    fs.writeFileSync(path.join(directories.chats, 'char', fileName), data);
}

beforeAll(async () => {
    const root = path.join(testDirectory, 'user');
    directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
    };
    fs.mkdirSync(path.join(directories.chats, 'char'), { recursive: true });
    fs.mkdirSync(directories.characters, { recursive: true });

    for (let index = 0; index < 16; index++) {
        writeChat(`chat-${index}.jsonl`, `Message ${index}`);
    }

    const { default: express } = await import('express');
    const { router } = await import('../src/endpoints/characters.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'test-user' }, directories };
        next();
    });
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(testDirectory, { recursive: true, force: true });
});

describe('POST /chats', () => {
    test('preserves every chat while limiting simultaneous file streams', async () => {
        const originalCreateReadStream = fs.createReadStream;
        let activeStreams = 0;
        let peakStreams = 0;
        const streamSpy = jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
            const stream = originalCreateReadStream(...args);
            activeStreams++;
            peakStreams = Math.max(peakStreams, activeStreams);
            stream.once('close', () => activeStreams--);
            return stream;
        });

        const response = await fetch(`${baseUrl}/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: 'char.png' }),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toHaveLength(16);
        expect(body).toEqual(expect.arrayContaining([
            expect.objectContaining({ file_name: 'chat-0.jsonl', mes: 'Message 0' }),
            expect.objectContaining({ file_name: 'chat-15.jsonl', mes: 'Message 15' }),
        ]));
        expect(peakStreams).toBeLessThanOrEqual(8);
        streamSpy.mockRestore();
    });
});
