import {
    extractJsonFromData,
    ensureSwipes,
    setCharacterId,
    setCharacterName,
    syncMesToSwipe,
} from '../../../../script.js';
import { sendOpenAIRequest } from '../../../openai.js';
import { updateReasoningUI } from '../../../reasoning.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { trimToEndSentence } from '../../../utils.js';
import { MODULE_NAME, REQUIRED_TOOL_KEYS, TOOL_ID_PREFIX } from './constants.js';

/**
 * @typedef {{ enabled: boolean, code: string, valid: boolean, uuid: string }} StoredToolData
 */

/**
 * @typedef {{ worldName: string, uid: string|number, entryKey: string, stoolbook: StoredToolData }} LoadedToolEntry
 */

/**
 * @typedef {{
 *   toolId: string,
 *   originalName: string,
 *   displayName: string,
 *   worldName: string,
 *   uid: string|number,
 *   entryKey: string,
 * }} RegisteredToolMeta
 */

/**
 * @typedef {{
 *   messageId: number | null,
 *   content: string,
 *   reasoning: string,
 *   reasoningDisplayText: string | null,
 *   reasoningSignature: string | null,
 *   existsInChat: boolean,
 * }} StepReplyState
 */

const GLOBAL_TOOL_API_BRIDGE_KEY = 'SToolBookToolAPI';
const WRAPPED_TOOL_HANDLER_MARK = Symbol('stoolbookWrappedToolHandler');
const registeredTools = new Map();
const registeredToolMeta = new Map();
const loadedToolEntries = new Map();
const activatedEntries = new Set();
const toolBatchStack = [];
const toolInvocationStack = [];
let backgroundPromptAssemblyChain = Promise.resolve();
let backgroundPromptAssemblyDepth = 0;
/** @type {{ requestedAt: number, reason: string | null, tool: RegisteredToolMeta | null } | null} */
let seamlessLoopStopRequest = null;
/** @type {{ messageId: number | null, contentAppend: string } | null} */
let pendingStepReplyAugment = null;

function clearPendingStepReplyAugment() {
    pendingStepReplyAugment = null;
}

/**
 * @param {string | null | undefined} toolName
 * @param {string | null | undefined} displayName
 * @returns {RegisteredToolMeta | null}
 */
function createFallbackToolMeta(toolName, displayName = null) {
    const normalizedName = String(toolName ?? '').trim();
    if (!normalizedName) {
        return null;
    }

    const normalizedDisplayName = String(displayName ?? normalizedName).trim() || normalizedName;
    return {
        toolId: normalizedName,
        originalName: normalizedName,
        displayName: normalizedDisplayName,
        worldName: '',
        uid: '',
        entryKey: normalizedName,
    };
}

/**
 * @param {string | null | undefined} toolName
 * @param {string | null | undefined} displayName
 * @returns {RegisteredToolMeta | null}
 */
function resolveToolMeta(toolName = null, displayName = null) {
    const normalizedName = String(toolName ?? '').trim();
    if (!normalizedName) {
        return null;
    }

    if (registeredToolMeta.has(normalizedName)) {
        return registeredToolMeta.get(normalizedName) ?? null;
    }

    return createFallbackToolMeta(normalizedName, displayName);
}

/** @type {boolean} */
let globalToolApiBridgeInstalled = false;
/** @type {Function | null} */
let originalRegisterFunctionTool = null;

/**
 * @param {any} value
 * @returns {any}
 */
function cloneValue(value) {
    if (value === undefined) return undefined;

    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} worldName
 * @param {string|number} uid
 * @param {string} toolName
 * @returns {string}
 */
function makeToolId(worldName, uid, toolName) {
    void worldName;
    void uid;
    return `${TOOL_ID_PREFIX}${toolName}`;
}

/**
 * @param {any} message
 * @returns {boolean}
 */
function isAssistantMessage(message) {
    return !!message && !message.is_user && !message.is_system;
}

/**
 * @param {StepReplyState | null | undefined} state
 * @returns {StepReplyState}
 */
function cloneStepState(state) {
    if (!state) {
        return {
            messageId: null,
            content: '',
            reasoning: '',
            reasoningDisplayText: '',
            reasoningSignature: null,
            existsInChat: false,
        };
    }

    return {
        messageId: typeof state.messageId === 'number' ? state.messageId : null,
        content: String(state.content ?? ''),
        reasoning: String(state.reasoning ?? ''),
        reasoningDisplayText: state.reasoningDisplayText == null ? null : String(state.reasoningDisplayText),
        reasoningSignature: state.reasoningSignature == null ? null : String(state.reasoningSignature),
        existsInChat: Boolean(state.existsInChat),
    };
}

