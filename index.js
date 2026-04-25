/**
 * SToolBook - SoliUmbra的工具书
 * 在世界书条目中添加"编辑工具函数"按钮，点击后展开内联抽屉编辑 JS 代码
 * 数据持久化到 entry.extensions.SToolBook（世界书条目自身）
 */

import { MODULE_NAME } from './constants.js';
import { loadToolFuncData, saveToolFuncData } from './tool-storage.js';
import {
    beginToolBatch,
    beginToolInvocation,
    endToolBatch,
    endToolInvocation,
    replaceActivatedEntries,
    replaceLoadedToolEntries,
    syncToolRegistrations,
    unregisterAllTools,
    clearSeamlessLoopStopRequest,
    flushPendingStepReplyAugment,
    getSeamlessLoopStopRequest,
    isBackgroundPromptAssemblyActive,
    installGlobalToolApiBridge,
    validateToolCode,
} from './tool-runtime.js';

const EXTENSION_PATH = 'third-party/SToolBook';

const DEFAULT_SETTINGS = {
    seamlessToolLoop: false,
    turnMerging: false,
    pinNewestTurn: false,
    reasoningPassback: false,
    debugMode: false,
};

/** 生成结束后等待的毫秒数，防止打断工具调用循环或遗漏最后一条消息 */
const MERGE_DELAY_MS = 3000;
const SEAMLESS_LIMIT = 10;

let isGenerating = false;
let isMerging = false;
let mergeTimer = null;

/** seamless 状态 */
let seamlessActive = false;
let seamlessDepth = 0;
let lastHadToolCalls = false;
let toolResultsInOrder = [];
let pendingInvocations = [];
/** 每轮完整响应记录：{ extra, calls, results, invocations } */
let turnHistory = [];
/** 是否临时开启了 continue_prefill */
let prefillWasForced = false;
/** 从 invokeFunctionTools 的 reasoningText 参数捕获的 reasoning（非流式直接来自 API 响应） */
let lastCapturedReasoning = null;
/** 工具主动请求终止 seamless 后续 continue */
let seamlessStopAfterCurrentTurn = false;

/** 原始 ToolManager 方法引用（APP_READY 时绑定） */
let _origHasToolCalls = null;
let _origIsStealthTool = null;
let _origInvokeFunctionTool = null;
let _origInvokeFunctionTools = null;
let _origCanPerformToolCalls = null;

function debugLog(...args) {
    if (getSettings().debugMode) {
        console.log(`[${MODULE_NAME}]`, ...args);
    }
}

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

// ============================================================
// 创建抽屉 DOM
// ============================================================

/**
 * 为指定条目创建工具函数面板（只有 content 部分，不含 header）
 * 直接 append 到已有的 .inline-drawer 内部
 * @param {string} uid
 * @param {string} worldName
 * @param {{ enabled: boolean, code: string, valid: boolean, uuid: string }} stoolbookData
 * @returns {HTMLElement}
 */
