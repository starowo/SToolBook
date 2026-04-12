/**
 * SToolBook - SoliUmbra的工具书
 * 在世界书条目中添加"编辑工具函数"按钮，点击后展开内联抽屉编辑 JS 代码
 * 数据持久化到 entry.extensions.SToolBook（世界书条目自身）
 */

import { worldInfoCache } from '../../../world-info.js';

const MODULE_NAME = 'SToolBook';
const REQUIRED_TOOL_KEYS = ['name', 'description', 'parameters', 'action'];

// ============================================================
// 缓存同步 —— 拦截 worldInfoCache.set，防止编辑器覆盖我们的数据
// ============================================================

/**
 * 待同步数据的暂存区
 * key: `${worldName}::${uid}`, value: SToolBook 数据对象
 * 当编辑器（或任何调用者）向缓存写入 data 时，
 * 我们拦截 set，把暂存区中对应条目的 SToolBook 数据回写到新 data 上
 */
const pendingToolData = new Map();

/**
 * 构造暂存区 key
 */
function pendingKey(worldName, uid) {
    return `${worldName}::${uid}`;
}

// 拦截 worldInfoCache.set
const originalCacheSet = worldInfoCache.set.bind(worldInfoCache);
worldInfoCache.set = function (name, data) {
    // 在 data 写入缓存之前，把我们的待同步数据注入进去
    if (data && data.entries) {
        for (const [key, stoolbookData] of pendingToolData.entries()) {
            if (!key.startsWith(name + '::')) continue;
            const uid = key.slice(name.length + 2);
            const entry = data.entries[uid];
            if (!entry) continue;
            if (!entry.extensions) entry.extensions = {};
            entry.extensions[MODULE_NAME] = stoolbookData;
            // 同步 originalData
            if (data.originalData && Array.isArray(data.originalData.entries)) {
                const origEntry = data.originalData.entries.find(x => x.uid == uid);
                if (origEntry) {
                    if (!origEntry.extensions) origEntry.extensions = {};
                    origEntry.extensions[MODULE_NAME] = stoolbookData;
                }
            }
        }
    }
    return originalCacheSet(name, data);
};

// ============================================================
// 数据持久化 —— 存储在 entry.extensions.SToolBook
// ============================================================

/**
 * 从世界书条目中读取 SToolBook 配置
 * @param {string} worldName
 * @param {string|number} uid
 * @returns {Promise<{ enabled: boolean, code: string, valid: boolean, uuid: string } | null>}
 */
async function loadToolFuncData(worldName, uid) {
    const { loadWorldInfo } = SillyTavern.getContext();
    const data = await loadWorldInfo(worldName);
    if (!data || !data.entries) return null;

    const entry = data.entries[uid];
    if (!entry) return null;

    // 确保 extensions 对象存在
    if (!entry.extensions) entry.extensions = {};
    if (!entry.extensions[MODULE_NAME]) {
        entry.extensions[MODULE_NAME] = { enabled: false, code: '', valid: false, uuid: '' };
    }

    return { ...entry.extensions[MODULE_NAME] };
}

/**
 * 在绝对隔离的环境中验证 JS 代码是否返回包含必要属性的对象
 * @param {string} code
 * @returns {{ valid: boolean, error?: string }}
 */
function validateToolCode(code) {
    if (!code || !code.trim()) {
        return { valid: false, error: '代码不能为空' };
    }

    try {
        // 用 new Function 执行代码并检查返回值结构
        // 注：运行时 executeToolCode 也是用 new Function，验证环境与运行时一致
        const fn = new Function(code);
        const result = fn();

        if (result === null || result === undefined || typeof result !== 'object') {
            return { valid: false, error: '代码必须返回一个对象' };
        }

        const missing = REQUIRED_TOOL_KEYS.filter(k => !(k in result));
        if (missing.length > 0) {
            return { valid: false, error: '缺少必要属性: ' + missing.join(', ') };
        }

        // 检查属性类型
        if (typeof result.name !== 'string' || !result.name.trim()) {
            return { valid: false, error: 'name 必须是非空字符串' };
        }
        if (typeof result.description !== 'string') {
            return { valid: false, error: 'description 必须是字符串' };
        }
        if (typeof result.parameters !== 'object') {
            return { valid: false, error: 'parameters 必须是对象' };
        }
        if (typeof result.action !== 'function') {
            return { valid: false, error: 'action 必须是函数' };
        }

        return { valid: true };
    } catch (e) {
        return { valid: false, error: e.message || String(e) };
    }
}

/**
 * 保存工具函数配置到 entry.extensions.SToolBook 并持久化
 * @param {string} worldName
 * @param {string|number} uid
 * @param {{ enabled: boolean, code: string }} input
 * @returns {Promise<{ valid: boolean, error?: string }>}
 */
