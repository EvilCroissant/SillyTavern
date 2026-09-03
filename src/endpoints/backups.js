import express from 'express';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { mapWithConcurrency } from '../util.js';
import { CHAT_BACKUPS_PREFIX, getChatInfo } from './chats.js';

export const router = express.Router();

const backupScanConcurrency = 8;

/**
 * @typedef {{version: string, info: Promise<import('./chats.js').ChatInfo>}} BackupInfoCacheEntry
 */

/** @type {Map<string, Map<string, BackupInfoCacheEntry>>} */
const backupInfoCache = new Map();

/**
 * Gets the cache bucket for one user's backup directory.
 * @param {string} directory Backup directory
 * @returns {Map<string, BackupInfoCacheEntry>}
 */
function getBackupInfoCache(directory) {
    let cache = backupInfoCache.get(directory);
    if (!cache) {
        cache = new Map();
        backupInfoCache.set(directory, cache);
    }
    return cache;
}

/**
 * Removes one backup's cached metadata.
 * @param {string} filePath Absolute path to the backup
 */
function removeCachedBackupInfo(filePath) {
    const directory = path.dirname(filePath);
    const cache = backupInfoCache.get(directory);
    if (!cache) {
        return;
    }
    cache.delete(path.basename(filePath));
    if (cache.size === 0) {
        backupInfoCache.delete(directory);
    }
}

/**
 * Gets backup metadata from a versioned in-memory cache. The file's size and
 * modification time are checked on every request so external edits are visible
 * immediately while unchanged backups avoid a full JSONL scan.
 * @param {string} filePath Absolute path to the backup
 * @returns {Promise<import('./chats.js').ChatInfo>}
 */
async function getCachedBackupInfo(filePath) {
    const directory = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const cache = getBackupInfoCache(directory);
    let stats;
    try {
        stats = await fsPromises.stat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            removeCachedBackupInfo(filePath);
            return { match: false };
        }
        throw error;
    }

    const version = `${stats.size}:${stats.mtimeMs}`;
    const cached = cache.get(fileName);
    if (cached?.version === version) {
        return cached.info;
    }

    const entry = { version, info: getChatInfo(filePath, {}, false, null, stats) };
    cache.set(fileName, entry);
    entry.info.catch(() => {
        if (cache.get(fileName) === entry) {
            removeCachedBackupInfo(filePath);
        }
    });
    return entry.info;
}

/**
 * Drops entries for files deleted outside this process and keeps the cache
 * bounded by the current directory contents.
 * @param {string} directory Backup directory
 * @param {string[]} fileNames Current backup filenames
 */
function pruneBackupInfoCache(directory, fileNames) {
    const cache = backupInfoCache.get(directory);
    if (!cache) {
        return;
    }
    const currentFiles = new Set(fileNames);
    for (const fileName of cache.keys()) {
        if (!currentFiles.has(fileName)) {
            cache.delete(fileName);
        }
    }
    if (cache.size === 0) {
        backupInfoCache.delete(directory);
    }
}

router.post('/chat/get', async (request, response) => {
    try {
        const backupFiles = await fsPromises
            .readdir(request.user.directories.backups, { withFileTypes: true })
            .then(d => d.filter(d => d.isFile() && path.extname(d.name) === '.jsonl' && d.name.startsWith(CHAT_BACKUPS_PREFIX)).map(d => d.name));

        pruneBackupInfoCache(request.user.directories.backups, backupFiles);

        const backupModels = await mapWithConcurrency(backupFiles, async (name) => {
            const filePath = path.join(request.user.directories.backups, name);
            return getCachedBackupInfo(filePath);
        }, backupScanConcurrency);

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
        removeCachedBackupInfo(filePath);
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