function createToolPanel(uid, worldName, stoolbookData) {
    const panel = document.createElement('div');
    panel.className = 'stoolbook_panel';
    panel.dataset.uid = uid;
    panel.dataset.world = worldName;

    const toolbar = document.createElement('div');
    toolbar.className = 'stoolbook_toolbar';

    const leftGroup = document.createElement('label');
    leftGroup.className = 'checkbox_label stoolbook_toggle_label';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = stoolbookData.enabled;
    toggle.className = 'stoolbook_toggle';
    toggle.addEventListener('change', (e) => e.stopPropagation());

    const toggleText = document.createElement('span');
    toggleText.textContent = '启用工具函数';

    leftGroup.append(toggle, toggleText);

    const saveBtn = document.createElement('div');
    saveBtn.className = 'menu_button interactable stoolbook_save_btn';
    saveBtn.title = '保存工具函数';
    saveBtn.setAttribute('tabindex', '0');
    saveBtn.setAttribute('role', 'button');
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> <span>保存</span>';
    saveBtn.addEventListener('click', async () => {
        const textarea = /** @type {HTMLTextAreaElement | null} */ (panel.querySelector('.stoolbook_code_editor'));
        const code = textarea ? textarea.value : '';
        const enabled = toggle.checked;

        const validation = await saveToolFuncData(worldName, uid, { enabled, code }, validateToolCode);
        syncToolRegistrations();

        if (validation.valid) {
            toastr.success('工具函数已保存，验证通过 ✓');
        } else if (code.trim()) {
            toastr.warning(`工具函数已保存，但验证失败: ${validation.error}`, '验证未通过', { timeOut: 5000 });
        } else {
            toastr.info('工具函数已保存（代码为空）');
        }
    });

    toolbar.append(leftGroup, saveBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole stoolbook_code_editor';
    textarea.rows = 14;
    textarea.placeholder = [
        '// 在此编写工具函数，代码必须 return 一个工具定义对象',
        '// action(args, api) 中的 api 可用能力：',
        '// - api.reply / api.step.reply：读写当前步骤的 AI 回复正文与思维链',
        '// - api.loop.stop(reason?)：当前批工具执行完后直接结束 seamless 循环，不再发送下一条 continue',
        '// - api.request.parallel(...)：静默并发发起 quiet/raw/background 请求',
        '// - api.request.background(...)：后台构造完整聊天上下文（聊天记录/预设/世界书）后发起补全，不占主任务',
        '// - api.seamless 是 api.loop 的别名',
        '// 例如：',
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
        '    action: async (args, api) => {',
        '        const step = api.reply.get();',
        '        await api.reply.appendReasoning(`\n调用参数: ${JSON.stringify(args)}`);',
        '        const result = await api.request.background({ quietPrompt: `分析并回答：${args.query}` });',
        '        await api.reply.appendContent(`\n\n补充结果：${result}`);',
        '        return JSON.stringify({ step, result });',
        '    },',
        '};',
    ].join('\n');
    textarea.value = stoolbookData.code;
    textarea.spellcheck = false;

    panel.append(toolbar, textarea);
    return panel;
}

// ============================================================
// 按钮注入逻辑
// ============================================================

/**
 * @param {HTMLElement} entryEl
 */
function injectButton(entryEl) {
    if (entryEl.querySelector('.stoolbook_edit_tool_btn')) return;

    const moveBtn = entryEl.querySelector('.move_entry_button');
    if (!(moveBtn instanceof HTMLElement) || !moveBtn.parentNode) return;

    const uid = moveBtn.getAttribute('data-uid') ?? '';
    const currentWorld = moveBtn.getAttribute('data-current-world') ?? '';

    const btn = document.createElement('i');
    btn.className = 'menu_button stoolbook_edit_tool_btn fa-solid fa-screwdriver-wrench interactable';
    btn.setAttribute('title', '编辑工具函数');
    btn.setAttribute('data-uid', uid);
    btn.setAttribute('data-current-world', currentWorld);
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'button');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolDrawer(entryEl, uid, currentWorld);
    });

    moveBtn.parentNode.insertBefore(btn, moveBtn);
}

/**
 * @param {HTMLElement} entryEl
 * @param {string} uid
 * @param {string} worldName
 */
async function toggleToolDrawer(entryEl, uid, worldName) {
    let panel = entryEl.querySelector('.stoolbook_panel');

    if (panel) {
        $(panel).stop().slideToggle();
        return;
    }

    const loaded = await loadToolFuncData(worldName, uid);
    if (!loaded) {
        toastr.error('无法加载世界书条目数据');
        return;
    }

    panel = createToolPanel(uid, worldName, {
        enabled: loaded.enabled ?? false,
        code: loaded.code ?? '',
        valid: loaded.valid ?? false,
        uuid: loaded.uuid ?? '',
    });

    const inlineDrawer = entryEl.querySelector('.inline-drawer.wide100p');
    if (inlineDrawer) {
        inlineDrawer.appendChild(panel);
    } else {
        entryEl.appendChild(panel);
    }

    $(panel).hide().slideDown();
}

// ============================================================
// 扫描与监听
// ============================================================

function scanExistingEntries() {
    const container = document.getElementById('world_popup_entries_list');
    if (!container) return;
    container.querySelectorAll('.world_entry').forEach((entry) => injectButton(/** @type {HTMLElement} */ (entry)));
}

function observeEntries() {
    const container = document.getElementById('world_popup_entries_list');
    if (!container) return;

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;

                if (node.classList.contains('world_entry')) {
                    injectButton(node);
                }

                node.querySelectorAll?.('.world_entry')?.forEach((entry) => injectButton(/** @type {HTMLElement} */ (entry)));
            }
        }
    });

    observer.observe(container, { childList: true, subtree: true });
    console.log(`[${MODULE_NAME}] MutationObserver 已挂载到 #world_popup_entries_list`);
}

function observeBody() {
    const bodyObserver = new MutationObserver(() => {
        const container = document.getElementById('world_popup_entries_list');
        if (container && !container.dataset.stoolbookObserved) {
            container.dataset.stoolbookObserved = 'true';
            scanExistingEntries();
            observeEntries();
        }
    });

    bodyObserver.observe(document.body, { childList: true, subtree: true });
    console.log(`[${MODULE_NAME}] Body observer 已启动`);
}

// ============================================================
// 世界书条目同步
// ============================================================

/**
 * @param {{ globalLore?: Array<any>, characterLore?: Array<any>, chatLore?: Array<any>, personaLore?: Array<any> }} param
 */