/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeNullableString(value) {
    if (value == null) return null;
    return String(value);
}

/**
 * @returns {RegisteredToolMeta | null}
 */
function getActiveToolMeta() {
    const activeInvocation = toolInvocationStack[toolInvocationStack.length - 1] ?? null;
    const activeToolId = activeInvocation?.name;
    const activeToolDisplayName = activeInvocation?.tool?.displayName ?? activeToolId ?? null;

    if (activeToolId) {
        return resolveToolMeta(activeToolId, activeToolDisplayName);
    }

    const activeBatch = toolBatchStack[toolBatchStack.length - 1] ?? null;
    const batchToolId = activeBatch?.toolId;
    if (batchToolId) {
        return resolveToolMeta(batchToolId, batchToolId);
    }

    return null;
}

/**
 * @param {string | null | undefined} reasoningText
 * @returns {StepReplyState}
 */
function createStepReplyState(reasoningText = null) {
    const context = SillyTavern.getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];

    let messageId = null;
    const streamingMessageId = context.streamingProcessor?.messageId;
    if (Number.isInteger(streamingMessageId) && streamingMessageId >= 0 && isAssistantMessage(chat[streamingMessageId])) {
        messageId = streamingMessageId;
    } else if (chat.length > 0 && isAssistantMessage(chat[chat.length - 1])) {
        messageId = chat.length - 1;
    }

    const message = typeof messageId === 'number' ? chat[messageId] : null;
    const reasoning = String(message?.extra?.reasoning ?? reasoningText ?? '');
    const reasoningDisplayText = message?.extra?.reasoning_display_text != null
        ? String(message.extra.reasoning_display_text)
        : reasoning;

    return {
        messageId,
        content: String(message?.mes ?? ''),
        reasoning,
        reasoningDisplayText,
        reasoningSignature: normalizeNullableString(message?.extra?.reasoning_signature ?? context.streamingProcessor?.reasoningSignature ?? null),
        existsInChat: Boolean(message),
    };
}

/**
 * @returns {StepReplyState}
 */
function getCurrentStepReplyState() {
    const activeBatch = toolBatchStack[toolBatchStack.length - 1] ?? null;
    if (activeBatch?.step) {
        return activeBatch.step;
    }

    return createStepReplyState();
}

/**
 * @param {number | null | undefined} messageId
 * @returns {{ messageId: number | null, contentAppend: string } | null}
 */
function getPendingStepReplyAugment(messageId = null) {
    if (!Number.isInteger(messageId) || messageId < 0) {
        return null;
    }

    if (!pendingStepReplyAugment || pendingStepReplyAugment.messageId !== messageId) {
        pendingStepReplyAugment = {
            messageId,
            contentAppend: '',
        };
    }

    return pendingStepReplyAugment;
}

/**
 * @param {number | null | undefined} messageId
 * @param {string} content
 */
function queuePendingContentAppend(messageId, content) {
    const appendText = String(content ?? '');
    if (!appendText) {
        return;
    }

    const augment = getPendingStepReplyAugment(messageId);
    if (!augment) {
        return;
    }

    augment.contentAppend += appendText;
}

export async function flushPendingStepReplyAugment() {
    const augment = pendingStepReplyAugment;
    clearPendingStepReplyAugment();

    if (!augment?.contentAppend || !Number.isInteger(augment.messageId) || augment.messageId < 0) {
        return false;
    }

    const context = SillyTavern.getContext();
    const message = context.chat?.[augment.messageId];
    if (!message || !isAssistantMessage(message)) {
        return false;
    }

    return await applyStepReplyPatch({ content: `${String(message.mes ?? '')}${augment.contentAppend}` }, { emitUpdate: true });
}

/**
 * @param {Partial<StepReplyState>} patch
 * @param {{ syncDisplayText?: boolean, emitUpdate?: boolean }} [options]
 * @returns {Promise<StepReplyState>}
 */
