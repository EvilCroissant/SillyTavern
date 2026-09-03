import express from 'express';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_BACKUPS_PREFIX, getChatInfo } from './chats.js';

export const router = express.Router();

const backupScanConcurrency = 8;

/**
 * Scans a large backup directory without serializing I/O or opening all files at once.
 * @template T, R
 * @param {T[]} items Items to process
 * @param {(item: T) => Promise<R>} mapper Async item mapper
 * @returns {Promise<R[]>} Results in input order
 */
async function mapBackupsWithConcurrency(items, mapper) {
    const results = Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index]);
        }
    };

    await Promise.all(Array.from({ length: Math.min(backupScanConcurrency, items.length) }, worker));
    return results;
}

router.post('/chat/get', async (request, response) => {
    try {
        const backupFiles = await fsPromises
            .readdir(request.user.directories.backups, { withFileTypes: true })
            .then(d => d.filter(d => d.isFile() && path.extname(d.name) === '.jsonl' && d.name.startsWith(CHAT_BACKUPS_PREFIX)).map(d => d.name));

        const backupModels = await mapBackupsWithConcurrency(backupFiles, async (name) => {
            const filePath = path.join(request.user.directories.backups, name);
            return getChatInfo(filePath);
        });

        return response.json(backupModels.filter(info => info?.file_name));
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/delete', async (request, response) => {
    try {
        const { name } = request.body;
        const filePath = path.join(request.user.directories.backups, sanitize(name));

        if (!path.parse(filePath).base.startsWith(CHAT_BACKUPS_PREFIX)) {
            console.warn('Attempt to delete non-chat backup file:', name);
            return response.sendStatus(400);
        }

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        await fsPromises.unlink(filePath);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/chat/download', async (request, response) => {
    try {
        const { name } = request.body;
        const filePath = path.join(request.user.directories.backups, sanitize(name));

        if (!path.parse(filePath).base.startsWith(CHAT_BACKUPS_PREFIX)) {
            console.warn('Attempt to download non-chat backup file:', name);
            return response.sendStatus(400);
        }

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        return response.download(filePath);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