function onWorldInfoEntriesLoaded({ globalLore = [], characterLore = [], chatLore = [], personaLore = [] }) {
    const allEntries = [...globalLore, ...characterLore, ...chatLore, ...personaLore];
    const count = replaceLoadedToolEntries(allEntries
        .filter((entry) => entry?.extensions?.[MODULE_NAME])
        .map((entry) => ({
            worldName: entry.world,
            uid: entry.uid,
            stoolbook: entry.extensions[MODULE_NAME],
        })));

    console.log(`[${MODULE_NAME}] 已加载 ${count} 个带工具函数的条目`);
    syncToolRegistrations();
}

/**
 * @param {Array<{ world: string, uid: string|number }>} activatedList
 */
function onWorldInfoActivated(activatedList) {
    const count = replaceActivatedEntries(activatedList);
    console.log(`[${MODULE_NAME}] 已激活 ${count} 个条目`);
    syncToolRegistrations();
}

// ============================================================
// 回合合并 —— 永久合并多步工具调用消息
// 工具调用摘要嵌入 reasoning 块，工具系统消息从 chat 中删除
// ============================================================

function isAssistantMessage(msg) {
    return msg && !msg.is_user && !msg.is_system;
}

function isToolSystemMessage(msg) {
    return msg && msg.is_system && Array.isArray(msg.extra?.tool_invocations) && msg.extra.tool_invocations.length > 0;
}

function identifyTurns() {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) return [];

    const turns = [];
    let i = 0;

    while (i < chat.length) {
        const msg = chat[i];

        if (msg?.extra?.stoolbook_merged) {
            const followedByTool = i + 1 < chat.length && isToolSystemMessage(chat[i + 1]);
            if (!followedByTool) {
                i++;
                continue;
            }
        }

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
            if (lastPart.type === 'assistant' && turn.parts.some((part) => part.type === 'tool')) {
                turns.push(turn);
            }
            i = j;
        } else {
            i++;
        }
    }

    return turns;
}

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
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

function buildToolSummaryHtml(invocations) {
    const toolNames = invocations.map((invocation) => invocation.displayName || invocation.name);
    const grouped = groupToolNames(toolNames);
    const parts = [];

    parts.push('<details class="stoolbook-tool-summary">');
    parts.push(`<summary><i class="fa-solid fa-screwdriver-wrench"></i> Tool: ${escapeHtml(grouped)}</summary>`);
    parts.push('<div class="stoolbook-tool-details">');

    for (const inv of invocations) {
        parts.push('<div class="stoolbook-tool-invocation">');

        const params = tryParseJSON(inv.parameters);
        const paramsStr = typeof params === 'object' ? JSON.stringify(params, null, 2) : String(params);
        parts.push('<div class="stoolbook-tool-label">Parameters</div>');
        parts.push(`<pre><code class="language-json">${escapeHtml(paramsStr)}</code></pre>`);

        const result = tryParseJSON(inv.result);
        const resultStr = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
        parts.push('<div class="stoolbook-tool-label">Result</div>');
        parts.push(`<pre><code class="language-json">${escapeHtml(resultStr)}</code></pre>`);
        parts.push('</div>');
    }

    parts.push('</div></details>');
    return parts.join('');
}

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

