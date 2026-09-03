import { afterAll, beforeAll, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chats.js reads configuration on import. This isolated suite verifies the
// configured global backup cap when distinct chats save concurrently.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'true';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '3';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'false';
process.env.SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS = '50';

/** @type {import('../src/endpoints/chats.js')} */
let chats;
let workDir;

beforeAll(async () => {
    chats = await import('../src/endpoints/chats.js');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-backup-limit-'));
});

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Builds a minimal chat array like the client sends it.
 * @param {string} message Message text
 * @returns {object[]} Chat array
 */
function makeChat(message) {
    return [
        { user_name: 'User', character_name: 'Char', chat_metadata: {} },
        { name: 'Char', is_user: false, mes: message },
    ];
}

describe('chat backup global quota', () => {
    test('keeps the configured cap after concurrent saves to one backup directory', async () => {
        const backupsDir = path.join(workDir, 'backups');
        const chatsDir = path.join(workDir, 'chats');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });

        await Promise.all(Array.from({ length: 12 }, (_, index) => {
            return chats.trySaveChat(
                makeChat(`message ${index}`),
                path.join(chatsDir, `${index}.jsonl`),
                true,
                `test-user-${index}`,
                `Card ${index}`,
                backupsDir,
            );
        }));

        const backupFiles = fs.readdirSync(backupsDir).filter(file => file.startsWith(chats.CHAT_BACKUPS_PREFIX));
        expect(backupFiles).toHaveLength(3);
    });
});