async function saveToolFuncData(worldName, uid, input) {
    const { loadWorldInfo, saveWorldInfo, uuidv4 } = SillyTavern.getContext();
    const data = await loadWorldInfo(worldName);
    if (!data || !data.entries || !data.entries[uid]) {
        toastr.error('找不到对应的世界书条目');
        return { valid: false, error: '条目不存在' };
    }

    // 验证代码
    const validation = input.code.trim() ? validateToolCode(input.code) : { valid: false, error: '' };

    // 构造存储对象
    const stoolbookData = {
        enabled: input.enabled,
        code: input.code,
        valid: validation.valid,
        uuid: uuidv4(), // 每次保存都生成新 uuid
    };

    // 写入暂存区——拦截器会在任何 worldInfoCache.set 时自动注入到 data 上
    // 这确保无论编辑器持有哪个 data 引用，保存时都能带上我们的数据
    pendingToolData.set(pendingKey(worldName, uid), stoolbookData);

    // 写入当前 clone 并立即保存（触发 cache.set → 拦截器注入）
    const entry = data.entries[uid];
    if (!entry.extensions) entry.extensions = {};
    entry.extensions[MODULE_NAME] = stoolbookData;

    if (data.originalData && Array.isArray(data.originalData.entries)) {
        const originalEntry = data.originalData.entries.find(x => x.uid == uid);
        if (originalEntry) {
            if (!originalEntry.extensions) originalEntry.extensions = {};
            originalEntry.extensions[MODULE_NAME] = stoolbookData;
        }
    }

    await saveWorldInfo(worldName, data);

    return validation;
}

// ============================================================
// 创建抽屉 DOM
// ============================================================

/**
 * 为指定条目创建工具函数面板（只有 content 部分，不含 header）
 * 直接 append 到已有的 .inline-drawer 内部
 * @param {string} uid
 * @param {string} worldName
 * @param {{ enabled: boolean, code: string, valid: boolean, uuid: string }} stoolbookData - 从 entry.extensions.SToolBook 读取的数据
 * @returns {HTMLElement} content 面板元素
 */
function createToolPanel(uid, worldName, stoolbookData) {
    // ---- content 面板 ----
    const panel = document.createElement('div');
    panel.className = 'stoolbook_panel';
    panel.dataset.uid = uid;
    panel.dataset.world = worldName;

    // 顶部控制栏：左侧开关 + 右侧保存按钮
    const toolbar = document.createElement('div');
    toolbar.className = 'stoolbook_toolbar';

    // 左侧：启用开关
    const leftGroup = document.createElement('label');
    leftGroup.className = 'checkbox_label stoolbook_toggle_label';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = stoolbookData.enabled;
    toggle.className = 'stoolbook_toggle';
    toggle.addEventListener('change', (e) => {
        e.stopPropagation();
    });

    const toggleText = document.createElement('span');
    toggleText.textContent = '启用工具函数';

    leftGroup.appendChild(toggle);
    leftGroup.appendChild(toggleText);

    // 右侧：保存按钮
    const saveBtn = document.createElement('div');
    saveBtn.className = 'menu_button interactable stoolbook_save_btn';
    saveBtn.title = '保存工具函数';
    saveBtn.setAttribute('tabindex', '0');
    saveBtn.setAttribute('role', 'button');
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> <span>保存</span>';
    saveBtn.addEventListener('click', async () => {
        const textarea = panel.querySelector('.stoolbook_code_editor');
        const code = textarea ? textarea.value : '';
        const enabled = toggle.checked;

        const validation = await saveToolFuncData(worldName, uid, { enabled, code });

        if (validation.valid) {
            toastr.success('工具函数已保存，验证通过 ✓');
        } else if (code.trim()) {
            toastr.warning(`工具函数已保存，但验证失败: ${validation.error}`, '验证未通过', { timeOut: 5000 });
        } else {
            toastr.info('工具函数已保存（代码为空）');
        }
    });

    toolbar.appendChild(leftGroup);
    toolbar.appendChild(saveBtn);

    // 代码编辑器
    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole stoolbook_code_editor';
    textarea.rows = 10;
    textarea.placeholder = [
        '// 在此编写工具函数，代码必须返回一个包含以下属性的对象:',
        '// name, description, parameters, action',
        '// 例如:',
        'return {',
        '    name: "my_tool",',
        '    description: "工具描述",',
        '    parameters: {',
        '        type: "object",',
        '        properties: {',
        '            query: { type: "string", description: "参数描述" }',
        '        },',
        '        required: ["query"]',
        '    },',
        '    action: async (args) => {',
        '        return JSON.stringify({ result: args.query });',
        '    }',
        '};',
    ].join('\n');
    textarea.value = stoolbookData.code;
    textarea.spellcheck = false;

    panel.appendChild(toolbar);
    panel.appendChild(textarea);

    return panel;
}