function mergeTurnInChat(chat, turn) {
    const container = chat[turn.startIdx];
    const mesParts = [];
    const reasoningParts = [];
    const reasoningDisplayParts = [];
    const isRemerge = !!container.extra?.stoolbook_merged;

    for (const part of turn.parts) {
        const msg = chat[part.idx];
        if (part.type === 'assistant') {
            const text = (msg.mes || '').trim();
            if (text) {
                mesParts.push(text);
            }
            if (msg.extra?.reasoning) {
                reasoningParts.push(msg.extra.reasoning);
                const displayReasoning = (msg === container && isRemerge)
                    ? msg.extra.reasoning
                    : (msg.extra.reasoning_display_text ?? msg.extra.reasoning);
                reasoningDisplayParts.push(displayReasoning);
            }
        } else if (part.type === 'tool') {
            reasoningParts.push(buildToolSummaryText(msg.extra.tool_invocations));
            reasoningDisplayParts.push(buildToolSummaryHtml(msg.extra.tool_invocations));
        }
    }

    container.mes = mesParts.join('\n\n');
    if (!container.extra) container.extra = {};
    container.extra.reasoning = reasoningParts.join('\n\n');
    container.extra.reasoning_display_text = reasoningDisplayParts.join('\n\n');
    container.extra.stoolbook_merged = true;
    delete container.extra.display_text;

    if (Array.isArray(container.swipes) && typeof container.swipe_id === 'number' && container.swipe_id >= 0) {
        container.swipes[container.swipe_id] = container.mes;
        if (Array.isArray(container.swipe_info) && container.swipe_info[container.swipe_id]) {
            const info = container.swipe_info[container.swipe_id];
            if (!info.extra) info.extra = {};
            info.extra.reasoning = container.extra.reasoning;
            info.extra.reasoning_display_text = container.extra.reasoning_display_text;
            info.extra.stoolbook_merged = true;
            delete info.extra.display_text;
        }
    }

    return turn.parts.slice(1).map((part) => part.idx);
}

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
        } catch (e) {
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

function pinNewestTurnToBottom(data) {
    const chat = data?.chat;
    if (!chat?.length) return;

    let seedIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].tool_calls || chat[i].role === 'tool') {
            seedIdx = i;
            break;
        }
    }
    if (seedIdx < 0) return;

    const loopSet = new Set();
    const visited = new Set();
    const queue = [seedIdx];

    while (queue.length > 0) {
        const idx = queue.shift();
        if (visited.has(idx)) continue;
        visited.add(idx);
        loopSet.add(idx);

        const msg = chat[idx];
        if (msg.role === 'tool' && msg.tool_call_id) {
            for (let j = 0; j < chat.length; j++) {
                if (chat[j].tool_calls?.some((tc) => tc.id === msg.tool_call_id)) {
                    queue.push(j);
                }
            }
        }

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
    const isAtBottom = sorted[sorted.length - 1] === chat.length - 1
        && sorted.length === chat.length - sorted[0];
    if (isAtBottom) {
        debugLog('pinNewestTurn: tool loop 已在底部');
        return;
    }

    const loopMessages = sorted.map((i) => chat[i]);
    for (let k = sorted.length - 1; k >= 0; k--) {
        chat.splice(sorted[k], 1);
    }
    for (const msg of loopMessages) chat.push(msg);

    debugLog(`pinNewestTurn: 已将 ${loopMessages.length} 条 tool loop 消息置底`);
}

function passbackReasoningContent(data) {
    const chat = data?.chat;
    if (!chat?.length) return;

    const realChat = SillyTavern.getContext().chat;
    if (!realChat?.length) return;

    const reasoningByToolCallId = new Map();
    for (let i = 0; i < realChat.length; i++) {
        const msg = realChat[i];
        if (msg.is_user || msg.is_system) continue;
        const reasoning = msg.extra?.reasoning;
        if (!reasoning) continue;

        const next = realChat[i + 1];
        if (next?.is_system && Array.isArray(next.extra?.tool_invocations)) {
            for (const inv of next.extra.tool_invocations) {
                if (inv.id) reasoningByToolCallId.set(inv.id, reasoning);
            }
            for (const inv of next.extra.tool_invocations) {
                if (inv.id && inv.reasoning && !reasoningByToolCallId.has(inv.id)) {
                    reasoningByToolCallId.set(inv.id, inv.reasoning);
                }
            }
        }
    }

    let count = 0;
    for (const msg of chat) {
        if (!msg.tool_calls || 'reasoning_content' in msg) continue;

        let reasoning = msg.reasoning || '';
        if (!reasoning && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
                const found = reasoningByToolCallId.get(tc.id);
                if (found) {
                    reasoning = found;
                    break;
                }
            }
        }

        msg.reasoning_content = reasoning;
        count++;
    }

    if (count > 0) {
        debugLog(`passbackReasoningContent: 已为 ${count} 条 tool_calls 消息设置 reasoning_content`);
    }
}

// ============================================================
// 无缝工具循环 (Seamless Tool Loop)
// ============================================================

function installSeamlessOverrides() {
    const { ToolManager } = SillyTavern.getContext();

    _origHasToolCalls = ToolManager.hasToolCalls.bind(ToolManager);
    _origIsStealthTool = ToolManager.isStealthTool.bind(ToolManager);
    _origInvokeFunctionTool = ToolManager.invokeFunctionTool.bind(ToolManager);
    _origInvokeFunctionTools = ToolManager.invokeFunctionTools.bind(ToolManager);
    _origCanPerformToolCalls = ToolManager.canPerformToolCalls.bind(ToolManager);

    ToolManager.hasToolCalls = function (data) {
        const has = _origHasToolCalls(data);
        if (seamlessActive && has) {
            lastHadToolCalls = true;
            debugLog('seamless hasToolCalls: 检测到工具调用，返回 false');
            return false;
        }
        return has;
    };

    ToolManager.isStealthTool = function (name) {
        if (seamlessActive) return true;
        return _origIsStealthTool(name);
    };

    ToolManager.invokeFunctionTools = async function (data, opts = {}) {
        const batchToken = beginToolBatch({ data, options: opts });
        try {
            if (seamlessActive && opts?.reasoningText) {
                lastCapturedReasoning = opts.reasoningText;
                debugLog(`seamless invokeFunctionTools: 捕获 reasoningText (${opts.reasoningText.length}c)`);
            }
            return await _origInvokeFunctionTools(data, opts);
        } finally {
            endToolBatch(batchToken);
        }
    };

    ToolManager.invokeFunctionTool = async function (name, params) {
        const invocationToken = beginToolInvocation({ name, parameters: params });
        try {
            const result = await _origInvokeFunctionTool(name, params);
            if (seamlessActive && !(result instanceof Error)) {
                toolResultsInOrder.push({
                    name,
                    displayName: ToolManager.getDisplayName(name),
                    params,
                    result,
                });
                debugLog(`seamless invokeFunctionTool: ${name} → 结果已捕获`);
            }
            return result;
        } finally {
            endToolInvocation(invocationToken);
        }
    };

    ToolManager.canPerformToolCalls = function (type, ...args) {
        if (seamlessActive && type === 'continue') {
            return _origCanPerformToolCalls('normal', ...args);
        }
        return _origCanPerformToolCalls(type, ...args);
    };

    debugLog('seamless overrides 已安装');
}