async function applyStepReplyPatch(patch, options = {}) {
    const { syncDisplayText = true, emitUpdate = true } = options;
    const step = getCurrentStepReplyState();

    if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
        step.content = String(patch.content ?? '');
    }

    const reasoningWasPatched = Object.prototype.hasOwnProperty.call(patch, 'reasoning');
    if (reasoningWasPatched) {
        step.reasoning = String(patch.reasoning ?? '');
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'reasoningDisplayText')) {
        step.reasoningDisplayText = normalizeNullableString(patch.reasoningDisplayText);
    } else if (reasoningWasPatched && syncDisplayText) {
        step.reasoningDisplayText = step.reasoning;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'reasoningSignature')) {
        step.reasoningSignature = normalizeNullableString(patch.reasoningSignature);
    }

    if (typeof step.messageId === 'number') {
        if (reasoningWasPatched && !step.reasoning) {
            step.reasoningDisplayText = null;
        }

        const context = SillyTavern.getContext();
        const message = context.chat?.[step.messageId];

        if (message && isAssistantMessage(message)) {
            ensureSwipes(message);

            message.mes = step.content;
            if (!message.extra || typeof message.extra !== 'object') {
                message.extra = {};
            }

            message.extra.reasoning = step.reasoning;
            if (step.reasoningDisplayText == null) {
                delete message.extra.reasoning_display_text;
            } else {
                message.extra.reasoning_display_text = step.reasoningDisplayText;
            }

            if (step.reasoningSignature == null) {
                delete message.extra.reasoning_signature;
            } else {
                message.extra.reasoning_signature = step.reasoningSignature;
            }

            delete message.extra.display_text;
            step.existsInChat = true;

            syncMesToSwipe(step.messageId);
            context.updateMessageBlock(step.messageId, message, { rerenderMessage: true });
            updateReasoningUI(step.messageId);

            if (emitUpdate && context.eventSource && context.eventTypes?.MESSAGE_UPDATED) {
                await context.eventSource.emit(context.eventTypes.MESSAGE_UPDATED, step.messageId);
                await context.saveChat?.();
            }
        } else {
            step.messageId = null;
            step.existsInChat = false;
        }
    }

    return cloneStepState(step);
}

/**
 * @param {(current: StepReplyState) => Partial<StepReplyState> | Promise<Partial<StepReplyState>>} updater
 * @param {{ syncDisplayText?: boolean, emitUpdate?: boolean }} [options]
 * @returns {Promise<StepReplyState>}
 */
async function updateCurrentStepReply(updater, options = {}) {
    if (typeof updater !== 'function') {
        throw new Error('reply.update 需要传入 updater 函数');
    }

    const current = cloneStepState(getCurrentStepReplyState());
    const patch = await updater(current);

    if (!patch || typeof patch !== 'object') {
        return current;
    }

    return applyStepReplyPatch(patch, options);
}

/**
 * @param {Record<string, any>} extensionPrompts
 * @returns {Record<string, any>}
 */
function cloneExtensionPromptMap(extensionPrompts) {
    const snapshot = {};

    if (!extensionPrompts || typeof extensionPrompts !== 'object') {
        return snapshot;
    }

    for (const [key, value] of Object.entries(extensionPrompts)) {
        snapshot[key] = value && typeof value === 'object' ? { ...value } : value;
    }

    return snapshot;
}

/**
 * @param {Record<string, any>} extensionPrompts
 * @param {Record<string, any>} snapshot
 */
function restoreExtensionPromptMap(extensionPrompts, snapshot) {
    if (!extensionPrompts || typeof extensionPrompts !== 'object') {
        return;
    }

    for (const key of Object.keys(extensionPrompts)) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
            delete extensionPrompts[key];
        }
    }

    for (const [key, value] of Object.entries(snapshot ?? {})) {
        extensionPrompts[key] = value && typeof value === 'object' ? { ...value } : value;
    }
}

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function queueBackgroundPromptAssembly(task) {
    const queuedTask = async () => await task();
    const nextTask = backgroundPromptAssemblyChain.then(queuedTask, queuedTask);
    backgroundPromptAssemblyChain = nextTask.catch(() => { });
    return nextTask;
}

/**
 * @param {AbortSignal|AbortController|null|undefined} signalLike
 * @returns {AbortSignal|null|undefined}
 */
function normalizeAbortSignal(signalLike) {
    if (!signalLike) {
        return signalLike;
    }

    if (typeof AbortController !== 'undefined' && signalLike instanceof AbortController) {
        return signalLike.signal;
    }

    return signalLike;
}

/**
 * @returns {boolean}
 */
export function isBackgroundPromptAssemblyActive() {
    return backgroundPromptAssemblyDepth > 0;
}

/**
 * 使用现有 Generate 的 dryRun 管线构造完整聊天补全消息，
 * 以保留聊天记录、预设、世界书与扩展注入，但真正请求阶段不会占用主生成状态。
 *
 * @param {any} params
 * @returns {Promise<any[]>}
 */