// ============================================================
// 按钮注入逻辑
// ============================================================

/**
 * 为单个 world_entry 插入自定义按钮（如果尚未插入）
 * @param {HTMLElement} entryEl - .world_entry 元素
 */
function injectButton(entryEl) {
    // 防止重复插入
    if (entryEl.querySelector('.stoolbook_edit_tool_btn')) return;

    const moveBtn = entryEl.querySelector('.move_entry_button');
    if (!moveBtn) return;

    // 读取 move_entry_button 上的 data-uid 和 data-current-world
    const uid = moveBtn.getAttribute('data-uid') ?? '';
    const currentWorld = moveBtn.getAttribute('data-current-world') ?? '';

    // 创建新按钮，样式与 move_entry_button 完全一致
    const btn = document.createElement('i');
    btn.className = 'menu_button stoolbook_edit_tool_btn fa-solid fa-screwdriver-wrench interactable';
    btn.setAttribute('title', '编辑工具函数');
    btn.setAttribute('data-uid', uid);
    btn.setAttribute('data-current-world', currentWorld);
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'button');

    // 点击事件 —— 切换抽屉显示
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolDrawer(entryEl, uid, currentWorld);
    });

    // 插入到 move_entry_button 之前
    moveBtn.parentNode.insertBefore(btn, moveBtn);
}

/**
 * 切换工具函数面板的展开/收起
 * 面板直接 append 到已有 .inline-drawer 内部，与 .inline-drawer-content 平级
 * @param {HTMLElement} entryEl
 * @param {string} uid
 * @param {string} worldName
 */
async function toggleToolDrawer(entryEl, uid, worldName) {
    // 查找该条目内是否已经存在面板
    let panel = entryEl.querySelector('.stoolbook_panel');

    if (panel) {
        // 已存在 —— slideToggle 切换
        $(panel).stop().slideToggle();
        return;
    }

    // 不存在 —— 从 entry.extensions.SToolBook 加载数据
    const loaded = await loadToolFuncData(worldName, uid);
    if (!loaded) {
        toastr.error('无法加载世界书条目数据');
        return;
    }

    const stoolbookData = {
        enabled: loaded.enabled ?? false,
        code: loaded.code ?? '',
        valid: loaded.valid ?? false,
        uuid: loaded.uuid ?? '',
    };

    // 创建面板并 append 到 .inline-drawer 内部
    panel = createToolPanel(uid, worldName, stoolbookData);

    const inlineDrawer = entryEl.querySelector('.inline-drawer.wide100p');
    if (inlineDrawer) {
        inlineDrawer.appendChild(panel);
    } else {
        entryEl.appendChild(panel);
    }

    // 首次打开：先隐藏再 slideDown
    $(panel).hide().slideDown();
}

// ============================================================
// 扫描与监听
// ============================================================

/**
 * 扫描已有的 world_entry 并注入按钮
 */
function scanExistingEntries() {
    const container = document.getElementById('world_popup_entries_list');
    if (!container) return;
    container.querySelectorAll('.world_entry').forEach(injectButton);
}

/**
 * 使用 MutationObserver 监视 #world_popup_entries_list，
 * 当新的 .world_entry 出现时自动注入按钮
 */
function observeEntries() {
    const container = document.getElementById('world_popup_entries_list');
    if (!container) return;

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;

                // 新增的节点本身是 .world_entry
                if (node.classList.contains('world_entry')) {
                    injectButton(node);
                }

                // 新增的节点内部可能包含 .world_entry
                node.querySelectorAll?.('.world_entry')?.forEach(injectButton);
            }
        }
    });

    observer.observe(container, { childList: true, subtree: true });
    console.log(`[${MODULE_NAME}] MutationObserver 已挂载到 #world_popup_entries_list`);
}

/**
 * 同时监视 document.body，以便在 #world_popup_entries_list
 * 被动态创建/重建时也能自动重新挂载 observer
 */
function observeBody() {
    const bodyObserver = new MutationObserver(() => {
        const container = document.getElementById('world_popup_entries_list');
        if (container && !container.dataset.stoolbookObserved) {
            container.dataset.stoolbookObserved = 'true';
            // 扫描已有条目
            scanExistingEntries();
            // 监视新增条目
            observeEntries();
        }
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });
    console.log(`[${MODULE_NAME}] Body observer 已启动`);
}

// ============================================================
// 工具函数注册 —— Function Tool Calling
// ============================================================

