// ==UserScript==
// @name         Chatshare Pro 模型检测工具 v4.1
// @namespace    http://tampermonkey.net/
// @version      4.1.0
// @description  无消息检测 GPT-6 Pro 可用性，并检测 GPT-5.6 Pro 真实模型 / resolved_model_slug
// @author       You
// @match        https://chatshare.xyz/*
// @icon         https://chatshare.xyz/favicon.ico
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/shipshipzzz/chatshare-seat-detector/main/chatshare-seat-detector.user.js
// @updateURL    https://raw.githubusercontent.com/shipshipzzz/chatshare-seat-detector/main/chatshare-seat-detector.user.js
// ==/UserScript==

(() => {
    'use strict';
  
    // -------------------- 常量/配置 --------------------
    const VERSION = '4.1.0';
    const LOG = (...args) => console.log(`🎯 [座位检测 v${VERSION}]`, ...args);
  
    const CONFIG = {
      BASE_URL: 'https://chatshare.xyz',
      PRO_MODEL: 'gpt-5-6-pro',
      PRO_AVAILABILITY_MODEL: 'gpt-6-pro',

      // 只信任 resolved_model_slug；model_slug/default_model_slug 可能仍显示请求模型，
      // 即使后端实际已降级到 gpt-5-5-mini。
      EXPECTED_RESOLVED_MODELS: {
        'gpt-5-6-pro': ['gpt-5-6-pro'],
      },

      // 仅对 5.6 Pro 注入：'' = 不注入; 可选: min | standard | extended | max
      THINKING_EFFORT_BY_MODEL: {
        // Chatshare 的 5.6 Pro UI 当前发送 standard；保持与网页原生请求一致。
        'gpt-5-6-pro': 'standard',
      },
      THINKING_EFFORT_TARGET_MODELS: ['gpt-5-6-pro'],
      THINKING_EFFORT_OVERRIDE: true,

      TIMEZONE: 'Asia/Shanghai',
      TIMEZONE_OFFSET_MIN: -480,
  
      NETWORK_RETRY_COUNT: 2,
      NETWORK_RETRY_BASE_DELAY_MS: 1200,
      CONVERSATION_REPLY_TIMEOUT_MS: 45000,
      ATTEMPT_COOLDOWN_MS: 1500,
    };
  
    const API = {
      CAR_PAGE: '/frontend-api/carpage',
      LOGIN_SESSION: '/auth/loginSession',
      CONVERSATION_PREPARE: '/backend-api/f/conversation/prepare',
      CONVERSATION: '/backend-api/f/conversation',
      CONVERSATION_DELETE: '/backend-api/conversation',
      GET_ME: '/frontend-api/getme',
    };
  
    const SETTINGS_KEY = 'chatshare-seat-detector-v3-settings';
    const SETTINGS_SCHEMA_VERSION = 3;
    const VALID_THINKING_EFFORTS = new Set(['min', 'standard', 'extended', 'max']);
  
    const STATUS_TEXT = { 1: '空闲', 2: '正常', 3: '繁忙' };
    const STATUS_COLOR = { 1: '#4caf50', 2: '#2196f3', 3: '#ff9800' };
  
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  
    const safeJsonParse = (s) => {
      try { return JSON.parse(s); } catch { return null; }
    };
  
    const getErrorMessage = (e) => e?.message || String(e);
  
    function isTransientFetchError(e) {
      const msg = getErrorMessage(e);
      return e instanceof TypeError || /failed to fetch|networkerror|load failed|fetch/i.test(msg);
    }
  
    async function fetchWithRetry(fetcher, label, options = {}) {
      const retries = options.retries ?? CONFIG.NETWORK_RETRY_COUNT;
      const baseDelayMs = options.baseDelayMs ?? CONFIG.NETWORK_RETRY_BASE_DELAY_MS;
  
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await fetcher();
        } catch (e) {
          if (!isTransientFetchError(e)) throw e;
          if (attempt >= retries) throw new Error(`${label} 网络失败: ${getErrorMessage(e)}`);
          await sleep(baseDelayMs * (attempt + 1));
        }
      }
  
      throw new Error(`${label} 网络失败`);
    }
  
    const ACCESS_TOKEN_CACHE = {
      value: null,
      expiresAt: 0,
    };
  
    function extractAccessTokenFromHtml(html) {
      if (typeof html !== 'string' || !html) return null;
      const m = html.match(/"accessToken":"((?:\\.|[^"\\])+)"/);
      if (!m) return null;
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1] || null;
      }
    }
  
    async function getAccessToken(forceRefresh = false) {
      if (!forceRefresh && ACCESS_TOKEN_CACHE.value && ACCESS_TOKEN_CACHE.expiresAt > Date.now()) {
        return ACCESS_TOKEN_CACHE.value;
      }
  
      const res = await fetchWithRetry(() => fetch(`${CONFIG.BASE_URL}/`, {
        method: 'GET',
        headers: { Accept: 'text/html' },
        credentials: 'include',
      }), '获取首页 accessToken');
      if (!res.ok) throw new Error(`获取首页失败: ${res.status}`);
  
      const html = await res.text();
      const token = extractAccessTokenFromHtml(html);
      if (!token) throw new Error('无法从首页提取 accessToken');
  
      ACCESS_TOKEN_CACHE.value = token;
      ACCESS_TOKEN_CACHE.expiresAt = Date.now() + 5 * 60 * 1000;
      return token;
    }
  
    // -------------------- 设置持久化 --------------------
    function loadSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        const saved = raw ? safeJsonParse(raw) : null;
        if (!saved || typeof saved !== 'object') return;
  
        // 只恢复 5.6 Pro 的 thinking_effort 配置。
        if (saved.thinkingEffortByModel && typeof saved.thinkingEffortByModel === 'object') {
          const effort = saved.thinkingEffortByModel[CONFIG.PRO_MODEL];
          if (VALID_THINKING_EFFORTS.has(effort)) {
            CONFIG.THINKING_EFFORT_BY_MODEL[CONFIG.PRO_MODEL] = effort;
          }
        }
      } catch (e) {
        console.warn('[seat-detector v4] loadSettings failed:', e);
      }
    }
  
    function saveSettings() {
      try {
        const payload = {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          thinkingEffortByModel: { ...CONFIG.THINKING_EFFORT_BY_MODEL },
        };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
      } catch (e) {
        console.warn('[seat-detector v4] saveSettings failed:', e);
      }
    }
  
    // -------------------- thinking_effort 注入 --------------------
    function getThinkingEffortForModel(model) {
      if (!model) return null;
      const allow = CONFIG.THINKING_EFFORT_TARGET_MODELS;
      if (Array.isArray(allow) && allow.length > 0 && !allow.includes(model)) return null;
  
      const effort = CONFIG.THINKING_EFFORT_BY_MODEL?.[model];
      if (!VALID_THINKING_EFFORTS.has(effort)) return null;
      return effort;
    }
  
    function installThinkingEffortInjector() {
      if (window.__chatshareThinkingEffortInjectorV4Installed) return;
      window.__chatshareThinkingEffortInjectorV4Installed = true;
  
      if (typeof window.fetch !== 'function') return;
      const originalFetch = window.fetch.bind(window);
  
      window.fetch = async (input, init) => {
        let isConversationRequest = false;
        try {
          const urlStr = typeof input === 'string' ? input : input?.url;
          if (typeof urlStr !== 'string') return originalFetch(input, init);
  
          const u = new URL(urlStr, location.href);
          const path = u.pathname;
          const method = (init?.method || input?.method || 'GET').toUpperCase();
  
          const isTarget = method === 'POST' && path === API.CONVERSATION;
          isConversationRequest = isTarget;
          const bodyStr = init?.body;
  
          if (isTarget && typeof bodyStr === 'string') {
            const bodyObj = safeJsonParse(bodyStr);
            if (bodyObj && typeof bodyObj === 'object') {
              const effort = getThinkingEffortForModel(bodyObj?.model);
              if (effort) {
                const hasEffort = Object.prototype.hasOwnProperty.call(bodyObj, 'thinking_effort');
                if (CONFIG.THINKING_EFFORT_OVERRIDE || !hasEffort) {
                  bodyObj.thinking_effort = effort;
                  init = { ...(init || {}), body: JSON.stringify(bodyObj) };
                }
              }
            }
          }
        } catch {
          // ignore
        }
        const response = await originalFetch(input, init);
        if (isConversationRequest) scheduleReplyModelRefresh(900, true);
        return response;
      };
    }
  
    loadSettings();
    installThinkingEffortInjector();
  
    // -------------------- 文本解析/工具 --------------------
    function generateUUID() {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
      });
    }
  
    const getStatusText = (s) => STATUS_TEXT[s] || '未知';
    const getStatusColor = (s) => STATUS_COLOR[s] || '#999';
  
    function normalizeModelSlug(model) {
      return typeof model === 'string' ? model.trim().toLowerCase() : '';
    }
  
    function getResolvedModelSlugFromMetadata(metadata) {
      if (!metadata || typeof metadata !== 'object') return null;
      // 不使用 model_slug/default_model_slug：实测降级时它们仍会伪装成请求模型。
      for (const key of ['resolved_model_slug', 'resolved_model_id', 'resolved_model', 'actual_model_slug', 'actual_model_id']) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return null;
    }
  
    function classifyResolvedModel(requestedModel, resolvedModel) {
      const requested = normalizeModelSlug(requestedModel);
      const resolved = normalizeModelSlug(resolvedModel);
      const configured = CONFIG.EXPECTED_RESOLVED_MODELS?.[requestedModel];
      const expectedModels = (Array.isArray(configured) && configured.length ? configured : [requestedModel])
        .map(normalizeModelSlug)
        .filter(Boolean);
  
      if (!resolved) {
        return { status: 'unknown', matched: null, requestedModel, resolvedModel: null, expectedModels };
      }
  
      const matched = expectedModels.includes(resolved) || (!expectedModels.length && requested === resolved);
      return {
        status: matched ? 'match' : 'mismatch',
        matched,
        requestedModel,
        resolvedModel,
        expectedModels,
      };
    }
  
    function formatResolvedModelForUI(model) {
      return typeof model === 'string' && model ? model.replace(/^gpt-/, '') : '';
    }
  
    function extractMessageTextContent(content) {
      if (!content || typeof content !== 'object') return '';
      if (content.content_type === 'reasoning_recap' || content.content_type === 'thoughts') return '';
      if (Array.isArray(content.parts)) return content.parts.filter((part) => typeof part === 'string').join('\n').trim();
      if (typeof content.text === 'string') return content.text.trim();
      if (typeof content.content === 'string') return content.content.trim();
      return '';
    }
  
    function extractConversationResult(conversation, { userMessageId = null } = {}) {
      const mapping = conversation?.mapping;
      if (!mapping || typeof mapping !== 'object') {
        return {
          fullText: '',
          resolvedModel: null,
          resolvedModelSource: null,
          requestId: null,
          complete: false,
        };
      }
  
      const allMessages = Object.values(mapping).map((node) => node?.message).filter(Boolean);
      const targetUser = userMessageId
        ? allMessages.find((message) => message?.id === userMessageId)
        : null;
      const requestId = targetUser?.metadata?.request_id || null;
  
      const visited = new Set();
      let nodeId = conversation?.current_node;
      const branchMessages = [];
  
      while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const message = mapping[nodeId]?.message;
        if (message) branchMessages.push(message);
        nodeId = mapping[nodeId]?.parent;
      }
  
      const belongsToTargetRequest = (message) => !requestId || message?.metadata?.request_id === requestId;
      const sameRequestMessages = requestId
        ? allMessages.filter((message) => message?.metadata?.request_id === requestId)
        : branchMessages;
  
      const finalMessage = branchMessages.find((message) => (
        belongsToTargetRequest(message)
        && message?.author?.role === 'assistant'
        && message?.channel === 'final'
        && extractMessageTextContent(message.content)
      )) || sameRequestMessages.find((message) => (
        message?.author?.role === 'assistant'
        && message?.channel === 'final'
        && extractMessageTextContent(message.content)
      )) || null;
  
      const fallbackMessage = branchMessages.find((message) => (
        belongsToTargetRequest(message)
        && message?.author?.role === 'assistant'
        && extractMessageTextContent(message.content)
      )) || null;
      const selectedMessage = finalMessage || fallbackMessage;
      const fullText = selectedMessage ? extractMessageTextContent(selectedMessage.content) : '';
  
      const resolvedCandidates = [
        { message: targetUser, source: 'user_message' },
        { message: finalMessage, source: 'assistant_final' },
        ...sameRequestMessages.map((message) => ({ message, source: 'same_request' })),
        ...branchMessages.map((message) => ({ message, source: 'current_branch' })),
      ];
  
      let resolvedModel = null;
      let resolvedModelSource = null;
      for (const candidate of resolvedCandidates) {
        const value = getResolvedModelSlugFromMetadata(candidate.message?.metadata);
        if (!value) continue;
        resolvedModel = value;
        resolvedModelSource = candidate.source;
        break;
      }
  
      const complete = !!finalMessage && (
        finalMessage.end_turn === true
        || finalMessage.status === 'finished_successfully'
        || finalMessage.status === 'finished'
      );
  
      return { fullText, resolvedModel, resolvedModelSource, requestId, complete };
    }
  
    async function fetchConversationData(conversationId, { forceRefreshToken = false } = {}) {
      const token = await getAccessToken(forceRefreshToken);
      const res = await fetchWithRetry(() => fetch(`${CONFIG.BASE_URL}${API.CONVERSATION_DELETE}/${encodeURIComponent(conversationId)}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'include',
      }), `获取对话详情 ${conversationId}`);
  
      if (res.status === 401 && !forceRefreshToken) {
        return fetchConversationData(conversationId, { forceRefreshToken: true });
      }
      if (!res.ok) throw new Error(`获取对话详情失败: ${res.status}`);
  
      const text = await res.text();
      if (!text) return null;
      const json = safeJsonParse(text);
      return json && typeof json === 'object' ? json : null;
    }
  
    async function waitForConversationReply(conversationId, {
      timeoutMs = CONFIG.CONVERSATION_REPLY_TIMEOUT_MS,
      intervalMs = 1000,
      userMessageId = null,
      abortSignal = null,
    } = {}) {
      const deadline = Date.now() + timeoutMs;
      let lastAsyncStatus = null;
      let lastError = null;
      let lastResult = null;
  
      while (Date.now() <= deadline) {
        if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
        try {
          const conversation = await fetchConversationData(conversationId);
          if (conversation) {
            lastAsyncStatus = conversation.async_status ?? null;
            lastResult = extractConversationResult(conversation, { userMessageId });
            if (lastResult.complete) return { ...lastResult, asyncStatus: lastAsyncStatus };
          }
        } catch (e) {
          lastError = e?.message || String(e);
        }
  
        await sleep(intervalMs);
      }
  
      // 即便最终状态字段缺失，只要已拿到回复或真实模型标识，也返回现有证据。
      if (lastResult && (lastResult.fullText || lastResult.resolvedModel)) {
        return { ...lastResult, asyncStatus: lastAsyncStatus, timedOut: true };
      }
  
      const suffix = lastError
        ? `: ${lastError}`
        : lastAsyncStatus != null
          ? ` (async_status=${lastAsyncStatus})`
          : '';
      throw new Error(`等待对话结果超时${suffix}`);
    }
  
    // -------------------- 每条回复的实际模型 --------------------
    const REPLY_MODEL_STYLE_ID = 'reply-model-styles-v3';
    const REPLY_MODEL_STATE = {
      timer: null,
      force: false,
      queued: false,
      inFlight: null,
      cache: null,
    };
  
    function getConversationIdFromUrl(url = location.href) {
      return url.match(/\/c\/([^/?#]+)/)?.[1] || null;
    }
  
    function getCurrentBranchMessages(conversation) {
      const mapping = conversation?.mapping;
      if (!mapping || typeof mapping !== 'object') return [];
      const messages = [];
      const visited = new Set();
      let nodeId = conversation.current_node;
      while (nodeId && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node = mapping[nodeId];
        if (node?.message) messages.push(node.message);
        nodeId = node?.parent;
      }
      return messages.reverse();
    }
  
    function isReplyMessage(message) {
      const contentType = message?.content?.content_type;
      return message?.author?.role === 'assistant'
        && contentType !== 'thoughts'
        && contentType !== 'reasoning_recap'
        && (!contentType || contentType === 'text' || contentType === 'multimodal_text')
        && (message.channel === 'final' || message.end_turn === true);
    }
  
    function collectReplyModels(conversation) {
      const branch = getCurrentBranchMessages(conversation);
      const resolvedByRequest = new Map();
      for (const message of branch) {
        const requestId = message?.metadata?.request_id;
        const resolvedModel = getResolvedModelSlugFromMetadata(message?.metadata);
        if (requestId && resolvedModel) resolvedByRequest.set(requestId, resolvedModel);
      }
  
      const replies = [];
      let latestUserResolved = null;
      let latestUserRequested = null;
      let latestUserRequestId = null;
      for (const message of branch) {
        if (message?.author?.role === 'user') {
          latestUserResolved = getResolvedModelSlugFromMetadata(message.metadata);
          latestUserRequested = message.metadata?.model_slug || message.metadata?.default_model_slug || null;
          latestUserRequestId = message.metadata?.request_id || null;
          continue;
        }
        if (!isReplyMessage(message)) continue;
  
        const requestId = message.metadata?.request_id || null;
        const canUseLatestUser = !requestId || !latestUserRequestId || requestId === latestUserRequestId;
        const requestedModel = message.metadata?.model_slug
          || message.metadata?.default_model_slug
          || (canUseLatestUser ? latestUserRequested : null)
          || null;
        const resolvedModel = getResolvedModelSlugFromMetadata(message.metadata)
          || (requestId ? resolvedByRequest.get(requestId) : null)
          || (canUseLatestUser ? latestUserResolved : null)
          || null;
  
        replies.push({
          messageId: message.id || null,
          requestId,
          requestedModel,
          resolvedModel,
        });
      }
      return replies;
    }
  
    function ensureReplyModelStyles() {
      if (document.getElementById(REPLY_MODEL_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = REPLY_MODEL_STYLE_ID;
      style.textContent = `
        .cs-reply-model{display:inline-flex;align-items:center;min-height:24px;margin-left:6px;padding:2px 8px;border:1px solid currentColor;border-radius:999px;font:500 11px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;user-select:text;opacity:.9}
        .cs-reply-model[data-state="match"]{color:#16803c;background:#16a34a12}.dark .cs-reply-model[data-state="match"]{color:#86efac}
        .cs-reply-model[data-state="mismatch"]{color:#c2410c;background:#f9731614}.dark .cs-reply-model[data-state="mismatch"]{color:#fdba74}
        .cs-reply-model[data-state="known"],.cs-reply-model[data-state="unknown"]{color:#64748b;background:#64748b12}.dark .cs-reply-model[data-state="known"],.dark .cs-reply-model[data-state="unknown"]{color:#cbd5e1}
        .cs-reply-model[data-state="error"]{color:#b91c1c;background:#ef444414}.dark .cs-reply-model[data-state="error"]{color:#fca5a5}
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  
    function getReplyBadgeHost(section) {
      const actionGroup = section.querySelector('[data-testid="copy-turn-action-button"]')?.closest('[role="group"]')
        || section.querySelector('[role="group"][aria-label="回复操作"]');
      return actionGroup?.parentElement || actionGroup || section;
    }
  
    function renderReplyModels(replies, fetchError = null) {
      ensureReplyModelStyles();
      const byMessageId = new Map(replies.filter((reply) => reply.messageId)
        .map((reply) => [reply.messageId, reply]));
      const sections = [...document.querySelectorAll('section[data-turn="assistant"][data-testid^="conversation-turn-"]')];
  
      sections.forEach((section, index) => {
        const message = section.querySelector('[data-message-author-role="assistant"]');
        const messageId = message?.getAttribute('data-message-id');
        const reply = (messageId && byMessageId.get(messageId))
          || (replies.length === sections.length ? replies[index] : null)
          || null;
        const requestedModel = reply?.requestedModel || message?.getAttribute('data-message-model-slug') || null;
        const resolvedModel = reply?.resolvedModel || null;
        const state = fetchError
          ? 'error'
          : !resolvedModel
            ? 'unknown'
            : requestedModel
              ? classifyResolvedModel(requestedModel, resolvedModel).status
              : 'known';
        const text = fetchError
          ? '实际模型 · 读取失败'
          : `实际模型 · ${resolvedModel || '未返回'}`;
        const title = fetchError
          ? fetchError
          : `请求模型：${requestedModel || '未知'}\n实际模型：${resolvedModel || '未返回'}`;
  
        const host = getReplyBadgeHost(section);
        const badges = [...section.querySelectorAll('.cs-reply-model')];
        let badge = badges.find((node) => node.parentElement === host) || badges[0] || null;
        badges.forEach((node) => { if (node !== badge) node.remove(); });
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'cs-reply-model';
        }
        if (badge.parentElement !== host) host.appendChild(badge);
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.dataset.state !== state) badge.dataset.state = state;
        if (badge.title !== title) badge.title = title;
      });
    }
  
    async function refreshReplyModels(force = false) {
      const conversationId = getConversationIdFromUrl();
      if (!conversationId) return;
      if (REPLY_MODEL_STATE.inFlight) {
        REPLY_MODEL_STATE.queued ||= force;
        return REPLY_MODEL_STATE.inFlight;
      }
  
      const cached = REPLY_MODEL_STATE.cache;
      if (!force && cached?.conversationId === conversationId && Date.now() - cached.at < 1500) {
        renderReplyModels(cached.replies);
        return;
      }
  
      REPLY_MODEL_STATE.inFlight = (async () => {
        try {
          const conversation = await fetchConversationData(conversationId);
          if (getConversationIdFromUrl() !== conversationId) return;
          const replies = collectReplyModels(conversation);
          REPLY_MODEL_STATE.cache = { conversationId, replies, at: Date.now() };
          renderReplyModels(replies);
        } catch (error) {
          if (getConversationIdFromUrl() === conversationId) {
            renderReplyModels([], getErrorMessage(error));
          }
        } finally {
          REPLY_MODEL_STATE.inFlight = null;
          if (REPLY_MODEL_STATE.queued) {
            REPLY_MODEL_STATE.queued = false;
            scheduleReplyModelRefresh(80, true);
          }
        }
      })();
      return REPLY_MODEL_STATE.inFlight;
    }
  
    function scheduleReplyModelRefresh(delay = 700, force = false) {
      REPLY_MODEL_STATE.force ||= force;
      if (REPLY_MODEL_STATE.timer) return;
      REPLY_MODEL_STATE.timer = setTimeout(() => {
        REPLY_MODEL_STATE.timer = null;
        const shouldForce = REPLY_MODEL_STATE.force;
        REPLY_MODEL_STATE.force = false;
        refreshReplyModels(shouldForce);
      }, delay);
    }
  
    function mutationAffectsReplies(mutation) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target.parentElement;
      if (target?.closest?.('.cs-reply-model,#seat-detector-panel,#usage-query-panel')) return false;
      if (target?.closest?.('section[data-turn="assistant"]')) return true;
      return [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE
        && !node.matches('.cs-reply-model,#seat-detector-panel,#usage-query-panel')
        && (node.matches('section[data-turn="assistant"]') || node.querySelector('section[data-turn="assistant"]')));
    }
  
    // -------------------- 座位高亮/标识 --------------------
    const HIGHLIGHT_STYLE_ID = 'seat-highlight-styles-v3';
    const HIGHLIGHT_CSS = `
      /* isIQ 边框 */
      .seat-iq-good{position:relative;border:3px solid #4caf50!important;box-shadow:0 0 15px rgba(76,175,80,.5),inset 0 0 10px rgba(76,175,80,.1)!important;animation:seat-glow-iq-good 2.5s ease-in-out infinite!important;border-radius:12px!important;z-index:100!important;overflow:visible!important}
      .seat-iq-bad{position:relative;border:3px solid #9e9e9e!important;box-shadow:0 0 10px rgba(158,158,158,.4),inset 0 0 8px rgba(158,158,158,.1)!important;border-radius:12px!important;z-index:100!important;overflow:visible!important;opacity:.7!important}
  
      /* 同账号重复座位 - 标黑跳过 */
      .seat-same-account{position:relative;opacity:.4!important;filter:grayscale(80%)!important;border:2px dashed #666!important;border-radius:12px!important;z-index:99!important;overflow:visible!important}
      .seat-same-account::after{content:'同 ' attr(data-same-as);position:absolute;top:-12px;right:8px;background:rgba(80,80,80,.9);color:#fff;padding:4px 10px;border-radius:10px;font-size:10px;font-weight:700;z-index:1001;pointer-events:none;white-space:nowrap}
  
      /* IQ 小标签（左上）- 使用 data-seat-count 显示 count */
      .seat-iq-good::before{content:'IQ✓ ' attr(data-seat-count);position:absolute;top:-10px;left:8px;background:linear-gradient(135deg,#2196f3,#64b5f6);color:#fff;padding:3px 8px;border-radius:8px;font-size:10px;font-weight:700;z-index:1001;box-shadow:0 2px 6px rgba(33,150,243,.4);pointer-events:none}
      .seat-iq-bad::before{content:'IQ✗ ' attr(data-seat-count);position:absolute;top:-10px;left:8px;background:linear-gradient(135deg,#9e9e9e,#bdbdbd);color:#fff;padding:3px 8px;border-radius:8px;font-size:10px;font-weight:700;z-index:1001;box-shadow:0 2px 6px rgba(158,158,158,.4);pointer-events:none}

      /* GPT-6 Pro 无消息可用性标签（来自 carpage.model_limits） */
      .seat-pro-availability-label{position:absolute;bottom:-10px;left:8px;padding:3px 8px;border-radius:8px;font-size:10px;font-weight:700;color:#fff;z-index:1002;pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
      .seat-pro-availability-label.pro-available{background:linear-gradient(135deg,#2e7d32,#66bb6a)}
      .seat-pro-availability-label.pro-limited{background:linear-gradient(135deg,#c62828,#ef5350)}

      @keyframes seat-glow-iq-good{0%,100%{box-shadow:0 0 15px rgba(76,175,80,.5),inset 0 0 10px rgba(76,175,80,.1)}50%{box-shadow:0 0 25px rgba(76,175,80,.7),0 0 45px rgba(76,175,80,.3),inset 0 0 15px rgba(76,175,80,.15)}}
  
      /* 统计浮窗 */
      #iq-stats-badge{position:fixed;top:80px;left:20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:12px 16px;border-radius:12px;font-size:13px;font-weight:500;z-index:9998;box-shadow:0 4px 15px rgba(0,0,0,.3);cursor:grab;transition:all .3s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;user-select:none}
      #iq-stats-badge.dragging{cursor:grabbing;transition:none;transform:none}
      #iq-stats-badge:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.4)}
      #iq-stats-badge .stats-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
      #iq-stats-badge .stats-row:last-child{margin-bottom:0}
      #iq-stats-badge .good-count{color:#69f0ae;font-weight:700}
      #iq-stats-badge .bad-count{color:#ffab91;font-weight:700}
    `;
  
    function ensureHighlightStyles() {
      if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = HIGHLIGHT_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
  
    function findSeatCard(seatCode) {
      if (!seatCode) return null;
      const nodes = document.querySelectorAll('div.state-info > p');
      for (const p of nodes) {
        if (p.textContent.trim() === seatCode) return p.closest('div.chatgpt');
      }
      return null;
    }
  
    function highlightSeatByIQ(seatCode, isIQ, count) {
      ensureHighlightStyles();
      const card = findSeatCard(seatCode);
      if (!card) return false;
      card.classList.remove('seat-iq-good', 'seat-iq-bad');
      card.classList.add(isIQ ? 'seat-iq-good' : 'seat-iq-bad');
      if (count !== undefined) {
        card.setAttribute('data-seat-count', count);
      }
      return true;
    }

    function getProModelLimit(seat, model = CONFIG.PRO_AVAILABILITY_MODEL) {
      const limits = seat?.model_limits;
      if (!limits || typeof limits !== 'object') return null;
      const limit = limits[model];
      return limit && typeof limit === 'object' ? limit : null;
    }

    function classifyProAvailability(seat, model = CONFIG.PRO_AVAILABILITY_MODEL) {
      if (!seat?.isPro) return { status: 'not-pro', available: false, model, limit: null };
      const limit = getProModelLimit(seat, model);
      return limit
        ? { status: 'limited', available: false, model, limit }
        : { status: 'available', available: true, model, limit: null };
    }

    function formatDurationCompact(totalSeconds) {
      const seconds = Number(totalSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) return '';
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (days > 0) return `${days}d${hours}h`;
      if (hours > 0) return `${hours}h${minutes}m`;
      return `${Math.max(1, minutes)}m`;
    }

    function formatLimitResetTime(limit) {
      const resetTs = Number(limit?.reset_at_ts);
      if (!Number.isFinite(resetTs) || resetTs <= 0) return limit?.resets_after || '';
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone: CONFIG.TIMEZONE,
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(resetTs * 1000));
      } catch {
        return new Date(resetTs * 1000).toLocaleString();
      }
    }

    function markSeatProAvailability(seatCode, availability) {
      ensureHighlightStyles();
      const card = findSeatCard(seatCode);
      if (!card || !availability || availability.status === 'not-pro') return false;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

      let label = card.querySelector(':scope > .seat-pro-availability-label');
      if (!label) {
        label = document.createElement('div');
        label.className = 'seat-pro-availability-label';
        card.appendChild(label);
      }

      label.className = 'seat-pro-availability-label';
      if (availability.available) {
        label.classList.add('pro-available');
        label.textContent = '6 Pro ✓';
        label.title = 'GPT-6 Pro 当前未检测到模型限额';
      } else {
        const compact = formatDurationCompact(availability.limit?.reset_in);
        const resetAt = formatLimitResetTime(availability.limit);
        label.classList.add('pro-limited');
        label.textContent = `6 Pro 受限${compact ? ` ${compact}` : ''}`;
        label.title = `GPT-6 Pro 当前受限${resetAt ? `；预计恢复 ${resetAt}` : ''}`;
      }
      return true;
    }

    function clearProAvailabilityMarkers() {
      document.querySelectorAll('.seat-pro-availability-label').forEach((el) => el.remove());
    }
  
    function clearAllHighlights() {
      document
        .querySelectorAll('.seat-iq-good,.seat-iq-bad,.seat-same-account')
        .forEach((card) => {
          card.classList.remove('seat-iq-good', 'seat-iq-bad', 'seat-same-account');
          card.removeAttribute('data-same-as');
          card.removeAttribute('data-seat-count');
        });
      clearProAvailabilityMarkers();
      clearJuiceMarkers();
      LOG('已清除所有高亮/标识');
    }
  
    function clearIQHighlights() {
      document.querySelectorAll('.seat-iq-good,.seat-iq-bad,.seat-same-account').forEach((card) => {
        card.classList.remove('seat-iq-good', 'seat-iq-bad', 'seat-same-account');
        card.removeAttribute('data-same-as');
        card.removeAttribute('data-seat-count');
      });
      clearProAvailabilityMarkers();
    }
  
    /**
     * 按 count + isIQ + GPT-6 Pro 可用状态对座位去重。
     * 同一底层账号通常共享这些状态；加入 Pro 限额状态可避免把可用/受限账号误合并。
     * @param {Array} proSeats - PRO 座位列表
     * @returns {Object} { unique: 去重后座位, duplicates: 重复座位 }
     */
    function getUniqueProSeats(proSeats) {
      const groups = new Map();
  
      for (const seat of proSeats) {
        const availability = classifyProAvailability(seat);
        const key = `${seat.count}_${seat.isIQ}_${availability.status}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(seat);
      }
  
      const unique = [];
      const duplicates = [];
  
      for (const [key, seats] of groups) {
        // 每组保留第一个，其余标为重复
        unique.push(seats[0]);
        duplicates.push(...seats.slice(1));
      }
  
      return { unique, duplicates };
    }
  
    /**
     * 标记座位为同账号重复（标黑）
     * @param {string} seatCode - 重复座位的 carID
     * @param {string} sameAs - 该座位和哪个座位是同账号（保留的座位 carID）
     */
    function highlightSeatAsDuplicate(seatCode, sameAs) {
      ensureHighlightStyles();
      const card = findSeatCard(seatCode);
      if (!card) return false;
      card.classList.add('seat-same-account');
      card.setAttribute('data-same-as', sameAs);
      return true;
    }
  
    // -------------------- isIQ 自动检测 --------------------
  
    function getOrCreateIQBadge() {
      ensureHighlightStyles();
      let badge = document.getElementById('iq-stats-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'iq-stats-badge';
        document.body?.appendChild(badge);
        badge.addEventListener('click', () => {
          const panel = document.getElementById('seat-detector-panel');
          if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        });
      }
      if (!badge.dataset.dragEnabled) {
        makeDraggable(badge, badge);
        badge.dataset.dragEnabled = '1';
      }
      return badge;
    }
  
    function showIQStatsBadge(goodCount, badCount, proAvailableCount, proLimitedCount, dupCount = 0, uniqueCount = 0) {
      const badge = getOrCreateIQBadge();
      badge.style.background = 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)';
      badge.innerHTML = `
        <div class="stats-row"><span>🎯 PRO 座位快速检测</span></div>
        <div class="stats-row">
          <span>IQ正常: <span class="good-count">${goodCount}</span></span>
          <span>|</span>
          <span>IQ降智: <span class="bad-count">${badCount}</span></span>
        </div>
        <div class="stats-row">
          <span>6 Pro可用: <span class="good-count">${proAvailableCount}</span></span>
          <span>|</span>
          <span>6 Pro受限: <span class="bad-count">${proLimitedCount}</span></span>
          ${dupCount > 0 ? `<span>|</span><span>同账号: <span style="color:#aaa;">${dupCount}</span></span>` : ''}
        </div>
        ${uniqueCount > 0 ? `<div class="stats-row" style="font-size:11px;opacity:.8;">唯一账号: ${uniqueCount} 个</div>` : ''}
        <div class="stats-row" style="font-size:11px;opacity:.8;">6 Pro 状态来自 model_limits，不发送测试消息</div>
      `;
    }
  
    async function autoDetectAndHighlightIQ() {
      LOG('开始自动检测 isIQ + GPT-6 Pro 可用性...');
      try {
        const json = await apiJson(API.CAR_PAGE, { method: 'POST', body: { page: 1, size: 999 } });
        const seats = json?.data?.list;
        if (!Array.isArray(seats)) throw new Error('座位列表数据异常');
  
        const proSeats = seats.filter((s) => s?.isPro === true);
        await sleep(500); // 等待 DOM 座位卡片渲染
  
        const { unique, duplicates } = getUniqueProSeats(proSeats);
        LOG(`PRO座位: ${proSeats.length}, 唯一账号: ${unique.length}, 重复座位: ${duplicates.length}`);
  
        let good = 0;
        let bad = 0;
        let proAvailable = 0;
        let proLimited = 0;
        const limitedSeats = [];

        for (const seat of proSeats) {
          if (!seat?.carID) continue;

          if (highlightSeatByIQ(seat.carID, !!seat.isIQ, seat.count)) {
            seat.isIQ ? good++ : bad++;
          }

          const availability = classifyProAvailability(seat);
          if (markSeatProAvailability(seat.carID, availability)) {
            if (availability.available) {
              proAvailable++;
            } else {
              proLimited++;
              limitedSeats.push({
                carID: seat.carID,
                resetIn: availability.limit?.reset_in ?? null,
                resetAt: formatLimitResetTime(availability.limit) || availability.limit?.resets_after || null,
              });
            }
          }
        }
  
        // 再标记重复座位（不移除 IQ / 6 Pro 状态，叠加显示）
        for (const dupSeat of duplicates) {
          if (!dupSeat?.carID) continue;
          const dupAvailability = classifyProAvailability(dupSeat);
          const mainSeat = unique.find((u) => (
            u.count === dupSeat.count
            && u.isIQ === dupSeat.isIQ
            && classifyProAvailability(u).status === dupAvailability.status
          ));
          if (mainSeat?.carID) highlightSeatAsDuplicate(dupSeat.carID, mainSeat.carID);
        }
  
        LOG(`快速检测完成: IQ正常=${good}, IQ降智=${bad}, 6 Pro可用=${proAvailable}, 6 Pro受限=${proLimited}, 同账号=${duplicates.length}`);
        if (limitedSeats.length) LOG('GPT-6 Pro 受限座位:', limitedSeats);
        showIQStatsBadge(good, bad, proAvailable, proLimited, duplicates.length, unique.length);

        return {
          iqGoodCount: good,
          iqBadCount: bad,
          proAvailableCount: proAvailable,
          proLimitedCount: proLimited,
          limitedSeats,
          dupCount: duplicates.length,
          uniqueCount: unique.length,
          total: proSeats.length,
        };
      } catch (e) {
        console.error('自动检测 isIQ / GPT-6 Pro 可用性失败:', e);
        return null;
      }
    }
  
    // -------------------- API 封装 --------------------
    async function apiFetch(path, { method = 'GET', headers = {}, body } = {}) {
      const url = `${CONFIG.BASE_URL}${path}`;
      const init = {
        method,
        headers: { Accept: 'application/json', ...headers },
        credentials: 'include',
      };
      if (body !== undefined) {
        init.method = method || 'POST';
        init.headers = { 'Content-Type': 'application/json', ...init.headers };
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
  
      const res = await fetchWithRetry(() => fetch(url, init), `${method} ${path}`);
      if (!res.ok) throw new Error(`${method} ${path} 失败: ${res.status}`);
      return res;
    }
  
    async function apiJson(path, opts) {
      const res = await apiFetch(path, opts);
      return res.json();
    }
  
    async function getCarList() {
      const json = await apiJson(API.CAR_PAGE, { method: 'POST', body: { page: 1, size: 999 } });
      if (json?.code !== 1) throw new Error(`获取座位列表失败: ${json?.msg || 'unknown'}`);
      return json?.data?.list || [];
    }
  
    const filterProSeats = (seats) => (Array.isArray(seats) ? seats.filter((s) => s?.isPro === true) : []);
  
    async function getUserInfo() {
      try {
        const json = await apiJson(API.GET_ME, { method: 'GET' });
        if (json?.code !== 1) throw new Error(json?.msg || 'API Error');
        return json?.data || null;
      } catch (e) {
        console.error('获取用户信息失败:', e);
        return null;
      }
    }
  
    async function enterSeat(carId) {
      const json = await apiJson(`${API.LOGIN_SESSION}?carid=${encodeURIComponent(carId)}&carType=chatgpt`, { method: 'GET' });
      if (json?.code !== 1) throw new Error(`进入座位失败: ${json?.msg || 'unknown'}`);
      return true;
    }
  
    async function prepareConversation(modelOverride) {
      const payload = {
        action: 'next',
        fork_from_shared_post: false,
        parent_message_id: 'client-created-root',
        model: modelOverride || CONFIG.PRO_MODEL,
        timezone_offset_min: CONFIG.TIMEZONE_OFFSET_MIN,
        timezone: CONFIG.TIMEZONE,
        conversation_mode: { kind: 'primary_assistant' },
        system_hints: [],
        supports_buffering: true,
        supported_encodings: ['v1'],
      };
  
      const res = await fetchWithRetry(() => fetch(`${CONFIG.BASE_URL}${API.CONVERSATION_PREPARE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'oai-language': 'zh-CN' },
        credentials: 'include',
        body: JSON.stringify(payload),
      }), `准备对话 ${payload.model}`);
  
      if (!res.ok) throw new Error(`准备对话失败: ${res.status}`);
      const json = await res.json();
      return json?.conduit_token;
    }
  
    async function deleteConversation(conversationId) {
      try {
        const res = await fetch(`${CONFIG.BASE_URL}${API.CONVERSATION_DELETE}/${conversationId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ is_visible: false }),
        });
        return res.ok;
      } catch (e) {
        console.error('删除对话失败:', e);
        return false;
      }
    }
  
    // -------------------- Juice Number 检测（5.6 Pro 辅助模式） --------------------
    // 向 gpt-5-6-pro 询问 juice number；resolved_model_slug 仍是首要判据，数字只作辅助展示。
    // 960 = best model；768 = normal model；其它回复 => null（不代表任何含义）。
    const JUICE_CONFIG = {
      MODEL: CONFIG.PRO_MODEL,
      PROMPT: 'what is your juice number, just tell me the number.',
      BEST_NUMBER: 960,
      NORMAL_NUMBER: 768,
    };
  
    // 从回复文本中提取 juice number；优先匹配 960 / 768，否则返回第一个出现的整数（仅供展示/判断）
    // 模型回复通常形如 "960" 或 "0\nModel: GPT-5.3-mini"，juice number 出现在最前。
    function extractJuiceNumber(text) {
      if (!text || typeof text !== 'string') return null;
      const matches = text.match(/\d+/g);
      if (!matches) return null;
      const nums = matches.map((m) => Number.parseInt(m, 10)).filter(Number.isFinite);
      if (nums.includes(JUICE_CONFIG.BEST_NUMBER)) return JUICE_CONFIG.BEST_NUMBER;
      if (nums.includes(JUICE_CONFIG.NORMAL_NUMBER)) return JUICE_CONFIG.NORMAL_NUMBER;
      return nums.length ? nums[0] : null;
    }
  
    // 分类：960 => 'best'，768 => 'normal'，其它 => null（无意义）
    function classifyJuiceNumber(number) {
      if (number === JUICE_CONFIG.BEST_NUMBER) return 'best';
      if (number === JUICE_CONFIG.NORMAL_NUMBER) return 'normal';
      return null;
    }
  
    // 进入座位后调用：询问 juice number，并同时返回服务端真实模型标识。
    // 注意：5.6 Pro 使用 delta_encoding v1 / stream_handoff，不能像普通拼接那样取 v，
    // 否则会把 message 对象里的 status 等字段混进文本。这里用专用解析 + 可中断 fetch。
    async function checkJuiceNumber(abortSignal) {
      let conversationId = null;
      try {
        const token = await prepareConversation(JUICE_CONFIG.MODEL);
        if (!token) return { number: null, classification: null, raw: '', error: '无法获取 conduit_token' };
  
        const messageId = generateUUID();
        const payload = {
          action: 'next',
          messages: [{
            id: messageId,
            author: { role: 'user' },
            create_time: Date.now() / 1000,
            content: { content_type: 'text', parts: [JUICE_CONFIG.PROMPT] },
            metadata: {},
          }],
          parent_message_id: 'client-created-root',
          model: JUICE_CONFIG.MODEL,
          timezone_offset_min: CONFIG.TIMEZONE_OFFSET_MIN,
          timezone: CONFIG.TIMEZONE,
          conversation_mode: { kind: 'primary_assistant' },
          enable_message_followups: true,
          system_hints: [],
          supports_buffering: true,
          supported_encodings: ['v1'],
        };
  
        const res = await fetch(`${CONFIG.BASE_URL}${API.CONVERSATION}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'oai-language': 'zh-CN' },
          credentials: 'include',
          body: JSON.stringify(payload),
          signal: abortSignal,
        });
        if (!res.ok) return { number: null, classification: null, raw: '', error: `发送消息失败: ${res.status}` };
  
        const parsed = await parseJuiceStream(res, abortSignal, messageId);
        conversationId = parsed.conversationId;
        let fullText = parsed.fullText || '';
        let resolvedModel = parsed.resolvedModel || null;
  
        if (conversationId && !parsed.error) {
          const waited = await waitForConversationReply(conversationId, {
            userMessageId: messageId,
            abortSignal,
          });
          if (waited.fullText) fullText = waited.fullText;
          if (waited.resolvedModel) resolvedModel = waited.resolvedModel;
        }
  
        const modelCheck = classifyResolvedModel(JUICE_CONFIG.MODEL, resolvedModel);
  
        if (parsed.error) {
          return { number: null, classification: null, raw: fullText, resolvedModel, modelCheck, error: parsed.error };
        }
  
        const number = extractJuiceNumber(fullText);
        const classification = classifyJuiceNumber(number);
        return { number, classification, raw: fullText, resolvedModel, modelCheck, error: null };
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        return { number: null, classification: null, raw: '', error: aborted ? '已中止' : (e?.message || String(e)) };
      } finally {
        if (conversationId) { try { await deleteConversation(conversationId); } catch { /* ignore */ } }
      }
    }
  
    // 解析 delta_encoding v1 流：只累加 assistant final 频道的 content.parts[0] 文本
    async function parseJuiceStream(res, abortSignal, userMessageId = null) {
      const reader = res.body?.getReader?.();
      if (!reader) return { fullText: '', conversationId: null, resolvedModel: null, error: '响应流不可读' };
  
      const decoder = new TextDecoder();
      let buffer = '';
      let conversationId = null;
      let resolvedModel = null;
      let assistantText = '';
      let error = null;
  
      const handleData = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.conversation_id) conversationId = obj.conversation_id;
        if (typeof obj.error === 'string' && obj.error) error = obj.error;
  
        // 完整对象（o:"add" 或首帧 v.message）
        const msg = obj.v?.message || obj.input_message || (obj.o === 'add' ? obj.v?.message : null);
        const messageResolvedModel = getResolvedModelSlugFromMetadata(msg?.metadata);
        if (messageResolvedModel && (msg?.id === userMessageId || !resolvedModel)) {
          resolvedModel = messageResolvedModel;
        }
        if (msg && msg.author?.role === 'assistant' && msg.channel === 'final' && msg.content?.content_type === 'text') {
          const part = Array.isArray(msg.content.parts) ? msg.content.parts[0] : '';
          if (typeof part === 'string') assistantText = part;
          const rm = getResolvedModelSlugFromMetadata(msg.metadata);
          if (rm) resolvedModel = rm;
        }
  
        // 记录 resolved_model_slug（可能出现在任意 assistant 消息的 metadata 里）
        const anyMsg = obj.v?.message;
        const anyResolvedModel = getResolvedModelSlugFromMetadata(anyMsg?.metadata);
        if (anyResolvedModel && !resolvedModel) resolvedModel = anyResolvedModel;
  
        // 增量 append：直接对 parts/0 追加
        if (obj.p === '/message/content/parts/0' && obj.o === 'append' && typeof obj.v === 'string') {
          assistantText += obj.v;
        }
  
        // patch 批量操作
        if (obj.o === 'patch' && Array.isArray(obj.v)) {
          for (const op of obj.v) {
            if (op?.p === '/message/content/parts/0' && op.o === 'append' && typeof op.v === 'string') {
              assistantText += op.v;
            }
            if (op?.p === '/message/metadata' && op.o === 'append') {
              const patchedResolvedModel = getResolvedModelSlugFromMetadata(op.v);
              if (patchedResolvedModel && !resolvedModel) resolvedModel = patchedResolvedModel;
            }
          }
        }
      };
  
      try {
        while (true) {
          if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
  
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const rawLine = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) continue;
            const dataStr = line.replace(/^data:\s*/, '').trim();
            if (dataStr === '[DONE]') { buffer = ''; break; }
            handleData(safeJsonParse(dataStr));
          }
        }
      } catch (e) {
        if (e?.name === 'AbortError') { try { await reader.cancel(); } catch { /* ignore */ } throw e; }
        if (!assistantText) error = `读取响应流失败: ${getErrorMessage(e)}`;
      }
  
      return { fullText: assistantText.trim(), conversationId, resolvedModel, error };
    }
  
    // Juice 座位标识（独立 style，避免与已有高亮的 ::after/::before 冲突，使用真实子节点）
    const JUICE_STYLE_ID = 'seat-juice-styles-v3';
    const JUICE_CSS = `
      .seat-juice-label{position:absolute;bottom:-10px;right:8px;padding:3px 8px;border-radius:8px;font-size:10px;font-weight:700;color:#fff;z-index:1002;pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
      .seat-juice-label.juice-best{background:linear-gradient(135deg,#7b1fa2,#ab47bc)}
      .seat-juice-label.juice-normal{background:linear-gradient(135deg,#0277bd,#29b6f6)}
      .seat-juice-label.juice-unknown{background:linear-gradient(135deg,#616161,#9e9e9e)}
      .seat-juice-label.juice-native{background:linear-gradient(135deg,#1b5e20,#43a047)}
      .seat-juice-label.juice-downgraded{background:linear-gradient(135deg,#b71c1c,#ef5350)}
    `;
  
    function ensureJuiceStyles() {
      if (document.getElementById(JUICE_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = JUICE_STYLE_ID;
      style.textContent = JUICE_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
  
    function markSeatJuice(seatCode, classification, number, modelCheck = null) {
      ensureJuiceStyles();
      const card = findSeatCard(seatCode);
      if (!card) return false;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      let label = card.querySelector(':scope > .seat-juice-label');
      if (!label) {
        label = document.createElement('div');
        card.appendChild(label);
      }
      label.className = 'seat-juice-label';
      if (modelCheck?.status === 'mismatch') {
        label.classList.add('juice-downgraded');
        label.textContent = `⚠ ${formatResolvedModelForUI(modelCheck.resolvedModel)}`;
      } else if (modelCheck?.status === 'match') {
        label.classList.add('juice-native');
        label.textContent = `✓ 5.6 Pro${number != null ? ` 🧃${number}` : ''}`;
      } else if (classification === 'best') {
        label.classList.add('juice-best');
        label.textContent = `🧃${number} BEST`;
      } else if (classification === 'normal') {
        label.classList.add('juice-normal');
        label.textContent = `🧃${number} NORMAL`;
      } else {
        label.classList.add('juice-unknown');
        label.textContent = `🧃${number != null ? number : '?'} —`;
      }
      return true;
    }
  
    function clearJuiceMarkers() {
      document.querySelectorAll('.seat-juice-label').forEach((el) => el.remove());
    }
  
    // Juice 检测进度/结果浮窗（复用 IQ badge 容器）
    let juiceCheckRunning = false;
    let juiceCheckAborted = false;
    let juiceAbortController = null;
    window.__abortJuiceCheck = () => {
      juiceCheckAborted = true;
      // 立即中断进行中的网络请求（Pro extended 思考耗时较长，否则要等当前请求跑完）
      if (juiceAbortController) { try { juiceAbortController.abort(); } catch { /* ignore */ } }
      LOG('🛑 已请求中止 Juice 检测');
    };
  
    function updateIQStatsBadgeJuiceCheck(current, total, seatCode) {
      const badge = getOrCreateIQBadge();
      badge.style.background = 'linear-gradient(135deg,#7b1fa2 0%,#512da8 100%)';
      badge.innerHTML = `
        <div class="stats-row"><span>🔬 5.6 Pro 真实模型 + Juice 检测中...</span></div>
        <div class="stats-row"><span>进度: <span class="good-count">${current}</span> / ${total}</span></div>
        ${seatCode ? `<div class="stats-row" style="font-size:11px;opacity:.8;">正在测试: ${seatCode}</div>` : ''}
        <div class="stats-row" style="font-size:11px;opacity:.8;margin-top:4px;">
          <span style="cursor:pointer;text-decoration:underline;" onclick="window.__abortJuiceCheck && window.__abortJuiceCheck()">点击中止</span>
        </div>
      `;
    }
  
    function showJuiceStatsBadge(bestCount, normalCount, unknownCount, nativeCount, downgradedCount, unresolvedCount) {
      const badge = getOrCreateIQBadge();
      badge.style.background = 'linear-gradient(135deg,#7b1fa2 0%,#512da8 100%)';
      badge.innerHTML = `
        <div class="stats-row"><span>🔬 5.6 Pro 真实模型检测完成</span></div>
        <div class="stats-row">
          <span>原生5.6: <span class="good-count">${nativeCount}</span></span>
          <span>|</span>
          <span>降级: <span class="bad-count">${downgradedCount}</span></span>
          <span>|</span>
          <span>无标识: ${unresolvedCount}</span>
        </div>
        <div class="stats-row">
          <span>best(960): <span class="good-count">${bestCount}</span></span>
          <span>|</span>
          <span>normal(768): <span style="color:#81d4fa;font-weight:700;">${normalCount}</span></span>
          <span>|</span>
          <span>其它: <span class="bad-count">${unknownCount}</span></span>
        </div>
        <div class="stats-row" style="font-size:11px;opacity:.8;">点击打开检测面板</div>
      `;
    }
  
    // 批量检测：遍历唯一 PRO 座位，逐个进入并询问 juice number
    async function autoDetectJuiceNumbers() {
      if (juiceCheckRunning) { LOG('⚠️ Juice 检测已在运行中'); return null; }
      juiceCheckRunning = true;
      juiceCheckAborted = false;
  
      // 同时输出到 console 与面板日志（面板可能未打开，addLog 会自行忽略）
      const jlog = (msg, level = 'info') => { LOG(msg); try { addLog(msg, level); } catch { /* ignore */ } };
  
      try {
        const allSeats = await getCarList();
        const proSeats = filterProSeats(allSeats);
        if (!proSeats.length) { jlog('❌ 没有 PRO 座位', 'error'); return null; }
  
        await sleep(300);
        const { unique, duplicates } = getUniqueProSeats(proSeats);
        for (const dup of duplicates) {
          if (!dup?.carID) continue;
          const dupAvailability = classifyProAvailability(dup);
          const main = unique.find((u) => (
            u.count === dup.count
            && u.isIQ === dup.isIQ
            && classifyProAvailability(u).status === dupAvailability.status
          ));
          if (main?.carID) highlightSeatAsDuplicate(dup.carID, main.carID);
        }
        jlog(`🧃 Juice 检测: ${unique.length} 个唯一账号待检测 (跳过 ${duplicates.length} 个重复座位)`);
  
        let best = 0;
        let normal = 0;
        let unknown = 0;
        let nativeModel = 0;
        let downgradedModel = 0;
        let unresolvedModel = 0;
        const results = [];
  
        for (let i = 0; i < unique.length; i++) {
          if (juiceCheckAborted) { jlog('🛑 Juice 检测已中止', 'warning'); break; }
          const seatCode = unique[i]?.carID;
          if (!seatCode) continue;
  
          updateIQStatsBadgeJuiceCheck(i + 1, unique.length, seatCode);
  
          juiceAbortController = new AbortController();
          try {
            await enterSeat(seatCode);
            const r = await checkJuiceNumber(juiceAbortController.signal);
  
            if (r.error === '已中止' || juiceCheckAborted) {
              jlog(`🛑 ${seatCode} 检测被中止`, 'warning');
              break;
            }
  
            markSeatJuice(seatCode, r.classification, r.number, r.modelCheck);
            if (r.classification === 'best') best++;
            else if (r.classification === 'normal') normal++;
            else unknown++;
            if (r.modelCheck?.status === 'match') nativeModel++;
            else if (r.modelCheck?.status === 'mismatch') downgradedModel++;
            else unresolvedModel++;
            results.push({ seatCode, ...r });
  
            const preview = r.raw ? r.raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '(空)';
            const cls = r.classification === 'best' ? 'best(960)' : r.classification === 'normal' ? 'normal(768)' : '其它';
            const level = r.modelCheck?.status === 'mismatch'
              ? 'error'
              : r.modelCheck?.status === 'match' || r.classification === 'best'
                ? 'success'
                : r.classification === 'normal'
                  ? 'info'
                  : 'warning';
            const modelVerdict = r.modelCheck?.status === 'match'
              ? '原生5.6 Pro'
              : r.modelCheck?.status === 'mismatch'
                ? '已降级'
                : '无真实模型标识';
            jlog(`🔬 ${seatCode}: ${modelVerdict}${r.resolvedModel ? ` (${r.resolvedModel})` : ''} | juice=${r.number ?? '-'} => ${cls}`, level);
            jlog(`   ↳ 模型回复: 「${preview}」${r.error ? ` | 错误: ${r.error}` : ''}`, r.error ? 'error' : 'info');
          } catch (e) {
            if (juiceCheckAborted) { jlog(`🛑 ${seatCode} 检测被中止`, 'warning'); break; }
            unknown++;
            unresolvedModel++;
            markSeatJuice(seatCode, null, null);
            jlog(`❌ ${seatCode} juice 检测失败: ${e?.message || e}`, 'error');
          } finally {
            juiceAbortController = null;
          }
  
          if (juiceCheckAborted) { jlog('🛑 Juice 检测已中止', 'warning'); break; }
          await sleep(CONFIG.ATTEMPT_COOLDOWN_MS);
        }
  
        showJuiceStatsBadge(best, normal, unknown, nativeModel, downgradedModel, unresolvedModel);
        jlog(`🔬 检测${juiceCheckAborted ? '已中止' : '完成'}: 原生5.6=${nativeModel}, 降级=${downgradedModel}, 无标识=${unresolvedModel}; juice best=${best}, normal=${normal}, 其它=${unknown}`, 'success');
        return {
          best,
          normal,
          unknown,
          nativeModel,
          downgradedModel,
          unresolvedModel,
          results,
          aborted: juiceCheckAborted,
        };
      } catch (e) {
        console.error('Juice 检测失败:', e);
        return null;
      } finally {
        juiceCheckRunning = false;
        juiceAbortController = null;
      }
    }
  
    // -------------------- UI：主面板 --------------------
    function createUI() {
      const panel = document.createElement('div');
      panel.id = 'seat-detector-panel';
      panel.innerHTML = `
        <style>
          #seat-detector-panel{position:fixed;top:80px;right:20px;width:450px;max-height:80vh;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.3);z-index:10000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;overflow:hidden}
          #detector-header{padding:20px;background:rgba(255,255,255,.1);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,.2);display:flex;justify-content:space-between;align-items:center;cursor:move}
          #detector-title{font-size:18px;font-weight:700;color:#fff;margin:0;display:flex;align-items:center;gap:8px}
          #detector-close{background:rgba(255,255,255,.2);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:all .3s}
          #detector-close:hover{background:rgba(255,255,255,.3);transform:rotate(90deg)}
          #detector-body{padding:20px;overflow-y:auto;max-height:calc(80vh - 180px)}
          .account-info,.config-section{background:rgba(255,255,255,.15);backdrop-filter:blur(10px);padding:16px;border-radius:12px;margin-bottom:16px;color:#fff}
          .account-info h3{margin:0 0 12px 0;font-size:14px;font-weight:600;opacity:.9}
          .account-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.1)}
          .account-row:last-child{border-bottom:none}
          .account-label{font-size:13px;opacity:.8}
          .account-value{font-size:14px;font-weight:600}
          .refresh-btn{background:rgba(255,255,255,.2);border:none;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;transition:all .3s;margin-top:8px;width:100%}
          .refresh-btn:hover{background:rgba(255,255,255,.3)}
          .config-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
          .config-row:last-child{margin-bottom:0}
          .config-label{color:#fff;font-size:14px;font-weight:500}
          .config-input{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);color:#fff;padding:6px 12px;border-radius:8px;font-size:14px;width:100px;text-align:center}
          .config-input::placeholder{color:rgba(255,255,255,.5)}
          #detector-logs{background:rgba(0,0,0,.3);backdrop-filter:blur(10px);border-radius:12px;padding:16px;margin-top:16px;max-height:300px;overflow-y:auto;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.6;display:none}
          .log-line{color:#fff;margin-bottom:4px;word-wrap:break-word}
          .log-info{color:#90caf9}.log-success{color:#4caf50}.log-warning{color:#ff9800}.log-error{color:#f44336}
        </style>
  
        <div id="detector-header">
          <h3 id="detector-title">🔬 Pro 模型检测</h3>
          <button id="detector-close">×</button>
        </div>
  
        <div id="detector-body">
          <div class="account-info" id="account-info">
            <h3>📊 账号信息</h3>
            <div id="account-content">
              <div style="text-align:center;color:rgba(255,255,255,.7);padding:20px 0;">加载中...</div>
            </div>
            <button class="refresh-btn" id="refresh-account-btn">🔄 刷新信息</button>
          </div>
  
          <div class="config-section">
            <div class="config-row">
              <span class="config-label">5.6 Pro effort</span>
              <select class="config-input" id="thinking-effort-pro" style="width:150px;">
                <option value="">不注入</option>
                <option value="min">min</option>
                <option value="standard">standard</option>
                <option value="extended">extended</option>
                <option value="max">max</option>
              </select>
            </div>
          </div>
  
          <div style="display:flex;gap:10px;margin-bottom:10px;">
            <button id="detector-refresh-iq-btn" style="flex:1;padding:12px;background:rgba(33,150,243,.8);color:#fff;border:none;border-radius:10px;font-size:14px;cursor:pointer;transition:all .3s;">🔍 刷新 IQ + 6 Pro 检测</button>
            <button id="detector-clear-highlight-btn" style="flex:0 0 auto;padding:12px 16px;background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:10px;font-size:14px;cursor:pointer;transition:all .3s;">🧹 清除</button>
          </div>
  
          <div style="display:flex;gap:10px;margin-top:10px;">
            <button id="detector-juice-btn" style="flex:1;padding:12px;background:linear-gradient(135deg,#7b1fa2,#512da8);color:#fff;border:none;border-radius:10px;font-size:14px;cursor:pointer;transition:all .3s;">🔬 5.6 Pro 真实模型 + Juice 检测</button>
          </div>
  
          <div id="detector-logs"></div>
        </div>
      `;
  
      document.body.appendChild(panel);
      panel.style.display = 'none'; // 默认隐藏
  
      // 事件绑定
      $('#detector-close')?.addEventListener('click', () => (panel.style.display = 'none'));
      $('#refresh-account-btn')?.addEventListener('click', loadAccountInfo);
      $('#detector-clear-highlight-btn')?.addEventListener('click', () => {
        clearAllHighlights();
        addLog('🧹 已清除所有座位高亮和标识', 'info');
      });
      $('#detector-refresh-iq-btn')?.addEventListener('click', async () => {
        addLog('🔍 正在刷新 IQ + GPT-6 Pro 可用性检测...', 'info');
        clearIQHighlights();
        const result = await autoDetectAndHighlightIQ();
        if (result) {
          addLog(`✅ 快速检测完成: IQ正常 ${result.iqGoodCount}, IQ降智 ${result.iqBadCount}, 6 Pro可用 ${result.proAvailableCount}, 6 Pro受限 ${result.proLimitedCount}, 同账号 ${result.dupCount}`, 'success');
          for (const limited of result.limitedSeats || []) {
            addLog(`⏳ ${limited.carID}: GPT-6 Pro 受限${limited.resetAt ? `，恢复 ${limited.resetAt}` : ''}`, 'warning');
          }
        }
      });
  
      $('#detector-juice-btn')?.addEventListener('click', async () => {
        const btn = $('#detector-juice-btn');
        // 运行中再次点击 = 中止
        if (juiceCheckRunning) {
          window.__abortJuiceCheck && window.__abortJuiceCheck();
          if (btn) btn.textContent = '🛑 正在中止...';
          return;
        }
        clearJuiceMarkers();
        addLog('🔬 开始 5.6 Pro 真实模型 + Juice 辅助检测...', 'info');
        if (btn) btn.textContent = '🛑 中止检测';
        try {
          const result = await autoDetectJuiceNumbers();
          if (result) {
            addLog(`🔬 ${result.aborted ? '已中止' : '完成'}: 原生5.6=${result.nativeModel}, 降级=${result.downgradedModel}, 无标识=${result.unresolvedModel}`, 'success');
          }
          else addLog('🧃 检测未返回结果', 'warning');
        } finally {
          if (btn) btn.textContent = '🔬 5.6 Pro 真实模型 + Juice 检测';
        }
      });
  
      // 5.6 Pro thinking_effort
      const tePro = $('#thinking-effort-pro');
      if (tePro) {
        const v = CONFIG.THINKING_EFFORT_BY_MODEL?.[CONFIG.PRO_MODEL];
        tePro.value = VALID_THINKING_EFFORTS.has(v) ? v : '';
        tePro.addEventListener('change', () => {
          CONFIG.THINKING_EFFORT_BY_MODEL[CONFIG.PRO_MODEL] = tePro.value;
          saveSettings();
          addLog(`thinking_effort(pro) = ${tePro.value || '不注入'}`, 'info');
        });
      }
  
      makeDraggable(panel, $('#detector-header'));
      loadAccountInfo();
  
      return panel;
    }
  
    // -------------------- UI：使用量查询面板 --------------------
    function createUsageUI() {
      const panel = document.createElement('div');
      panel.id = 'usage-query-panel';
      panel.innerHTML = `
        <style>
          #usage-query-panel{position:fixed;top:80px;right:80px;width:600px;max-height:80vh;background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.2);z-index:10000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;overflow:hidden;border:1px solid #eee}
          #usage-header{padding:15px 20px;background:#f8f9fa;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;cursor:move}
          #usage-title{margin:0;font-size:16px;font-weight:600;color:#333}
          #usage-close{background:none;border:none;font-size:20px;cursor:pointer;color:#666}
          #usage-body{padding:20px;overflow-y:auto}
          .usage-section{margin-bottom:20px}
          .usage-section h3{margin:0 0 10px 0;font-size:14px;font-weight:600;color:#333;border-left:3px solid #667eea;padding-left:8px}
          #usage-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
          #usage-table th{background:#f1f3f5;padding:8px;text-align:left;color:#495057;font-weight:600;border-bottom:2px solid #dee2e6}
          #usage-table td{padding:8px;border-bottom:1px solid #eee;color:#333}
          #usage-table tr:hover{background:#f8f9fa}
          .usage-bar-bg{width:100px;height:6px;background:#e9ecef;border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:5px}
          .usage-bar-fill{height:100%;border-radius:3px}
          .u-btn{padding:8px 16px;background:#667eea;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;transition:background .2s}
          .u-btn:hover{background:#5a67d8}
          .u-btn:disabled{background:#cbd5e0;cursor:not-allowed}
          .account-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;font-size:13px;background:#f8f9fa;padding:15px;border-radius:8px}
          .ag-item{display:flex;flex-direction:column}
          .ag-label{color:#6c757d;font-size:12px;margin-bottom:2px}
          .ag-value{color:#333;font-weight:500}
          #usage-logs{margin-top:15px;background:#2d3436;color:#dfe6e9;padding:10px;border-radius:6px;font-family:monospace;font-size:11px;height:100px;overflow-y:auto}
        </style>
  
        <div id="usage-header">
          <h3 id="usage-title">📊 账户使用量查询</h3>
          <button id="usage-close">×</button>
        </div>
  
        <div id="usage-body">
          <div class="usage-section">
            <h3>查询账户使用量限制 <span style="font-weight:normal;color:#999;font-size:12px;">(来自 /frontend-api/getme)</span></h3>
            <div style="display:flex;align-items:center;gap:10px;margin:10px 0;">
              <button id="query-usage-btn" class="u-btn">查询使用量</button>
              <span id="usage-status" style="font-size:13px;color:#666;">就绪</span>
            </div>
          </div>
  
          <div class="usage-section">
            <h3>使用量信息</h3>
            <table id="usage-table">
              <thead>
                <tr><th>服务</th><th>限额</th><th>已用</th><th>剩余</th><th>使用率</th><th>重置周期</th></tr>
              </thead>
              <tbody id="usage-tbody">
                <tr><td colspan="6" style="text-align:center;color:#999;">请点击查询...</td></tr>
              </tbody>
            </table>
          </div>
  
          <div class="usage-section">
            <h3>账户信息</h3>
            <div class="account-grid" id="u-account-info">
              <div class="ag-item"><span class="ag-label">用户名</span><span class="ag-value">-</span></div>
              <div class="ag-item"><span class="ag-label">到期时间</span><span class="ag-value">-</span></div>
              <div class="ag-item"><span class="ag-label">账户类型</span><span class="ag-value">-</span></div>
              <div class="ag-item"><span class="ag-label">计费方式</span><span class="ag-value">-</span></div>
            </div>
          </div>
  
          <div id="usage-logs"></div>
        </div>
      `;
  
      document.body.appendChild(panel);
      panel.style.display = 'none';
  
      $('#usage-close', panel)?.addEventListener('click', () => (panel.style.display = 'none'));
      makeDraggable(panel, $('#usage-header', panel));
      $('#query-usage-btn', panel)?.addEventListener('click', fetchAndDisplayUsage);
  
      return panel;
    }
  
    async function fetchAndDisplayUsage() {
      const btn = $('#query-usage-btn');
      const statusEl = $('#usage-status');
      const logsEl = $('#usage-logs');
      const tbody = $('#usage-tbody');
      const accountDiv = $('#u-account-info');
  
      const uLog = (msg) => {
        const div = document.createElement('div');
        div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logsEl.appendChild(div);
        logsEl.scrollTop = logsEl.scrollHeight;
      };
  
      btn.disabled = true;
      statusEl.textContent = '查询中...';
      statusEl.style.color = 'blue';
      logsEl.innerHTML = '';
      uLog('获取使用量信息...');
  
      try {
        const json = await apiJson(API.GET_ME, { method: 'GET' });
        if (json?.code !== 1) throw new Error(json?.msg || 'API Error');
        const data = json?.data || {};
  
        uLog('查询成功');
        statusEl.textContent = '查询完成';
        statusEl.style.color = 'green';
  
        // 账户信息
        const types = [];
        if (data.isPlus) types.push('Plus');
        if (data.isPro) types.push('Pro');
        if (data.isSuper) types.push('Super');
        if (data.isClaudeMax) types.push('ClaudeMax');
        const billing = data.chatgptBillingType === 'count' ? '按次数' : data.chatgptBillingType;
  
        accountDiv.innerHTML = `
          <div class="ag-item"><span class="ag-label">用户名</span><span class="ag-value">${data.name || data.username || '-'}</span></div>
          <div class="ag-item"><span class="ag-label">到期时间</span><span class="ag-value">${data.expireTime || '-'}</span></div>
          <div class="ag-item"><span class="ag-label">账户类型</span><span class="ag-value">${types.join(' + ') || '-'}</span></div>
          <div class="ag-item"><span class="ag-label">计费方式</span><span class="ag-value">${billing || '-'}</span></div>
        `;
  
        // 使用量服务列表
        const services = [];
        const pushIf = (cond, obj) => cond && services.push(obj);
  
        pushIf((data.limit || 0) > 0, { name: 'ChatGPT', limit: data.limit, used: parseInt(data.userUsed || 0, 10), per: data.per || '24h' });
        pushIf((data.claudeLimit || 0) > 0, { name: 'Claude', limit: data.claudeLimit, used: parseInt(data.claudeUsed || 0, 10), per: data.claudePer || '24h' });
        pushIf((data.grokLimit || 0) > 0, { name: 'Grok', limit: data.grokLimit, used: parseInt(data.grokUsed || 0, 10), per: data.grokPer || '24h' });
        if (parseInt(data.geminiUsed ?? -1, 10) >= 0) services.push({ name: 'Gemini', limit: '无限制', used: parseInt(data.geminiUsed || 0, 10), per: '-' });
        pushIf((data.mjLimit || 0) > 0, { name: 'Midjourney', limit: data.mjLimit, used: parseInt(data.mjUsed || 0, 10), per: data.mjPer || '1h' });
        pushIf((data.soraLimit || 0) > 0, { name: 'Sora', limit: data.soraLimit, used: parseInt(data.soraUsed || 0, 10), per: data.soraPer || '1h' });
  
        // 表格渲染
        tbody.innerHTML = '';
        services.forEach((svc) => {
          const tr = document.createElement('tr');
  
          let remaining = '-';
          let percentStr = '-';
          let percent = 0;
          let barColor = '#28a745';
  
          if (typeof svc.limit === 'number') {
            remaining = svc.limit - svc.used;
            percent = (svc.used / svc.limit) * 100;
            percentStr = percent.toFixed(1) + '%';
            if (percent > 80) barColor = '#dc3545';
            else if (percent > 50) barColor = '#ffc107';
          }
  
          tr.innerHTML = `
            <td>${svc.name}</td>
            <td style="text-align:center">${svc.limit}</td>
            <td style="text-align:center">${svc.used}</td>
            <td style="text-align:center;font-weight:700;">${remaining}</td>
            <td style="text-align:center">
              ${typeof svc.limit === 'number'
                ? `<div title="${percentStr}" style="display:flex;align-items:center;">
                     <div class="usage-bar-bg"><div class="usage-bar-fill" style="width:${Math.min(100, percent)}%;background:${barColor};"></div></div>
                     <span style="font-size:11px">${percentStr}</span>
                   </div>`
                : '-'}
            </td>
            <td style="text-align:center">${svc.per}</td>
          `;
          tbody.appendChild(tr);
  
          uLog(`${svc.name}: ${svc.used}/${svc.limit} (${svc.per})`);
        });
      } catch (e) {
        console.error(e);
        statusEl.textContent = '查询失败';
        statusEl.style.color = 'red';
        uLog('错误: ' + (e?.message || e));
      } finally {
        btn.disabled = false;
      }
    }
  
    // -------------------- UI：浮动按钮 --------------------
    function createTriggerButtons() {
      const container = document.createElement('div');
      container.style.cssText = `position:fixed;top:20px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:9999;`;
      document.body.appendChild(container);
  
      const mkBtn = ({ id, html, title, bg }) => {
        const b = document.createElement('button');
        b.id = id;
        b.innerHTML = html;
        b.title = title;
        b.style.cssText = `
          width:50px;height:50px;border-radius:50%;
          background:${bg};border:none;color:#fff;font-size:24px;
          cursor:pointer;box-shadow:0 4px 15px rgba(0,0,0,.3);
          transition:all .3s;
        `;
        b.addEventListener('mouseenter', () => (b.style.transform = 'scale(1.1)'));
        b.addEventListener('mouseleave', () => (b.style.transform = 'scale(1)'));
        container.appendChild(b);
        return b;
      };
  
      mkBtn({
        id: 'detector-trigger-btn',
        html: '🎯',
        title: 'Pro 模型检测：GPT-6 Pro 可用性 + 5.6 真实模型',
        bg: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)',
      }).addEventListener('click', () => togglePanel('seat-detector-panel', 'usage-query-panel'));
  
      mkBtn({
        id: 'usage-trigger-btn',
        html: '📊',
        title: '查询账户使用量',
        bg: 'linear-gradient(135deg,#4caf50 0%,#009688 100%)',
      }).addEventListener('click', () => togglePanel('usage-query-panel', 'seat-detector-panel'));
    }
  
    function togglePanel(showId, hideId) {
      const show = document.getElementById(showId);
      const hide = document.getElementById(hideId);
      if (hide) hide.style.display = 'none';
      if (!show) return;
      show.style.display = show.style.display === 'none' ? 'flex' : 'none';
    }
  
    // -------------------- 主面板逻辑 --------------------
    const $ = (sel, root = document) => root.querySelector(sel);
  
    function addLog(message, level = 'info') {
      const logs = $('#detector-logs');
      if (!logs) return;
      logs.style.display = 'block';
  
      const line = document.createElement('div');
      line.className = `log-line log-${level}`;
      line.textContent = message;
      logs.appendChild(line);
      logs.scrollTop = logs.scrollHeight;
    }
  
    async function loadAccountInfo() {
      const content = $('#account-content');
      if (!content) return;
      content.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.7);padding:20px 0;">加载中...</div>';
  
      try {
        const userInfo = await getUserInfo();
        if (!userInfo) {
          content.innerHTML = '<div style="text-align:center;color:#f44336;padding:20px 0;">获取信息失败</div>';
          return;
        }
  
        const allSeats = await getCarList();
        const proSeats = filterProSeats(allSeats);
        const available = proSeats.filter((s) => s.status === 1);
        const pro6Available = proSeats.filter((s) => classifyProAvailability(s).available);
        const pro6Limited = proSeats.filter((s) => classifyProAvailability(s).status === 'limited');
  
        const statusCount = {
          1: proSeats.filter((s) => s.status === 1).length,
          2: proSeats.filter((s) => s.status === 2).length,
          3: proSeats.filter((s) => s.status === 3).length,
        };
  
        content.innerHTML = `
          <div class="account-row"><span class="account-label">用户名</span><span class="account-value">${userInfo.username || '未知'}</span></div>
          <div class="account-row"><span class="account-label">总 PRO 座位</span><span class="account-value">${proSeats.length} 个</span></div>
          <div class="account-row"><span class="account-label">空闲座位</span><span class="account-value" style="color:#4caf50;">${available.length} 个</span></div>
          <div class="account-row"><span class="account-label">GPT-6 Pro 可用</span><span class="account-value" style="color:#69f0ae;">${pro6Available.length} 个</span></div>
          <div class="account-row"><span class="account-label">GPT-6 Pro 受限</span><span class="account-value" style="color:#ffab91;">${pro6Limited.length} 个</span></div>
          <div class="account-row">
            <span class="account-label">状态分布</span>
            <span class="account-value">
              <span style="color:#4caf50;">${statusCount[1]}</span> /
              <span style="color:#2196f3;">${statusCount[2]}</span> /
              <span style="color:#ff9800;">${statusCount[3]}</span>
            </span>
          </div>
        `;
      } catch (e) {
        console.error('加载账号信息失败:', e);
        content.innerHTML = '<div style="text-align:center;color:#f44336;padding:20px 0;">加载失败</div>';
      }
    }
  
    // -------------------- 拖拽 --------------------
    function makeDraggable(element, handle) {
      if (!element || !handle) return;
  
      const dragThreshold = 4;
      const interactiveSelector = 'button,input,textarea,select,option,a,label';
      let suppressClick = false;
  
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
  
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest(interactiveSelector)) return;
  
        const rect = element.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = rect.left;
        const startTop = rect.top;
        let dragging = false;
  
        element.style.left = `${startLeft}px`;
        element.style.top = `${startTop}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
  
        const onMouseMove = (ev) => {
          const deltaX = ev.clientX - startX;
          const deltaY = ev.clientY - startY;
  
          if (!dragging && Math.hypot(deltaX, deltaY) < dragThreshold) return;
  
          if (!dragging) {
            dragging = true;
            suppressClick = true;
            element.classList.add('dragging');
          }
  
          ev.preventDefault();
          const maxLeft = Math.max(0, window.innerWidth - element.offsetWidth);
          const maxTop = Math.max(0, window.innerHeight - element.offsetHeight);
          const nextLeft = Math.min(Math.max(0, startLeft + deltaX), maxLeft);
          const nextTop = Math.min(Math.max(0, startTop + deltaY), maxTop);
  
          element.style.left = `${nextLeft}px`;
          element.style.top = `${nextTop}px`;
        };
  
        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          if (dragging) {
            requestAnimationFrame(() => element.classList.remove('dragging'));
          }
        };
  
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp, { once: true });
      });
  
      handle.addEventListener('click', (e) => {
        if (!suppressClick) return;
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }
  
    // -------------------- 初始化/路由监听 --------------------
    async function waitForBody() {
      if (document.body) return;
      await new Promise((resolve) => {
        const ob = new MutationObserver(() => {
          if (!document.body) return;
          ob.disconnect();
          resolve();
        });
        ob.observe(document.documentElement, { childList: true, subtree: true });
      });
    }
  
    let initRunning = false;
    async function init() {
      if (initRunning) return;
      initRunning = true;
      try {
        await waitForBody();
        ensureReplyModelStyles();
        scheduleReplyModelRefresh(500, true);
        if (document.getElementById('detector-trigger-btn')) return;
        await sleep(800);
        if (document.getElementById('detector-trigger-btn')) return;
  
        createUI();
        createUsageUI();
        createTriggerButtons();
        LOG('脚本已加载', { version: VERSION });
  
        // 在车队列表页面：自动检测 isIQ + GPT-6 Pro model_limits；不发送测试消息
        if (location.href.includes('/carlist') || location.href.includes('/#/')) {
          await sleep(1500);
          await autoDetectAndHighlightIQ();
        }
      } catch (e) {
        console.error('初始化失败:', e);
      } finally {
        initRunning = false;
      }
    }
  
    // 监听 URL 变化（SPA）
    let lastUrl = location.href;
    new MutationObserver((mutations) => {
      const url = location.href;
      const urlChanged = url !== lastUrl;
      if (urlChanged) {
        lastUrl = url;
        REPLY_MODEL_STATE.cache = null;
  
        if (url.includes('/carlist')) {
          setTimeout(async () => {
            await autoDetectAndHighlightIQ();
          }, 2000);
        }
      }
  
      if (urlChanged || mutations.some(mutationAffectsReplies)) scheduleReplyModelRefresh(700, true);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    addEventListener('popstate', () => scheduleReplyModelRefresh(300, true));
  
    LOG('准备启动...');
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  
    // 兜底：防止过早执行导致按钮未生成
    setTimeout(() => {
      if (!document.getElementById('detector-trigger-btn')) init();
    }, 2000);
  })();
  