function recordTurnToHistory(results) {
    const { chat } = SillyTavern.getContext();
    const lastMsg = chat[chat.length - 1];
    const sourceExtra = lastMsg?.extra ? structuredClone(lastMsg.extra) : {};
    const extra = sourceExtra && typeof sourceExtra === 'object' ? sourceExtra : {};

    if (lastCapturedReasoning) {
        extra.reasoning = lastCapturedReasoning;
        extra.reasoning_display_text = null;
        lastCapturedReasoning = null;
    } else if (!extra.reasoning) {
        extra.reasoning = '';
        extra.reasoning_display_text = null;
        extra.reasoning_signature = null;
    }

    if (!extra.reasoning) {
        extra.reasoning_display_text = null;
        extra.reasoning_signature = null;
    }

    const calls = [];
    const toolResults = [];
    const invocations = [];

    for (let i = 0; i < results.length; i++) {
        const captured = results[i];
        const id = `stb_${seamlessDepth}_${i}`;
        const name = captured.name || 'unknown';
        const displayName = captured.displayName || name;
        const args = captured.params ?? '';
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args);

        calls.push({ id, type: 'function', function: { name, arguments: argsStr } });

        const rawResult = captured.result;
        const content = rawResult instanceof Error
            ? rawResult.message
            : (rawResult == null ? '' : (typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)));

        toolResults.push({ id, name, content });
        invocations.push({ id, displayName, name, parameters: argsStr, result: content });
    }

    turnHistory.push({ extra, calls, results: toolResults, invocations });
    pendingInvocations.push(...invocations);

    syncSeamlessStopRequest();

    debugLog(`seamless: 记录第 ${turnHistory.length} 轮, reasoning=${(extra.reasoning || '').length}c, signature=${!!extra.reasoning_signature}, ${calls.length} calls`);
}

function syncSeamlessStopRequest() {
    if (seamlessStopAfterCurrentTurn) {
        return true;
    }

    const stopRequest = getSeamlessLoopStopRequest();
    if (!stopRequest) {
        return false;
    }

    seamlessStopAfterCurrentTurn = true;
    debugLog(`seamless: 已收到停止请求${stopRequest.reason ? ` (${stopRequest.reason})` : ''}`);
    clearSeamlessLoopStopRequest();
    return true;
}

function finalizeSeamlessReasoning() {
    const { chat } = SillyTavern.getContext();
    if (!chat?.length) return;

    let lastAssistantIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            lastAssistantIdx = i;
            break;
        }
    }
    if (lastAssistantIdx < 0) return;

    const msg = chat[lastAssistantIdx];
    const finalReasoning = msg.extra?.reasoning || '';
    if (turnHistory.length === 0) return;

    const reasoningParts = [];
    const displayParts = [];

    for (const turn of turnHistory) {
        const reasoning = turn.extra?.reasoning || '';
        if (reasoning) {
            reasoningParts.push(reasoning);
            displayParts.push(reasoning);
        }
        if (turn.invocations.length > 0) {
            reasoningParts.push(buildToolSummaryText(turn.invocations));
            displayParts.push(buildToolSummaryHtml(turn.invocations));
        }
    }

    if (finalReasoning) {
        reasoningParts.push(finalReasoning);
        displayParts.push(finalReasoning);
    }

    if (!msg.extra) msg.extra = {};
    msg.extra.reasoning = reasoningParts.join('\n\n');
    msg.extra.reasoning_display_text = displayParts.join('\n\n');
    msg.extra.stoolbook_merged = true;
    delete msg.extra.display_text;

    const firstSignature = turnHistory[0]?.extra?.reasoning_signature;
    if (firstSignature && !msg.extra.reasoning_signature) {
        msg.extra.reasoning_signature = firstSignature;
    }

    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number' && msg.swipe_id >= 0) {
        if (Array.isArray(msg.swipe_info) && msg.swipe_info[msg.swipe_id]) {
            const info = msg.swipe_info[msg.swipe_id];
            if (!info.extra) info.extra = {};
            info.extra.reasoning = msg.extra.reasoning;
            info.extra.reasoning_display_text = msg.extra.reasoning_display_text;
            info.extra.stoolbook_merged = true;
            delete info.extra.display_text;
        }
    }

    debugLog(`seamless: reasoning 合并完成, ${turnHistory.length} 轮 + 最终, ${pendingInvocations.length} 个工具调用`);
}