async function buildBackgroundChatMessages(params = {}) {
    const context = SillyTavern.getContext();

    if (context.mainApi !== 'openai') {
        throw new Error('background 请求目前仅支持聊天补全（mainApi=openai）');
    }

    return queueBackgroundPromptAssembly(async () => {
        const originalCharacterId = context.characterId;
        const originalCharacterName = context.name2;
        const extensionPromptSnapshot = cloneExtensionPromptMap(context.extensionPrompts);
        const type = params.type ?? (params.quietPrompt ? 'quiet' : 'normal');
        const forceName2 = Object.prototype.hasOwnProperty.call(params, 'forceName2')
            ? params.forceName2
            : (type === 'quiet');

        /** @type {any[] | null} */
        let generatedMessages = null;
        const captureGeneratedData = (generateData, dryRun) => {
            if (!dryRun) {
                return;
            }

            if (Array.isArray(generateData?.prompt)) {
                generatedMessages = cloneValue(generateData.prompt);
            }
        };

        context.eventSource.on(context.eventTypes.GENERATE_AFTER_DATA, captureGeneratedData);

        try {
            backgroundPromptAssemblyDepth++;
            await context.generate(type, {
                automatic_trigger: params.automaticTrigger ?? false,
                force_name2: forceName2,
                quiet_prompt: params.quietPrompt ?? '',
                quietToLoud: params.quietToLoud ?? false,
                skipWIAN: params.skipWIAN ?? false,
                force_chid: params.forceChId ?? null,
                quietImage: params.quietImage ?? null,
                quietName: params.quietName ?? null,
                jsonSchema: params.jsonSchema ?? null,
                depth: params.depth ?? 0,
            }, true);
        } finally {
            backgroundPromptAssemblyDepth = Math.max(0, backgroundPromptAssemblyDepth - 1);
            context.eventSource.removeListener(context.eventTypes.GENERATE_AFTER_DATA, captureGeneratedData);
            restoreExtensionPromptMap(context.extensionPrompts, extensionPromptSnapshot);
            if (context.characterId !== originalCharacterId) {
                setCharacterId(originalCharacterId);
            }
            if (context.name2 !== originalCharacterName) {
                setCharacterName(originalCharacterName ?? '');
            }
        }

        if (!Array.isArray(generatedMessages) || generatedMessages.length === 0) {
            throw new Error('未能捕获后台聊天补全所需的 prompt 消息');
        }

        return generatedMessages;
    });
}

/**
 * @param {any} params
 * @param {{ returnRawData?: boolean }} [options]
 * @returns {Promise<any>}
 */
async function executeBackgroundChatRequest(params = {}, options = {}) {
    const context = SillyTavern.getContext();
    const messages = await buildBackgroundChatMessages(params);
    const response = await sendOpenAIRequest('quiet', messages, normalizeAbortSignal(params.signal), { jsonSchema: params.jsonSchema ?? null });

    if (options.returnRawData) {
        return response;
    }

    if (params.jsonSchema) {
        return extractJsonFromData(response, { mainApi: 'openai' });
    }

    let result = context.extractMessageFromData(response, 'openai');
    result = params.trimToSentence ? trimToEndSentence(result) : result;
    result = params.removeReasoning === false ? result : removeReasoningFromString(result);
    return result;
}

/**
 * @param {any} task
 * @param {'quietPrompt'|'raw'|'rawData'|'background'|'backgroundData'} defaultMode
 * @returns {Promise<any>}
 */
async function executeSilentRequestTask(task, defaultMode) {
    const context = SillyTavern.getContext();

    if (typeof task === 'string') {
        return context.generateQuietPrompt({ quietPrompt: task });
    }

    if (!task || typeof task !== 'object') {
        throw new Error('静默请求任务必须是字符串或对象');
    }

    const hasExplicitParams = Object.prototype.hasOwnProperty.call(task, 'params');
    const params = hasExplicitParams ? task.params : task;
    const mode = task.mode ?? defaultMode;

    switch (mode) {
        case 'quiet':
        case 'quietPrompt':
            return context.generateQuietPrompt(params);
        case 'raw':
            return context.generateRaw(params);
        case 'rawData':
            return context.generateRawData(params);
        case 'background':
        case 'backgroundChat':
            return executeBackgroundChatRequest(params);
        case 'backgroundData':
        case 'backgroundChatData':
            return executeBackgroundChatRequest(params, { returnRawData: true });
        default:
            throw new Error(`不支持的静默请求模式: ${mode}`);
    }
}