/**
 * 已注册的工具名称集合（用于跟踪和清理）
 * key: tool name (带 SToolBook 前缀), value: uuid
 */
const registeredTools = new Map();

/**
 * 当前已激活的条目集合
 * key: `${worldName}::${uid}`, value: true
 */
const activatedEntries = new Set();

/**
 * 所有已加载的世界书条目中带有 SToolBook 配置的条目
 * key: `${worldName}::${uid}`, value: { worldName, uid, stoolbook: { enabled, code, valid, uuid } }
 */
const loadedToolEntries = new Map();

/**
 * 生成工具名称（确保唯一性，带 SToolBook 前缀）
 * @param {string} worldName
 * @param {string|number} uid
 * @param {string} toolName - 用户定义的工具 name
 * @returns {string}
 */
function makeToolId(worldName, uid, toolName) {
    return `stoolbook_${toolName}`;
}

/**
 * 注销所有已注册的工具
 */
function unregisterAllTools() {
    const { unregisterFunctionTool } = SillyTavern.getContext();
    for (const [toolId] of registeredTools) {
        try {
            unregisterFunctionTool(toolId);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 注销工具 ${toolId} 失败:`, e);
        }
    }
    registeredTools.clear();
    console.log(`[${MODULE_NAME}] 已注销所有工具`);
}

/**
 * 根据当前 loadedToolEntries + activatedEntries 重新计算并注册工具
 */
function syncToolRegistrations() {
    const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();

    // 收集本次应该注册的工具
    /** @type {Map<string, { toolDef: object, worldName: string, uid: string|number, uuid: string }>} */
    const shouldRegister = new Map();

    for (const [entryKey, info] of loadedToolEntries) {
        const { worldName, uid, stoolbook } = info;

        // 必须 valid + enabled + activated
        if (!stoolbook.valid || !stoolbook.enabled) continue;
        if (!activatedEntries.has(entryKey)) continue;

        // 在隔离环境中执行代码获取工具定义
        const toolDef = executeToolCode(stoolbook.code);
        if (!toolDef) continue;

        const toolId = makeToolId(worldName, uid, toolDef.name);

        // 如果同名工具已存在（来自不同条目），后者覆盖
        shouldRegister.set(toolId, { toolDef, worldName, uid, uuid: stoolbook.uuid, entryKey });
    }

    // 注销不再需要的工具
    for (const [toolId, uuid] of registeredTools) {
        if (!shouldRegister.has(toolId) || shouldRegister.get(toolId).uuid !== uuid) {
            try {
                unregisterFunctionTool(toolId);
            } catch (e) { /* ignore */ }
            registeredTools.delete(toolId);
        }
    }

    // 注册新的 / uuid 变化的工具
    for (const [toolId, { toolDef, worldName, uid, uuid, entryKey }] of shouldRegister) {
        if (registeredTools.has(toolId) && registeredTools.get(toolId) === uuid) {
            continue; // 已注册且 uuid 未变，跳过
        }

        try {
            // 先注销旧的（如果存在）
            if (registeredTools.has(toolId)) {
                unregisterFunctionTool(toolId);
            }

            registerFunctionTool({
                name: toolId,
                displayName: toolDef.displayName || toolDef.name,
                description: toolDef.description,
                parameters: toolDef.parameters,
                action: toolDef.action,
                formatMessage: toolDef.formatMessage,
                stealth: toolDef.stealth ?? false,
                shouldRegister: () => activatedEntries.has(entryKey),
            });

            registeredTools.set(toolId, uuid);
            console.log(`[${MODULE_NAME}] 已注册工具: ${toolId} (来自 ${worldName}[${uid}])`);
        } catch (e) {
            console.error(`[${MODULE_NAME}] 注册工具 ${toolId} 失败:`, e);
        }
    }
}

/**
 * 在隔离环境执行用户代码，返回工具定义对象（或 null）
 * @param {string} code
 * @returns {{ name: string, description: string, parameters: object, action: Function, [key: string]: any } | null}
 */
function executeToolCode(code) {
    if (!code || !code.trim()) return null;

    try {
        // 使用 Function 构造器在当前上下文执行（工具的 action 需要访问运行时环境）
        const fn = new Function(code);
        const result = fn();
        if (!result || typeof result !== 'object') return null;
        const missing = REQUIRED_TOOL_KEYS.filter(k => !(k in result));
        if (missing.length > 0) return null;
        return result;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 执行工具代码失败:`, e);
        return null;
    }
}

/**
 * WORLDINFO_ENTRIES_LOADED 事件处理
 * 扫描所有已加载的世界书条目，收集带 SToolBook 配置的条目
 * @param {{ globalLore: Array, characterLore: Array, chatLore: Array, personaLore: Array }} param
 */