function resetSeamlessState() {
    if (prefillWasForced) {
        const oai = SillyTavern.getContext().chatCompletionSettings;
        if (oai) oai.continue_prefill = false;
        prefillWasForced = false;
        debugLog('seamless: 已恢复 continue_prefill = false');
    }
    seamlessActive = false;
    seamlessDepth = 0;
    lastHadToolCalls = false;
    lastCapturedReasoning = null;
    toolResultsInOrder = [];
    pendingInvocations = [];
    seamlessStopAfterCurrentTurn = false;
    turnHistory = [];
}

function ensureContinuePrefill() {
    const oai = SillyTavern.getContext().chatCompletionSettings;
    if (oai && !oai.continue_prefill) {
        oai.continue_prefill = true;
        prefillWasForced = true;
        debugLog('seamless: 临时开启 continue_prefill');
    }
}

function clonePromptMessage(message) {
    try {
        return structuredClone(message);
    } catch {
        try {
            return JSON.parse(JSON.stringify(message));
        } catch {
            return { ...message };
        }
    }
}

function normalizePromptMessage(message) {
    return {
        role: message?.role ?? null,
        content: clonePromptMessage(message?.content ?? null),
        tool_calls: clonePromptMessage(message?.tool_calls ?? null),
        tool_call_id: message?.tool_call_id ?? null,
        name: message?.name ?? null,
        reasoning: message?.reasoning ?? null,
        reasoning_content: message?.reasoning_content ?? null,
        signature: message?.signature ?? null,
    };
}

function arePromptMessagesEqual(left, right) {
    return JSON.stringify(normalizePromptMessage(left)) === JSON.stringify(normalizePromptMessage(right));
}

function promptEndsWithMessages(chat, suffix) {
    if (!Array.isArray(chat) || !Array.isArray(suffix) || suffix.length === 0 || chat.length < suffix.length) {
        return false;
    }

    const offset = chat.length - suffix.length;
    for (let i = 0; i < suffix.length; i++) {
        if (!arePromptMessagesEqual(chat[offset + i], suffix[i])) {
            return false;
        }
    }

    return true;
}

function getSeamlessPromptMessageKey(message) {
    if (message?.role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        const toolCallIds = message.tool_calls
            .map((toolCall) => String(toolCall?.id ?? '').trim())
            .filter(Boolean);
        if (toolCallIds.length > 0) {
            return `assistant:${toolCallIds.join('|')}`;
        }
    }

    if (message?.role === 'tool' && message?.tool_call_id) {
        return `tool:${String(message.tool_call_id).trim()}`;
    }

    return null;
}

function promptEndsWithSeamlessSequence(chat, suffix) {
    if (!Array.isArray(chat) || !Array.isArray(suffix) || suffix.length === 0 || chat.length < suffix.length) {
        return false;
    }

    const offset = chat.length - suffix.length;
    for (let i = 0; i < suffix.length; i++) {
        if (getSeamlessPromptMessageKey(chat[offset + i]) !== getSeamlessPromptMessageKey(suffix[i])) {
            return false;
        }
    }

    return true;
}

function collapseRepeatedSeamlessPromptSuffix(chat, suffix) {
    if (!Array.isArray(chat) || !Array.isArray(suffix) || suffix.length === 0) {
        return 0;
    }

    let removedCopies = 0;
    const doubledSuffix = [...suffix, ...suffix];
    while (chat.length >= doubledSuffix.length && promptEndsWithSeamlessSequence(chat, doubledSuffix)) {
        chat.splice(chat.length - doubledSuffix.length, suffix.length);
        removedCopies++;
    }

    return removedCopies;
}

function buildSeamlessPromptMessages() {
    const messages = [];

    for (const turn of turnHistory) {
        const assistantMsg = /** @type {any} */ (Object.assign(
            { role: 'assistant', content: '', tool_calls: turn.calls },
            turn.extra?.reasoning ? { reasoning: turn.extra.reasoning } : {},
            turn.extra?.reasoning_signature ? { signature: turn.extra.reasoning_signature } : {},
            turn.extra?.reasoning_content ? { reasoning_content: turn.extra.reasoning_content } : {},
        ));
        messages.push(clonePromptMessage(assistantMsg));

        for (const r of turn.results) {
            if (!r?.id) {
                continue;
            }
            messages.push({
                role: 'tool',
                tool_call_id: r.id,
                content: r.content,
            });
        }
    }

    return messages;
}