/**
 * @param {any[]} tasks
 * @param {{ settle?: boolean, defaultMode?: 'quietPrompt'|'raw'|'rawData'|'background'|'backgroundData' }} [options]
 * @returns {Promise<any[]>}
 */
async function runSilentRequestsInParallel(tasks, options = {}) {
    const { settle = false, defaultMode = 'quietPrompt' } = options;

    if (!Array.isArray(tasks)) {
        throw new Error('parallel 请求必须传入数组');
    }

    const jobList = tasks.map((task) => executeSilentRequestTask(task, defaultMode));
    return settle ? Promise.allSettled(jobList) : Promise.all(jobList);
}

/**
 * @param {RegisteredToolMeta | null} toolMeta
 * @returns {any}
 */
export function requestSeamlessLoopStop(reason = null) {
    seamlessLoopStopRequest = {
        requestedAt: Date.now(),
        reason: normalizeNullableString(reason),
        tool: cloneValue(getActiveToolMeta()),
    };
    return cloneValue(seamlessLoopStopRequest);
}

/**
 * @returns {{ requestedAt: number, reason: string | null, tool: RegisteredToolMeta | null } | null}
 */
export function getSeamlessLoopStopRequest() {
    return cloneValue(seamlessLoopStopRequest);
}

/**
 * @returns {{ requestedAt: number, reason: string | null, tool: RegisteredToolMeta | null } | null}
 */
export function clearSeamlessLoopStopRequest() {
    const currentRequest = seamlessLoopStopRequest;
    seamlessLoopStopRequest = null;
    return cloneValue(currentRequest);
}

function createToolApi(toolMeta) {
    const reply = {
        get() {
            return cloneStepState(getCurrentStepReplyState());
        },
        set(patch, options) {
            return applyStepReplyPatch(patch ?? {}, options);
        },
        update(updater, options) {
            return updateCurrentStepReply(updater, options);
        },
        getContent() {
            return getCurrentStepReplyState().content;
        },
        setContent(content, options) {
            return applyStepReplyPatch({ content }, options);
        },
        appendContent(content, options) {
            queuePendingContentAppend(getCurrentStepReplyState().messageId, content);
            const current = getCurrentStepReplyState();
            return applyStepReplyPatch({ content: `${current.content}${String(content ?? '')}` }, options);
        },
        getReasoning() {
            return getCurrentStepReplyState().reasoning;
        },
        setReasoning(reasoning, options = {}) {
            return applyStepReplyPatch({
                reasoning,
                reasoningDisplayText: Object.prototype.hasOwnProperty.call(options, 'reasoningDisplayText')
                    ? options.reasoningDisplayText
                    : undefined,
            }, options);
        },
        appendReasoning(reasoning, options = {}) {
            const current = getCurrentStepReplyState();
            return applyStepReplyPatch({
                reasoning: `${current.reasoning}${String(reasoning ?? '')}`,
                reasoningDisplayText: Object.prototype.hasOwnProperty.call(options, 'reasoningDisplayText')
                    ? options.reasoningDisplayText
                    : undefined,
            }, options);
        },
    };

    const loop = {
        stop(reason = null) {
            const request = requestSeamlessLoopStop(reason);
            return {
                stopRequested: true,
                request,
            };
        },
        getState() {
            return {
                stopRequested: Boolean(seamlessLoopStopRequest),
                request: cloneValue(seamlessLoopStopRequest),
            };
        },
    };

    const api = {
        tool: {
            getInfo() {
                return cloneValue(toolMeta);
            },
            getInvocation() {
                const invocation = toolInvocationStack[toolInvocationStack.length - 1] ?? null;
                return cloneValue(invocation);
            },
        },
        step: {
            get() {
                return cloneStepState(getCurrentStepReplyState());
            },
            getMessageId() {
                return getCurrentStepReplyState().messageId;
            },
            getSourceData() {
                const activeBatch = toolBatchStack[toolBatchStack.length - 1] ?? null;
                return cloneValue(activeBatch?.data ?? null);
            },
            reply,
        },
        loop,
        seamless: loop,
        reply,
        request: {
            quiet(params) {
                return SillyTavern.getContext().generateQuietPrompt(params);
            },
            quietPrompt(params) {
                return SillyTavern.getContext().generateQuietPrompt(params);
            },
            raw(params) {
                return SillyTavern.getContext().generateRaw(params);
            },
            rawData(params) {
                return SillyTavern.getContext().generateRawData(params);
            },
            background(params) {
                return executeBackgroundChatRequest(params);
            },
            backgroundChat(params) {
                return executeBackgroundChatRequest(params);
            },
            backgroundData(params) {
                return executeBackgroundChatRequest(params, { returnRawData: true });
            },
            backgroundChatData(params) {
                return executeBackgroundChatRequest(params, { returnRawData: true });
            },
            parallel(tasks, options = {}) {
                return runSilentRequestsInParallel(tasks, options);
            },
            parallelQuiet(tasks, options = {}) {
                return runSilentRequestsInParallel(tasks, { ...options, defaultMode: 'quietPrompt' });
            },
            parallelRaw(tasks, options = {}) {
                return runSilentRequestsInParallel(tasks, { ...options, defaultMode: 'raw' });
            },
            parallelBackground(tasks, options = {}) {
                return runSilentRequestsInParallel(tasks, { ...options, defaultMode: 'background' });
            },
            allSettled(tasks, options = {}) {
                return runSilentRequestsInParallel(tasks, { ...options, settle: true });
            },
        },
        util: {
            log(...args) {
                const toolLabel = toolMeta?.toolId ? `[${toolMeta.toolId}]` : '';
                console.log(`[${MODULE_NAME}]${toolLabel}`, ...args);
            },
            sleep(ms = 0) {
                return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
            },
            clone: cloneValue,
        },
    };

    return api;
}