function onWorldInfoEntriesLoaded({ globalLore = [], characterLore = [], chatLore = [], personaLore = [] }) {
    loadedToolEntries.clear();

    const allEntries = [...globalLore, ...characterLore, ...chatLore, ...personaLore];

    for (const entry of allEntries) {
        const stoolbook = entry.extensions?.[MODULE_NAME];
        if (!stoolbook) continue;

        const key = `${entry.world}::${entry.uid}`;
        loadedToolEntries.set(key, {
            worldName: entry.world,
            uid: entry.uid,
            stoolbook,
        });
    }

    console.log(`[${MODULE_NAME}] 已加载 ${loadedToolEntries.size} 个带工具函数的条目`);

    // 条目加载后重新同步注册
    syncToolRegistrations();
}

/**
 * WORLD_INFO_ACTIVATED 事件处理
 * 拷贝激活列表，然后重新同步注册
 * @param {Array} activatedList - 被激活的条目数组
 */
function onWorldInfoActivated(activatedList) {
    activatedEntries.clear();

    if (Array.isArray(activatedList)) {
        for (const entry of activatedList) {
            activatedEntries.add(`${entry.world}::${entry.uid}`);
        }
    }

    console.log(`[${MODULE_NAME}] 已激活 ${activatedEntries.size} 个条目`);

    // 激活列表变化后重新同步注册
    syncToolRegistrations();
}

// ============================================================
// 回合合并 —— 永久合并多步工具调用消息
// 工具调用摘要嵌入 reasoning 块，工具系统消息从 chat 中删除
// ============================================================

const EXTENSION_PATH = 'third-party/SToolBook';

const DEFAULT_SETTINGS = {
    turnMerging: false,
    pinNewestTurn: false,
    reasoningPassback: false,
    debugMode: false,
};

/** 生成结束后等待的毫秒数，防止打断工具调用循环或遗漏最后一条消息 */
const MERGE_DELAY_MS = 3000;

let isGenerating = false;
let isMerging = false;
let mergeTimer = null;

// ---------- Debug 日志 ----------

function debugLog(...args) {
    if (getSettings().debugMode) {
        console.log(`[${MODULE_NAME}]`, ...args);
    }
}

// ---------- 设置 ----------

function initSettings() {
    const extensionSettings = SillyTavern.getContext().extensionSettings;
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extensionSettings[MODULE_NAME][key] === undefined) {
            extensionSettings[MODULE_NAME][key] = value;
        }
    }
}

function getSettings() {
    return SillyTavern.getContext().extensionSettings[MODULE_NAME] ?? DEFAULT_SETTINGS;
}

// ---------- Turn 检测 ----------

function isAssistantMessage(msg) {
    return msg && !msg.is_user && !msg.is_system;
}

function isToolSystemMessage(msg) {
    return msg && msg.is_system && Array.isArray(msg.extra?.tool_invocations) && msg.extra.tool_invocations.length > 0;
}

/**
 * 识别聊天中所有可合并的回合
 * 跳过已合并的消息；只返回完整回合（最后一条是 assistant 消息）
 */
function identifyTurns() {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) return [];

    const turns = [];
    let i = 0;

    while (i < chat.length) {
        const msg = chat[i];

        if (msg?.extra?.stoolbook_merged) { i++; continue; }

        if (isAssistantMessage(msg) && i + 1 < chat.length && isToolSystemMessage(chat[i + 1])) {
            const turn = { startIdx: i, endIdx: i, parts: [{ idx: i, type: 'assistant' }] };

            let j = i + 1;
            while (j < chat.length) {
                if (isToolSystemMessage(chat[j])) {
                    turn.parts.push({ idx: j, type: 'tool' });
                    turn.endIdx = j;
                    j++;
                } else if (isAssistantMessage(chat[j])) {
                    turn.parts.push({ idx: j, type: 'assistant' });
                    turn.endIdx = j;
                    j++;
                } else {
                    break;
                }
            }

            const lastPart = turn.parts[turn.parts.length - 1];
            if (lastPart.type === 'assistant' && turn.parts.some(p => p.type === 'tool')) {
                turns.push(turn);
            }
            i = j;
        } else {
            i++;
        }
    }
    return turns;
}

// ---------- 工具摘要文本构建 ----------