function applySeamlessPromptInjection(chat, source = 'unknown') {
    if (!seamlessActive || turnHistory.length === 0 || !Array.isArray(chat)) return false;
    if (isBackgroundPromptAssemblyActive()) {
        return false;
    }

    const lastChatMessage = chat[chat.length - 1];
    if (lastChatMessage?.role === 'assistant' && !lastChatMessage.tool_calls && !lastChatMessage.content) {
        chat.pop();
    }

    const injectedMessages = buildSeamlessPromptMessages();
    if (injectedMessages.length === 0) {
        return false;
    }

    const removedCopies = collapseRepeatedSeamlessPromptSuffix(chat, injectedMessages);
    if (removedCopies > 0) {
        debugLog(`seamless prompt 去重(${source}): 移除了 ${removedCopies} 组重复尾部注入`);
    }
    if (promptEndsWithMessages(chat, injectedMessages) || promptEndsWithSeamlessSequence(chat, injectedMessages)) {
        return false;
    }

    chat.push(...injectedMessages.map(clonePromptMessage));
    debugLog(`seamless prompt 注入(${source}): ${turnHistory.length} 轮历史, 共 ${pendingInvocations.length} 个工具调用`);
    return true;
}

async function onSeamlessGenerationEnded() {
    if (!seamlessActive) return;

    syncSeamlessStopRequest();

    const context = SillyTavern.getContext();
    if (lastHadToolCalls && toolResultsInOrder.length > 0 && seamlessDepth < SEAMLESS_LIMIT && !seamlessStopAfterCurrentTurn) {
        seamlessDepth++;
        recordTurnToHistory(toolResultsInOrder);
        lastHadToolCalls = false;
        toolResultsInOrder = [];

        const { chat } = context;
        const lastMsg = chat[chat.length - 1];
        if (lastMsg?.extra) {
            lastMsg.extra.reasoning = '';
            lastMsg.extra.reasoning_duration = null;
            lastMsg.extra.reasoning_type = null;
            lastMsg.extra.reasoning_signature = null;
            lastMsg.extra.reasoning_display_text = null;
        }

        ensureContinuePrefill();
        debugLog(`seamless: 第 ${seamlessDepth} 轮，触发 continue 续写`);

        const pollAndContinue = () => {
            if (SillyTavern.getContext().streamingProcessor !== null) {
                setTimeout(pollAndContinue, 10);
                return;
            }
            debugLog('seamless: streamingProcessor 已清理，启动 continue');
            context.generate('continue', { automatic_trigger: true }).catch((e) => {
                console.error(`[${MODULE_NAME}] seamless continue 失败:`, e);
                toastr.error(`Seamless continue 失败: ${e?.message ?? e}`, MODULE_NAME);
                resetSeamlessState();
            });
        };
        setTimeout(pollAndContinue, 0);
    } else if (lastHadToolCalls && toolResultsInOrder.length > 0 && seamlessStopAfterCurrentTurn) {
        recordTurnToHistory(toolResultsInOrder);
        lastHadToolCalls = false;
        toolResultsInOrder = [];

        const { chat } = context;
        const lastMsg = chat[chat.length - 1];
        if (lastMsg?.extra) {
            lastMsg.extra.stoolbook_seamless_stopped = true;
        }

        debugLog('seamless: 工具请求停止循环，跳过后续 continue');
        finalizeSeamlessReasoning();
        try {
            await context.saveChat();
        } catch (e) {
            console.error(`[${MODULE_NAME}] seamless save 失败:`, e);
        }
        resetSeamlessState();
    } else {
        debugLog(`seamless: 循环结束 (depth=${seamlessDepth})`);
        finalizeSeamlessReasoning();
        try {
            await context.saveChat();
        } catch (e) {
            console.error(`[${MODULE_NAME}] seamless save 失败:`, e);
        }
        resetSeamlessState();
    }
}

function onSeamlessPromptReady(data) {

    applySeamlessPromptInjection(data.chat, 'CHAT_COMPLETION_PROMPT_READY');
}

