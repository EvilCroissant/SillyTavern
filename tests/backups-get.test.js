import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chats.js reads these config values at module load. Environment variables take
// precedence over config.yaml, so the route can be imported in an isolated test directory.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';

let server;
let baseUrl;
let backupsDirectory;

function writeChatBackup(name, message) {
    const data = [
        JSON.stringify({ user_name: 'User', character_name: 'Char', chat_metadata: {} }),
        JSON.stringify({ name: 'Char', mes: message, send_date: '2026-01-01T00:00:00.000Z' }),
    ].join('\n');
    fs.writeFileSync(path.join(backupsDirectory, name), data);
}

beforeAll(async () => {
    backupsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-backups-get-'));
    writeChatBackup('chat_first_20260101.jsonl', 'First backup');
    writeChatBackup('chat_second_20260101.jsonl', 'Second backup');

    const { default: express } = await import('express');
    const { router } = await import('../src/endpoints/backups.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories: { backups: backupsDirectory } };
        next();
    });
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(backupsDirectory, { recursive: true, force: true });
});

async function getBackups() {
    const response = await fetch(`${baseUrl}/chat/get`, { method: 'POST' });
    return { response, body: await response.json() };
}

describe('POST /chat/get', () => {
    test('caches unchanged backup previews and refreshes changed files', async () => {
        const streamSpy = jest.spyOn(fs, 'createReadStream');
        const statSpy = jest.spyOn(fs.promises, 'stat');

        const first = await getBackups();
        expect(first.response.status).toBe(200);
        expect(first.body).toEqual(expect.arrayContaining([
            expect.objectContaining({ file_name: 'chat_first_20260101.jsonl', mes: 'First backup' }),
            expect.objectContaining({ file_name: 'chat_second_20260101.jsonl', mes: 'Second backup' }),
        ]));
        expect(streamSpy).toHaveBeenCalledTimes(2);
        expect(statSpy).toHaveBeenCalledTimes(2);

        const second = await getBackups();
        expect(second.response.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(streamSpy).toHaveBeenCalledTimes(2);
        expect(statSpy).toHaveBeenCalledTimes(4);

        writeChatBackup('chat_second_20260101.jsonl', 'Second backup changed');
        const changed = await getBackups();
        expect(changed.response.status).toBe(200);
        expect(changed.body).toEqual(expect.arrayContaining([
            expect.objectContaining({ file_name: 'chat_second_20260101.jsonl', mes: 'Second backup changed' }),
        ]));
        expect(streamSpy).toHaveBeenCalledTimes(3);
        expect(statSpy).toHaveBeenCalledTimes(6);

        const deleted = await fetch(`${baseUrl}/chat/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'chat_second_20260101.jsonl' }),
        });
        expect(deleted.status).toBe(200);

        const afterDelete = await getBackups();
        expect(afterDelete.body).toEqual([
            expect.objectContaining({ file_name: 'chat_first_20260101.jsonl', mes: 'First backup' }),
        ]);
        expect(streamSpy).toHaveBeenCalledTimes(3);
        expect(statSpy).toHaveBeenCalledTimes(7);
        streamSpy.mockRestore();
        statSpy.mockRestore();
    });
});