/**
 * @param {string | null | undefined} toolName
 * @returns {any}
 */
export function getToolApi(toolName = null) {
    return createToolApi(resolveToolMeta(toolName) ?? getActiveToolMeta());
}

/**
 * @param {Function | undefined} handler
 * @param {string} toolName
 * @param {string | null | undefined} displayName
 * @returns {Function | undefined}
 */
function wrapToolHandlerWithApi(handler, toolName, displayName = null) {
    if (typeof handler !== 'function' || handler[WRAPPED_TOOL_HANDLER_MARK]) {
        return handler;
    }

    const wrapped = async function (...args) {
        const api = getToolApi(toolName || displayName || null);
        return await handler.apply(this, [...args, api]);
    };

    wrapped[WRAPPED_TOOL_HANDLER_MARK] = true;
    return wrapped;
}

export function installGlobalToolApiBridge() {
    if (globalToolApiBridgeInstalled) {
        return;
    }

    const { ToolManager } = SillyTavern.getContext();
    originalRegisterFunctionTool = ToolManager.registerFunctionTool.bind(ToolManager);

    ToolManager.registerFunctionTool = function (toolDefinition, ...restArgs) {
        if (toolDefinition && typeof toolDefinition === 'object') {
            const toolName = String(toolDefinition.name ?? '').trim();
            const displayName = String(toolDefinition.displayName ?? toolName).trim() || toolName;
            toolDefinition = {
                ...toolDefinition,
                action: wrapToolHandlerWithApi(toolDefinition.action, toolName, displayName),
                formatMessage: wrapToolHandlerWithApi(toolDefinition.formatMessage, toolName, displayName),
            };
        }

        return originalRegisterFunctionTool(toolDefinition, ...restArgs);
    };

    globalThis[GLOBAL_TOOL_API_BRIDGE_KEY] = {
        getApi: (toolName = null) => getToolApi(toolName),
        current: (toolName = null) => getToolApi(toolName),
    };
    globalToolApiBridgeInstalled = true;
}

/**
 * @returns {any}
 */
function createValidationToolApi() {
    const replyState = cloneStepState(null);
    const noopAsync = async () => cloneStepState(replyState);

    const reply = {
        get() {
            return cloneStepState(replyState);
        },
        set: noopAsync,
        update: noopAsync,
        getContent() {
            return '';
        },
        setContent: noopAsync,
        appendContent: noopAsync,
        getReasoning() {
            return '';
        },
        setReasoning: noopAsync,
        appendReasoning: noopAsync,
    };

    return {
        tool: {
            getInfo() {
                return null;
            },
            getInvocation() {
                return null;
            },
        },
        step: {
            get() {
                return cloneStepState(replyState);
            },
            getMessageId() {
                return null;
            },
            getSourceData() {
                return null;
            },
            reply,
        },
        loop: {
            stop(reason = null) {
                return {
                    stopRequested: false,
                    request: reason == null ? null : { reason: normalizeNullableString(reason) },
                    validationOnly: true,
                };
            },
            getState() {
                return { stopRequested: false, request: null, validationOnly: true };
            },
        },
        seamless: undefined,
        reply,
        request: {
            quiet: async () => '',
            quietPrompt: async () => '',
            background: async () => '',
            backgroundChat: async () => '',
            backgroundData: async () => ({}),
            backgroundChatData: async () => ({}),
            raw: async () => '',
            rawData: async () => ({}),
            parallel: async () => [],
            parallelQuiet: async () => [],
            parallelRaw: async () => [],
            parallelBackground: async () => [],
            allSettled: async () => [],
        },
        util: {
            log() { },
            sleep(ms = 0) {
                return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
            },
            clone: cloneValue,
        },
    };
}