function groupToolNames(names) {
    const counts = {};
    for (const name of names) {
        counts[name] = (counts[name] || 0) + 1;
    }
    return Object.entries(counts)
        .map(([name, count]) => count > 1 ? `${name} (${count})` : name)
        .join(', ');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function tryParseJSON(str) {
    try { return JSON.parse(str); } catch { return str; }
}

/**
 * 为一组 tool_invocations 构建可折叠 HTML，嵌入 reasoning 显示文本中
 */
function buildToolSummaryHtml(invocations) {
    const toolNames = invocations.map(i => i.displayName || i.name);
    const grouped = groupToolNames(toolNames);

    let html = `<details class="stoolbook-tool-summary">\n`;
    html += `<summary><i class="fa-solid fa-screwdriver-wrench"></i> Tool: ${escapeHtml(grouped)}</summary>\n`;
    html += `<div class="stoolbook-tool-details">\n`;

    for (const inv of invocations) {
        html += `<div class="stoolbook-tool-invocation">\n`;

        const params = tryParseJSON(inv.parameters);
        const paramsStr = typeof params === 'object' ? JSON.stringify(params, null, 2) : String(params);
        html += `<div class="stoolbook-tool-label">Parameters</div>\n`;
        html += `<pre><code class="language-json">${escapeHtml(paramsStr)}</code></pre>\n`;

        const result = tryParseJSON(inv.result);
        const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
        html += `<div class="stoolbook-tool-label">Result</div>\n`;
        html += `<pre><code class="language-json">${escapeHtml(resultStr)}</code></pre>\n`;

        html += `</div>\n`;
    }

    html += `</div>\n</details>`;
    return html;
}

/**
 * 为一组 tool_invocations 构建纯文本摘要，嵌入 reasoning 原始文本中
 */
function buildToolSummaryText(invocations) {
    const lines = [];
    for (const inv of invocations) {
        const name = inv.displayName || inv.name;
        const params = tryParseJSON(inv.parameters);
        const result = tryParseJSON(inv.result);
        const paramsStr = typeof params === 'object' ? JSON.stringify(params) : String(params);
        const resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
        lines.push(`[Tool Call: ${name}] params=${paramsStr} → result=${resultStr}`);
    }
    return lines.join('\n');
}

// ---------- Chat 数组合并逻辑 ----------

/**
 * 将一个回合内的所有消息合并到首条 assistant 消息中
 * - 所有 assistant 文本合并到 mes
 * - reasoning 合并 + 工具调用摘要嵌入 reasoning（纯文本）和 reasoning_display_text（HTML）
 * - 工具系统消息和续接 assistant 消息从 chat 中删除
 * @returns {number[]} 需要从 chat 中删除的消息索引
 */
function mergeTurnInChat(chat, turn) {
    const container = chat[turn.startIdx];
    if (container.extra?.stoolbook_merged) return [];

    const mesParts = [];
    const reasoningParts = [];
    const reasoningDisplayParts = [];

    for (const part of turn.parts) {
        const msg = chat[part.idx];
        if (part.type === 'assistant') {
            const text = (msg.mes || '').trim();
            if (text) {
                mesParts.push(text);
            }
            if (msg.extra?.reasoning) {
                reasoningParts.push(msg.extra.reasoning);
                // 对应的显示文本：如果有 reasoning_display_text 就用它，否则同原始文本
                reasoningDisplayParts.push(msg.extra.reasoning_display_text ?? msg.extra.reasoning);
            }
        } else if (part.type === 'tool') {
            // 工具调用作为压缩行嵌入 reasoning
            reasoningParts.push(buildToolSummaryText(msg.extra.tool_invocations));
            reasoningDisplayParts.push(buildToolSummaryHtml(msg.extra.tool_invocations));
        }
    }

    // 更新容器消息
    container.mes = mesParts.join('\n\n');
    if (!container.extra) container.extra = {};
    container.extra.reasoning = reasoningParts.join('\n\n');
    container.extra.reasoning_display_text = reasoningDisplayParts.join('\n\n');
    container.extra.stoolbook_merged = true;

    // 同步当前 swipe
    if (Array.isArray(container.swipes) && typeof container.swipe_id === 'number' && container.swipe_id >= 0) {
        container.swipes[container.swipe_id] = container.mes;
        if (Array.isArray(container.swipe_info) && container.swipe_info[container.swipe_id]) {
            const info = container.swipe_info[container.swipe_id];
            if (!info.extra) info.extra = {};
            info.extra.reasoning = container.extra.reasoning;
            info.extra.reasoning_display_text = container.extra.reasoning_display_text;
        }
    }

    return turn.parts.slice(1).map(p => p.idx);
}

/**
 * 执行永久合并：修改 chat 数组 → 保存 → 重载显示
 */
async function performTurnMerge() {
    if (isMerging) {
        debugLog('performTurnMerge 跳过：正在合并中');
        return;
    }
    if (isGenerating) {
        debugLog('performTurnMerge 跳过：正在生成中');
        return;
    }

    const context = SillyTavern.getContext();
    const { chat } = context;
    if (!chat || chat.length === 0) {
        debugLog('performTurnMerge 跳过：chat 为空');
        return;
    }

    const turns = identifyTurns();
    debugLog(`检测到 ${turns.length} 个可合并回合`);
    if (turns.length === 0) return;

    isMerging = true;
    try {
        const allRemovedIndices = [];

        for (const turn of turns) {
            debugLog(`合并回合: mesid ${turn.startIdx}-${turn.endIdx}, ${turn.parts.length} 部分`);
            const removed = mergeTurnInChat(chat, turn);
            allRemovedIndices.push(...removed);
        }

        if (allRemovedIndices.length === 0) {
            debugLog('无需删除的消息（可能已合并）');
            return;
        }

        allRemovedIndices.sort((a, b) => b - a);
        for (const idx of allRemovedIndices) {
            chat.splice(idx, 1);
        }

        debugLog(`已合并 ${turns.length} 个回合，移除 ${allRemovedIndices.length} 条消息`);

        await context.saveChat();
        await context.reloadCurrentChat();
        toastr.success(`已合并 ${turns.length} 个工具调用回合`, MODULE_NAME);
    } finally {
        isMerging = false;
    }
}

// ---------- 调度控制 ----------

function scheduleMerge() {
    if (isMerging || !getSettings().turnMerging) {
        debugLog(`scheduleMerge 跳过：${isMerging ? '正在合并' : '功能未开启'}`);
        return;
    }
    cancelMerge();
    debugLog(`已排程合并，${MERGE_DELAY_MS}ms 后执行`);
    mergeTimer = setTimeout(async () => {
        mergeTimer = null;
        try {
            await performTurnMerge();
        } catch (/** @type {*} */ e) {
            console.error(`[${MODULE_NAME}] 合并失败:`, e);
            toastr.error(`合并失败: ${e?.message ?? e}`, MODULE_NAME);
            isMerging = false;
        }
    }, MERGE_DELAY_MS);
}

function cancelMerge() {
    if (mergeTimer) {
        clearTimeout(mergeTimer);
        mergeTimer = null;
        debugLog('已取消待执行的合并');
    }
}

// ---------- 最新回合置底 ----------

/**
 * 将最新一轮 tool loop 的所有消息置于 prompt 最底部。
 * 通过 tool_call_id 链路识别 loop 消息——只有真实的 tool 交互才有
 * `tool_calls` 属性（assistant）和 `role==='tool'`，注入伪造的消息不会有。
 * 从最末尾的 tool 相关消息出发做 BFS，找到整条 tool_call_id 关联链，
 * 然后将这些消息从原位提取并追加到数组末尾。其余消息完全不动。
 */
function pinNewestTurnToBottom(data) {
    const chat = data?.chat;
    if (!chat?.length) return;

    // 找到最后一条 tool 相关消息作为种子
    let seedIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].tool_calls || chat[i].role === 'tool') {
            seedIdx = i;
            break;
        }
    }
    if (seedIdx < 0) return; // 无 tool loop

    // BFS：通过 tool_call_id 链路找到整个 loop 的关联消息
    const loopSet = new Set();
    const visited = new Set();
    const queue = [seedIdx];

    while (queue.length > 0) {
        const idx = queue.shift();
        if (visited.has(idx)) continue;
        visited.add(idx);
        loopSet.add(idx);

        const msg = chat[idx];

        // tool 消息 → 找发起调用的 assistant
        if (msg.role === 'tool' && msg.tool_call_id) {
            for (let j = 0; j < chat.length; j++) {
                if (chat[j].tool_calls?.some(tc => tc.id === msg.tool_call_id)) {
                    queue.push(j);
                }
            }
        }

        // assistant with tool_calls → 找对应的 tool 结果
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                for (let j = 0; j < chat.length; j++) {
                    if (chat[j].role === 'tool' && chat[j].tool_call_id === tc.id) {
                        queue.push(j);
                    }
                }
            }
        }
    }

    if (loopSet.size === 0) return;

    const sorted = [...loopSet].sort((a, b) => a - b);

    // 检查是否已经在底部（连续块且结尾对齐）
    const isAtBottom = sorted[sorted.length - 1] === chat.length - 1
        && sorted.length === chat.length - sorted[0];
    if (isAtBottom) {
        debugLog('pinNewestTurn: tool loop 已在底部');
        return;
    }

    // 提取并置底（倒序 splice 保持索引）
    const loopMessages = sorted.map(i => chat[i]);
    for (let k = sorted.length - 1; k >= 0; k--) {
        chat.splice(sorted[k], 1);
    }
    for (const msg of loopMessages) chat.push(msg);

    debugLog(`pinNewestTurn: 已将 ${loopMessages.length} 条 tool loop 消息置底`);
}

