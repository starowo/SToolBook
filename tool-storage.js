import { MODULE_NAME } from './constants.js';
import { worldInfoCache } from '../../../world-info.js';

/**
 * @typedef {{ enabled: boolean, code: string, valid: boolean, uuid: string }} StoredToolData
 */

/**
 * @typedef {{ entries?: Record<string, any>, originalData?: { entries?: any[] } }} WorldInfoData
 */

const pendingToolData = new Map();

/**
 * @param {string} worldName
 * @param {string|number} uid
 * @returns {string}
 */
function pendingKey(worldName, uid) {
    return `${worldName}::${uid}`;
}

/**
 * @returns {StoredToolData}
 */
export function createEmptyToolData() {
    return {
        enabled: false,
        code: '',
        valid: false,
        uuid: '',
    };
}

/**
 * @param {WorldInfoData | null | undefined} data
 * @returns {Record<string, any> | null}
 */
function getEntryMap(data) {
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return null;
    }

    return /** @type {Record<string, any>} */ (data.entries);
}

/**
 * @param {WorldInfoData | null | undefined} data
 * @param {string|number} uid
 * @returns {any | null}
 */
function getWorldInfoEntry(data, uid) {
    const entries = getEntryMap(data);
    if (!entries) return null;
    return entries[String(uid)] ?? null;
}

/**
 * @param {any} entry
 * @returns {StoredToolData}
 */
function ensureStoredToolData(entry) {
    if (!entry.extensions || typeof entry.extensions !== 'object') {
        entry.extensions = {};
    }

    if (!entry.extensions[MODULE_NAME] || typeof entry.extensions[MODULE_NAME] !== 'object') {
        entry.extensions[MODULE_NAME] = createEmptyToolData();
    }

    return /** @type {StoredToolData} */ (entry.extensions[MODULE_NAME]);
}

/**
 * @param {WorldInfoData | null | undefined} data
 * @param {string|number} uid
 * @param {StoredToolData} stoolbookData
 */
function syncOriginalEntry(data, uid, stoolbookData) {
    const originalEntries = Array.isArray(data?.originalData?.entries)
        ? data.originalData.entries
        : [];

    const originalEntry = originalEntries.find((item) => String(item?.uid) === String(uid));
    if (!originalEntry) return;

    if (!originalEntry.extensions || typeof originalEntry.extensions !== 'object') {
        originalEntry.extensions = {};
    }

    originalEntry.extensions[MODULE_NAME] = stoolbookData;
}

/**
 * @param {string} worldName
 * @param {WorldInfoData | null | undefined} data
 */
function injectPendingToolDataIntoWorldInfo(worldName, data) {
    const entries = getEntryMap(data);
    if (!entries) return;

    for (const [key, stoolbookData] of pendingToolData) {
        if (!key.startsWith(`${worldName}::`)) continue;

        const uid = key.slice(worldName.length + 2);
        const entry = entries[uid];
        if (!entry) continue;

        if (!entry.extensions || typeof entry.extensions !== 'object') {
            entry.extensions = {};
        }

        entry.extensions[MODULE_NAME] = stoolbookData;
        syncOriginalEntry(data, uid, stoolbookData);
    }
}

const originalCacheSet = worldInfoCache.set.bind(worldInfoCache);
worldInfoCache.set = function (name, data) {
    injectPendingToolDataIntoWorldInfo(String(name), /** @type {WorldInfoData | null | undefined} */ (data));
    return originalCacheSet(name, data);
};

/**
 * 从世界书条目中读取 SToolBook 配置
 * @param {string} worldName
 * @param {string|number} uid
 * @returns {Promise<StoredToolData | null>}
 */
export async function loadToolFuncData(worldName, uid) {
    const { loadWorldInfo } = SillyTavern.getContext();
    const data = /** @type {WorldInfoData | null} */ (await loadWorldInfo(worldName));
    const entry = getWorldInfoEntry(data, uid);

    if (!entry) {
        return null;
    }

    const stored = ensureStoredToolData(entry);
    return { ...stored };
}

/**
 * 保存工具函数配置到 entry.extensions.SToolBook 并持久化
 * @param {string} worldName
 * @param {string|number} uid
 * @param {{ enabled: boolean, code: string }} input
 * @param {(code: string) => { valid: boolean, error?: string }} validateToolCode
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
export async function saveToolFuncData(worldName, uid, input, validateToolCode) {
    const { loadWorldInfo, saveWorldInfo, uuidv4 } = SillyTavern.getContext();
    const data = /** @type {WorldInfoData | null} */ (await loadWorldInfo(worldName));
    const entry = getWorldInfoEntry(data, uid);

    if (!entry) {
        toastr.error('找不到对应的世界书条目');
        return { valid: false, error: '条目不存在' };
    }

    const validation = input.code.trim()
        ? validateToolCode(input.code)
        : { valid: false, error: '' };

    /** @type {StoredToolData} */
    const stoolbookData = {
        enabled: Boolean(input.enabled),
        code: String(input.code ?? ''),
        valid: validation.valid,
        uuid: uuidv4(),
    };

    pendingToolData.set(pendingKey(worldName, uid), stoolbookData);

    if (!entry.extensions || typeof entry.extensions !== 'object') {
        entry.extensions = {};
    }

    entry.extensions[MODULE_NAME] = stoolbookData;
    syncOriginalEntry(data, uid, stoolbookData);

    await saveWorldInfo(worldName, data);
    return validation;
}