/**
 * @param {any} toolDef
 * @returns {{ valid: boolean, error?: string }}
 */
function validateToolDefinition(toolDef) {
    if (toolDef === null || toolDef === undefined || typeof toolDef !== 'object') {
        return { valid: false, error: '代码必须返回一个对象' };
    }

    const missing = REQUIRED_TOOL_KEYS.filter((key) => !(key in toolDef));
    if (missing.length > 0) {
        return { valid: false, error: `缺少必要属性: ${missing.join(', ')}` };
    }

    if (typeof toolDef.name !== 'string' || !toolDef.name.trim()) {
        return { valid: false, error: 'name 必须是非空字符串' };
    }

    if (typeof toolDef.description !== 'string') {
        return { valid: false, error: 'description 必须是字符串' };
    }

    if (!toolDef.parameters || typeof toolDef.parameters !== 'object') {
        return { valid: false, error: 'parameters 必须是对象' };
    }

    if (typeof toolDef.action !== 'function') {
        return { valid: false, error: 'action 必须是函数' };
    }

    return { valid: true };
}

/**
 * @param {string} code
 * @param {RegisteredToolMeta | null} toolMeta
 * @param {any} api
 * @returns {{ toolDef: any | null, error?: string }}
 */
function evaluateToolCode(code, toolMeta, api) {
    try {
        const factory = new Function('api', code);
        const toolDef = factory(api);
        const validation = validateToolDefinition(toolDef);

        if (!validation.valid) {
            return {
                toolDef: null,
                error: validation.error,
            };
        }

        return { toolDef };
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 执行工具代码失败:`, error);
        return {
            toolDef: null,
            error: getErrorMessage(error),
        };
    }
}

/**
 * @param {string} code
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateToolCode(code) {
    if (!code || !code.trim()) {
        return { valid: false, error: '代码不能为空' };
    }

    const { toolDef, error } = evaluateToolCode(code, null, createValidationToolApi());
    if (!toolDef) {
        return { valid: false, error: error || '工具代码无效' };
    }

    return { valid: true };
}

/**
 * @param {string} code
 * @param {RegisteredToolMeta} toolMeta
 * @returns {any | null}
 */
function executeToolCode(code, toolMeta) {
    if (!code || !code.trim()) return null;
    const { toolDef } = evaluateToolCode(code, toolMeta, createToolApi(toolMeta));
    return toolDef;
}

/**
 * @param {Array<{ worldName: string, uid: string|number, stoolbook: StoredToolData }>} entries
 * @returns {number}
 */
export function replaceLoadedToolEntries(entries) {
    loadedToolEntries.clear();

    for (const entry of Array.isArray(entries) ? entries : []) {
        const entryKey = `${entry.worldName}::${entry.uid}`;
        loadedToolEntries.set(entryKey, {
            worldName: entry.worldName,
            uid: entry.uid,
            entryKey,
            stoolbook: entry.stoolbook,
        });
    }

    return loadedToolEntries.size;
}

/**
 * @param {Array<{ world: string, uid: string|number }>} activatedList
 * @returns {number}
 */
export function replaceActivatedEntries(activatedList) {
    activatedEntries.clear();

    if (Array.isArray(activatedList)) {
        for (const entry of activatedList) {
            activatedEntries.add(`${entry.world}::${entry.uid}`);
        }
    }

    return activatedEntries.size;
}

export function unregisterAllTools() {
    const { unregisterFunctionTool } = SillyTavern.getContext();

    for (const [toolId] of registeredTools) {
        try {
            unregisterFunctionTool(toolId);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] 注销工具 ${toolId} 失败:`, error);
        }
    }

    registeredTools.clear();
    registeredToolMeta.clear();
    console.log(`[${MODULE_NAME}] 已注销所有工具`);
}