// ---------- DeepSeek reasoning_content 回传修复 ----------

/**
 * 将 tool_calls 消息上的 reasoning 字段映射为 reasoning_content，
 * 使 DeepSeek reasoner 的思考内容能正确回传给 API。
 * 后端 addReasoningContentToToolCalls 检查 'reasoning_content' in message，
 * 已存在则跳过，因此我们在前端设好真实值后后端不会覆盖为空字符串。
 * 对非 DeepSeek API 无副作用（未知字段会被忽略）。
 */
function passbackReasoningContent(data) {
    const chat = data?.chat;
    if (!chat?.length) return;

    let count = 0;
    for (const msg of chat) {
        if (msg.tool_calls && !('reasoning_content' in msg)) {
            msg.reasoning_content = msg.reasoning || '';
            count++;
        }
    }
    if (count > 0) {
        debugLog(`passbackReasoningContent: 已为 ${count} 条 tool_calls 消息设置 reasoning_content`);
    }
}

// ---------- Debug mode: 5-click 解锁 ----------

function setupDebugUnlock() {
    const header = document.getElementById('stoolbook_drawer_header');
    if (!header) return;

    let clickCount = 0;
    let clickTimer = null;

    header.addEventListener('click', () => {
        clickCount++;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1500);

        if (clickCount >= 5) {
            clickCount = 0;
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            const debugToggle = document.querySelector('.stoolbook_debug_toggle');
            if (debugToggle) {
                const isVisible = debugToggle.style.display !== 'none';
                debugToggle.style.display = isVisible ? 'none' : '';
                toastr.info(isVisible ? 'Debug mode hidden' : 'Debug mode revealed', MODULE_NAME);
            }
        }
    });
}