function installGlobalPromptCompat() {
    globalThis.SToolBookPromptCompat = {
        applySeamlessPromptInjection(prompt, source = 'external') {
            return applySeamlessPromptInjection(prompt, source);
        },
        getSeamlessPromptMessages() {
            return buildSeamlessPromptMessages();
        },
    };
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
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            const debugToggle = document.querySelector('.stoolbook_debug_toggle');
            if (debugToggle instanceof HTMLElement) {
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

        const settings = getSettings();

        function syncSeamlessUI() {
            const seamless = getSettings().seamlessToolLoop;
            const $merge = $('#stoolbook_turn_merging');
            const $pin = $('#stoolbook_pin_newest_turn');
            $merge.prop('disabled', seamless);
            $pin.prop('disabled', seamless);
            $('.stoolbook_sub_option').toggleClass('stoolbook_disabled', seamless);
        }

        $('#stoolbook_seamless_tool_loop').prop('checked', settings.seamlessToolLoop);
        $('#stoolbook_seamless_tool_loop').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].seamlessToolLoop = $(this).prop('checked');
            saveSettingsDebounced();
            syncSeamlessUI();
        });

        $('#stoolbook_turn_merging').prop('checked', settings.turnMerging);
        $('#stoolbook_turn_merging').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].turnMerging = $(this).prop('checked');
            saveSettingsDebounced();
            if (ext[MODULE_NAME].turnMerging) scheduleMerge();
        });

        $('#stoolbook_pin_newest_turn').prop('checked', settings.pinNewestTurn);
        $('#stoolbook_pin_newest_turn').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].pinNewestTurn = $(this).prop('checked');
            saveSettingsDebounced();
        });

        $('#stoolbook_reasoning_passback').prop('checked', settings.reasoningPassback);
        $('#stoolbook_reasoning_passback').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].reasoningPassback = $(this).prop('checked');
            saveSettingsDebounced();
        });

        $('#stoolbook_debug_mode').prop('checked', settings.debugMode);
        if (settings.debugMode) {
            $('.stoolbook_debug_toggle').show();
        }
        $('#stoolbook_debug_mode').on('change', function () {
            const ext = SillyTavern.getContext().extensionSettings;
            ext[MODULE_NAME].debugMode = $(this).prop('checked');
            saveSettingsDebounced();
        });

        syncSeamlessUI();
        setupDebugUnlock();

        $(document).on('click', '[class*="stoolbook-tool-summary"] > summary', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const details = $(this).closest('details');
            if (details.attr('open') !== undefined) {
                details.removeAttr('open');
            } else {
                details.attr('open', '');
            }
        });

        installSeamlessOverrides();
        installGlobalPromptCompat();
        installGlobalToolApiBridge();

        if (typeof eventSource.makeLast === 'function') {
            eventSource.makeLast(event_types.GENERATE_AFTER_DATA, (data) => applySeamlessPromptInjection(data?.prompt, 'GENERATE_AFTER_DATA'));
            eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, (data) => {
                if (data?.type !== 'continue') {
                    return;
                }
                applySeamlessPromptInjection(data?.messages, 'CHAT_COMPLETION_SETTINGS_READY');
            });
        } else {
            eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (data) => {
                if (data?.type !== 'continue') {
                    return;
                }
                applySeamlessPromptInjection(data?.messages, 'CHAT_COMPLETION_SETTINGS_READY');
            });
        }

        scanExistingEntries();
        observeEntries();
        observeBody();

        if (getSettings().turnMerging && !getSettings().seamlessToolLoop) {
            scheduleMerge();
        }
    });

    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);

    eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => {
        if (dryRun) return;

        const s = getSettings();
        if (s.seamlessToolLoop && !seamlessActive) {
            seamlessActive = true;
            clearSeamlessLoopStopRequest();
            resetSeamlessState();
            seamlessActive = true;
            debugLog('seamless: 激活');
        }

        if (!s.seamlessToolLoop) {
            isGenerating = true;
            cancelMerge();
        }
    });

    eventSource.on(event_types.GENERATION_ENDED, async () => {
        debugLog('事件: GENERATION_ENDED');

        try {
            await flushPendingStepReplyAugment();
        } catch (e) {
            console.error(`[${MODULE_NAME}] flushPendingStepReplyAugment 失败:`, e);
        }

        if (seamlessActive && getSettings().seamlessToolLoop) {
            await onSeamlessGenerationEnded();
            return;
        }

        isGenerating = false;
        if (!getSettings().seamlessToolLoop) {
            scheduleMerge();
        }
    });

    eventSource.on(event_types.GENERATION_STOPPED, () => {
        debugLog('事件: GENERATION_STOPPED');

        if (seamlessActive) {
            debugLog('seamless: 用户停止，重置状态');
            resetSeamlessState();
        }

        isGenerating = false;
        if (!getSettings().seamlessToolLoop) {
            scheduleMerge();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        debugLog('事件: CHAT_CHANGED');
        if (!getSettings().seamlessToolLoop) {
            scheduleMerge();
        }
    });

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (data?.dryRun) return;

        onSeamlessPromptReady(data);

        if (getSettings().reasoningPassback) {
            passbackReasoningContent(data);
        }

        if (!getSettings().seamlessToolLoop && getSettings().pinNewestTurn) {
            pinNewestTurnToBottom(data);
        }
    });

    window.addEventListener('beforeunload', () => {
        unregisterAllTools();
    });
})();