export function syncToolRegistrations() {
    const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();

    /** @type {Map<string, { toolDef: any, uuid: string, worldName: string, uid: string|number, entryKey: string, meta: RegisteredToolMeta }>} */
    const shouldRegister = new Map();

    for (const [entryKey, info] of loadedToolEntries) {
        const { worldName, uid, stoolbook } = info;

        if (!stoolbook?.valid || !stoolbook?.enabled) continue;
        if (!activatedEntries.has(entryKey)) continue;

        /** @type {RegisteredToolMeta} */
        const toolMeta = {
            toolId: '',
            originalName: '',
            displayName: '',
            worldName,
            uid,
            entryKey,
        };

        const toolDef = executeToolCode(stoolbook.code, toolMeta);
        if (!toolDef) continue;

        const toolId = makeToolId(worldName, uid, toolDef.name);
        toolMeta.toolId = toolId;
        toolMeta.originalName = toolDef.name;
        toolMeta.displayName = toolDef.displayName || toolDef.name;

        shouldRegister.set(toolId, {
            toolDef,
            uuid: stoolbook.uuid,
            worldName,
            uid,
            entryKey,
            meta: toolMeta,
        });
    }

    for (const [toolId, uuid] of registeredTools) {
        const target = shouldRegister.get(toolId);
        if (!target || target.uuid !== uuid) {
            try {
                unregisterFunctionTool(toolId);
            } catch {
                // ignore unregister failures during sync
            }
            registeredTools.delete(toolId);
            registeredToolMeta.delete(toolId);
        }
    }

    for (const [toolId, registration] of shouldRegister) {
        if (registeredTools.has(toolId) && registeredTools.get(toolId) === registration.uuid) {
            continue;
        }

        try {
            if (registeredTools.has(toolId)) {
                unregisterFunctionTool(toolId);
            }

            registerFunctionTool({
                name: toolId,
                displayName: registration.toolDef.displayName || registration.toolDef.name,
                description: registration.toolDef.description,
                parameters: registration.toolDef.parameters,
                action: async (args) => registration.toolDef.action(args, createToolApi(registration.meta)),
                formatMessage: typeof registration.toolDef.formatMessage === 'function'
                    ? async (args) => registration.toolDef.formatMessage(args, createToolApi(registration.meta))
                    : undefined,
                stealth: registration.toolDef.stealth ?? false,
                shouldRegister: () => activatedEntries.has(registration.entryKey),
            });

            registeredTools.set(toolId, registration.uuid);
            registeredToolMeta.set(toolId, registration.meta);
            console.log(`[${MODULE_NAME}] 已注册工具: ${toolId} (来自 ${registration.worldName}[${registration.uid}])`);
        } catch (error) {
            console.error(`[${MODULE_NAME}] 注册工具 ${toolId} 失败:`, error);
        }
    }
}

/**
 * @param {{ data?: any, options?: { reasoningText?: string | null }, toolId?: string | null }} [input]
 * @returns {any}
 */
export function beginToolBatch(input = {}) {
    const batch = {
        data: input.data ?? null,
        options: input.options ?? {},
        toolId: input.toolId ?? null,
        step: createStepReplyState(input.options?.reasoningText ?? null),
        startedAt: Date.now(),
    };

    toolBatchStack.push(batch);
    return batch;
}

/**
 * @param {any} batchToken
 */
export function endToolBatch(batchToken) {
    if (toolBatchStack.length === 0) return;

    const lastBatch = toolBatchStack[toolBatchStack.length - 1];
    if (lastBatch === batchToken) {
        toolBatchStack.pop();
        return;
    }

    const index = toolBatchStack.lastIndexOf(batchToken);
    if (index >= 0) {
        toolBatchStack.splice(index, 1);
    }
}

/**
 * @param {{ name: string, parameters?: any }} input
 * @returns {any}
 */
export function beginToolInvocation(input) {
    const invocation = {
        name: input.name,
        parameters: cloneValue(input.parameters),
        tool: cloneValue(resolveToolMeta(input.name, input.name) ?? null),
        startedAt: Date.now(),
    };

    toolInvocationStack.push(invocation);
    return invocation;
}

/**
 * @param {any} invocationToken
 */
export function endToolInvocation(invocationToken) {
    if (toolInvocationStack.length === 0) return;

    const lastInvocation = toolInvocationStack[toolInvocationStack.length - 1];
    if (lastInvocation === invocationToken) {
        toolInvocationStack.pop();
        return;
    }

    const index = toolInvocationStack.lastIndexOf(invocationToken);
    if (index >= 0) {
        toolInvocationStack.splice(index, 1);
    }
}