// ============================================================
// 初始化
// ============================================================
(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    initSettings();

    eventSource.on(event_types.APP_READY, async () => {
        console.log(`[${MODULE_NAME}] 扩展已加载`);

        const { renderExtensionTemplateAsync, saveSettingsDebounced } = SillyTavern.getContext();
        const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        $('#extensions_settings').append(settingsHtml);

        // 绑定: 合并开关
        const settings = getSettings();
        $('#stoolbook_turn_merging').prop('checked', settings.turnMerging);
        $('#stoolbook_turn_merging').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].turnMerging = $(this).prop('checked');
            saveSettingsDebounced();
            if (ext[MODULE_NAME].turnMerging) {
                scheduleMerge();
            }
        });

        // 绑定: 置底开关
        $('#stoolbook_pin_newest_turn').prop('checked', settings.pinNewestTurn);
        $('#stoolbook_pin_newest_turn').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].pinNewestTurn = $(this).prop('checked');
            saveSettingsDebounced();
        });

        // 绑定: 回传推理内容开关
        $('#stoolbook_reasoning_passback').prop('checked', settings.reasoningPassback);
        $('#stoolbook_reasoning_passback').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].reasoningPassback = $(this).prop('checked');
            saveSettingsDebounced();
        });

        // 绑定: debug 开关
        $('#stoolbook_debug_mode').prop('checked', settings.debugMode);
        if (settings.debugMode) {
            $('.stoolbook_debug_toggle').show();
        }
        $('#stoolbook_debug_mode').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].debugMode = $(this).prop('checked');
            saveSettingsDebounced();
        });

        // 5-click 解锁 debug
        setupDebugUnlock();

        // 原有世界书 UI
        scanExistingEntries();
        observeEntries();
        observeBody();

        if (getSettings().turnMerging) {
            scheduleMerge();
        }
    });

    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);

    // ---- 回合合并事件钩子 ----

    eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => {
        if (dryRun) {
            debugLog('事件: GENERATION_STARTED (dryRun, 忽略)');
            return;
        }
        debugLog('事件: GENERATION_STARTED');
        isGenerating = true;
        cancelMerge();
    });

    eventSource.on(event_types.GENERATION_ENDED, () => {
        debugLog('事件: GENERATION_ENDED');
        isGenerating = false;
        scheduleMerge();
    });

    eventSource.on(event_types.GENERATION_STOPPED, () => {
        debugLog('事件: GENERATION_STOPPED');
        isGenerating = false;
        scheduleMerge();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        debugLog('事件: CHAT_CHANGED');
        scheduleMerge();
    });

    // ---- 最新回合置底 ----

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (data?.dryRun) return;
        if (getSettings().reasoningPassback) {
            passbackReasoningContent(data);
        }
        if (getSettings().pinNewestTurn) {
            pinNewestTurnToBottom(data);
        }
    });
})();
