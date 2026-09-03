import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let directories;

function writeJson(directory, fileName, value) {
    fs.writeFileSync(path.join(directory, fileName), JSON.stringify(value));
}

beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-all-'));
    directories = {
        root,
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
    };
    fs.mkdirSync(directories.groups, { recursive: true });
    fs.mkdirSync(directories.groupChats, { recursive: true });

    writeJson(directories.groups, 'group-a.json', { id: 'group-a', chats: ['first', 'missing'] });
    writeJson(directories.groups, 'group-b.json', { id: 'group-b', chats: ['first', 'second', 'first'] });
    writeJson(directories.groups, 'group-c.json', { id: 'group-c', chats: [123] });
    fs.writeFileSync(path.join(directories.groupChats, 'first.jsonl'), 'first');
    fs.writeFileSync(path.join(directories.groupChats, 'second.jsonl'), 'second chat');
    fs.writeFileSync(path.join(directories.groupChats, 'unused.jsonl'), 'unused chat');

    const { default: express } = await import('express');
    const { router } = await import('../src/endpoints/groups.js');
    const app = express();
    app.use((request, _response, next) => {
        request.user = { directories };
        next();
    });
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directories.root, { recursive: true, force: true });
});

describe('POST /all', () => {
    test('preserves group chat statistics without statting unrelated group chats', async () => {
        const statSpy = jest.spyOn(fs.promises, 'stat');
        const response = await fetch(`${baseUrl}/all`, { method: 'POST' });
        const body = await response.json();
        const statPaths = statSpy.mock.calls.map(([filePath]) => filePath);
        statSpy.mockRestore();

        expect(response.status).toBe(200);
        expect(body).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'group-a', chat_size: 5, date_last_chat: expect.any(Number) }),
            expect.objectContaining({ id: 'group-b', chat_size: 16, date_last_chat: expect.any(Number) }),
            expect.objectContaining({ id: 'group-c', chat_size: 0, date_last_chat: 0 }),
        ]));
        expect(statPaths).not.toContain(path.join(directories.groupChats, 'unused.jsonl'));
        expect(body.every(group => typeof group.date_added === 'number' && typeof group.create_date === 'string')).toBe(true);
    });
});
