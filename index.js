const STORAGE_KEY_ENABLED = "timeline-enabled";
const STYLE_ID = "codexpp-timeline-enhancement-style";
const PAGE_ID = "timeline-enhancement";
const PAGE_TITLE = "Timeline Enhancement";
const TIMELINE_CLASS = "codexpp-conversation-timeline";
const TIMELINE_TRACK_CLASS = "codexpp-conversation-timeline-track";
const TIMELINE_MARKER_CLASS = "codexpp-conversation-timeline-marker";
const TIMELINE_TOOLTIP_CLASS = "codexpp-conversation-timeline-tooltip";
const TIMELINE_TARGET_CLASS = "codexpp-conversation-timeline-target";
const TIMELINE_VERSION = "1";
const TIMELINE_QUESTION_LIMIT = 40;
const TIMELINE_MIN_TOP_PERCENT = 2;
const TIMELINE_MAX_TOP_PERCENT = 98;
const TIMELINE_MAX_MARKER_GAP_PERCENT = 3.5;
const REFRESH_INTERVAL_MS = 1500;

const TEXT = {
  en: {
    pageTitle: "Timeline Enhancement",
    pageDescription: "Show a question timeline on the right side of the conversation.",
    sectionTitle: "Timeline",
    enableTitle: "Enable Conversation Timeline",
    enableDescription: "Show a question timeline on the right side of the conversation. Hover for a summary and click to jump to that message.",
    notesTitle: "Notes",
    notesDescription: "This version is extracted from the Codex++ Timeline logic and keeps only the timeline itself, without delete, export, project move, or other enhancements.",
    enabled: "Enabled",
    disabled: "Disabled",
    jumpTo: (text) => `Jump to: ${text}`,
  },
  zh: {
    pageTitle: "时间轴增强",
    pageDescription: "在对话右侧显示问题时间轴。",
    sectionTitle: "时间轴",
    enableTitle: "启用对话时间轴",
    enableDescription: "在对话右侧显示问题时间轴。悬停查看摘要，点击跳转到对应消息。",
    notesTitle: "说明",
    notesDescription: "此版本提取自 Codex++ Timeline 逻辑，仅保留时间轴本身，不包含删除、导出、移动项目或其他增强功能。",
    enabled: "已启用",
    disabled: "已停用",
    jumpTo: (text) => `跳转到：${text}`,
  },
};

function currentLanguage() {
  const candidates = [
    publicLanguageFromGlobals(),
    globalThis.__codexppLanguage,
    globalThis.__codexppLocale,
    documentLanguageFromHtml(),
    uiLanguageFromDocument(),
    browserLanguageFromNavigator(),
  ];
  for (const candidate of candidates) {
    const language = normalizeLanguageCandidate(candidate);
    if (language) return language;
  }
  return "zh";
}

function normalizeLanguageCandidate(candidate) {
  const value = String(candidate || "").trim().toLowerCase();
  if (!value || value === "auto" || value === "system" || value === "default") return null;
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("en")) return "en";
  return null;
}

function uiLanguageFromDocument() {
  if (typeof document === "undefined") return null;
  const text = [
    document.documentElement?.lang,
    document.body?.innerText,
    document.body?.textContent,
  ].filter(Boolean).join("\n");
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : null;
}

function documentLanguageFromHtml() {
  if (typeof document === "undefined") return null;
  const value = String(document.documentElement?.lang || "").trim().toLowerCase();
  return value.startsWith("zh") ? "zh" : null;
}

function browserLanguageFromNavigator() {
  if (typeof navigator === "undefined") return null;
  const value = String(navigator.language || "").trim().toLowerCase();
  return value.startsWith("zh") ? "zh" : null;
}

function publicLanguageFromGlobals() {
  const globalCandidates = [
    globalThis.__codexppPublicSettings,
    globalThis.__codexppSettings,
    globalThis.__codex?.settings,
  ];
  for (const candidate of globalCandidates) {
    const value = candidate?.localeOverride ?? candidate?.values?.localeOverride;
    if (typeof value === "string" && value.trim()) return value;
  }
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !/codex|setting|locale|language/i.test(key)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw || !raw.includes("localeOverride")) continue;
      const value = findLocaleOverride(JSON.parse(raw));
      if (value) return value;
    }
  } catch {}
  return null;
}

function findLocaleOverride(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.localeOverride === "string") return value.localeOverride;
  if (typeof value.values?.localeOverride === "string") return value.values.localeOverride;
  for (const child of Object.values(value)) {
    const result = findLocaleOverride(child);
    if (result) return result;
  }
  return null;
}

function t(key, ...args) {
  const entry = TEXT[currentLanguage()][key] ?? TEXT.en[key] ?? key;
  return typeof entry === "function" ? entry(...args) : entry;
}

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    const state = createState(api);
    this._state = state;

    installStyle();
    installRouteHooks(state);
    startTimelineRuntime(state);

    if (typeof api.settings?.registerPage === "function") {
      this._pageHandle = api.settings.registerPage({
        id: PAGE_ID,
        title: t("pageTitle"),
        iconSvg: timelineIconSvg(),
        render(root) {
          renderSettings(root, state);
        },
      });
    } else if (typeof api.settings?.register === "function") {
      this._pageHandle = api.settings.register({
        id: PAGE_ID,
        title: t("pageTitle"),
        description: t("pageDescription"),
        render(root) {
          renderSettings(root, state);
        },
      });
    }
  },

  stop() {
    this._pageHandle?.unregister?.();
    this._pageHandle = null;
    this._state?.dispose?.();
    this._state = null;
  },
};

function createState(api) {
  const enabled = api.storage.get(STORAGE_KEY_ENABLED, true) !== false;
  const state = {
    api,
    enabled,
    observer: null,
    resizeObserver: null,
    refreshTimer: null,
    refreshRaf: 0,
    pollTimer: null,
    activeScroller: null,
    scrollerListener: null,
    routeUnpatch: null,
    settingsRerender: null,
    dispose() {
      stopTimelineRuntime(state);
      state.routeUnpatch?.();
      state.routeUnpatch = null;
      state.settingsRerender = null;
    },
  };
  return state;
}

function startTimelineRuntime(state) {
  observeDom(state);
  observeViewport(state);
  state.pollTimer = setInterval(() => {
    scheduleRefresh(state);
  }, REFRESH_INTERVAL_MS);
  scheduleRefresh(state);
}

function stopTimelineRuntime(state) {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  if (state.refreshRaf) {
    cancelAnimationFrame(state.refreshRaf);
    state.refreshRaf = 0;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.observer?.disconnect?.();
  state.observer = null;
  state.resizeObserver?.disconnect?.();
  state.resizeObserver = null;
  detachScrollerListener(state);
  removeConversationTimeline();
}

function installRouteHooks(state) {
  const history = window.history;
  if (!history || history.__codexppTimelineEnhancementPatched) {
    state.routeUnpatch = () => {};
    return;
  }

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const notify = () => scheduleRefresh(state);

  history.pushState = function patchedPushState(...args) {
    const result = originalPushState(...args);
    notify();
    return result;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState(...args);
    notify();
    return result;
  };
  history.__codexppTimelineEnhancementPatched = true;
  window.addEventListener("popstate", notify, true);
  window.addEventListener("hashchange", notify, true);

  state.routeUnpatch = () => {
    window.removeEventListener("popstate", notify, true);
    window.removeEventListener("hashchange", notify, true);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    delete history.__codexppTimelineEnhancementPatched;
  };
}

function observeDom(state) {
  const observer = new MutationObserver((mutations) => {
    if (!state.enabled) return;
    if (!shouldScheduleScan(mutations)) return;
    scheduleRefresh(state);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  state.observer = observer;
}

function observeViewport(state) {
  const onResize = () => scheduleRefresh(state);
  window.addEventListener("resize", onResize, true);
  state.resizeObserver = {
    disconnect() {
      window.removeEventListener("resize", onResize, true);
    },
  };
}

function scheduleRefresh(state) {
  if (!state.enabled) {
    removeConversationTimeline();
    return;
  }
  if (state.refreshRaf) return;
  state.refreshRaf = requestAnimationFrame(() => {
    state.refreshRaf = 0;
    try {
      refreshConversationTimeline(state);
    } catch (error) {
      state.api.log.debug("Timeline refresh failed:", error);
    }
  });
}

function refreshConversationTimeline(state) {
  if (!state.enabled) {
    removeConversationTimeline();
    return;
  }

  const questions = prepareTimelineQuestions(conversationTimelineQuestions());
  if (questions.length === 0) {
    detachScrollerListener(state);
    removeConversationTimeline();
    return;
  }

  attachScrollerListener(state, questions[0].node);

  const signature = timelineSignature(questions);
  const existing = document.querySelector(`.${TIMELINE_CLASS}`);
  if (
    existing?.dataset.codexConversationTimelineVersion === TIMELINE_VERSION &&
    existing?.dataset.codexConversationTimelineSignature === signature
  ) {
    return;
  }

  removeConversationTimeline();

  const container = document.createElement("div");
  container.className = TIMELINE_CLASS;
  container.dataset.codexConversationTimelineVersion = TIMELINE_VERSION;
  container.dataset.codexConversationTimelineSignature = signature;

  const track = document.createElement("div");
  track.className = TIMELINE_TRACK_CLASS;
  container.appendChild(track);

  for (const question of questions) {
    container.appendChild(createConversationTimelineMarker(question));
  }

  document.body.appendChild(container);
}

function attachScrollerListener(state, node) {
  const nextScroller = nearestTimelineScroller(node);
  if (state.activeScroller === nextScroller) return;
  detachScrollerListener(state);
  state.activeScroller = nextScroller;
  state.scrollerListener = () => {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      scheduleRefresh(state);
    }, 80);
  };
  nextScroller?.addEventListener?.("scroll", state.scrollerListener, { passive: true });
}

function detachScrollerListener(state) {
  if (state.activeScroller && state.scrollerListener) {
    state.activeScroller.removeEventListener("scroll", state.scrollerListener, { passive: true });
  }
  state.activeScroller = null;
  state.scrollerListener = null;
}

function installStyle() {
  const existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${TIMELINE_CLASS} {
      position: fixed;
      top: calc(72px + 12px);
      right: 12px;
      bottom: calc(28px + 12px);
      width: 24px;
      z-index: 2147482500;
      pointer-events: none;
    }
    .${TIMELINE_TRACK_CLASS} {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 50%;
      width: 2px;
      transform: translateX(-50%);
      border-radius: 999px;
      background: rgba(209, 213, 219, .55);
    }
    .${TIMELINE_MARKER_CLASS} {
      position: absolute;
      left: 50%;
      width: 12px;
      height: 12px;
      border: 0;
      border-radius: 999px;
      transform: translate(-50%, -50%);
      background: #d1d5db;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 0 0 2px rgba(255, 255, 255, .92);
    }
    .${TIMELINE_MARKER_CLASS}:hover,
    .${TIMELINE_MARKER_CLASS}:focus-visible,
    .${TIMELINE_MARKER_CLASS}.codexpp-conversation-timeline-marker-active {
      background: #8b8b8b;
      outline: none;
    }
    .${TIMELINE_TOOLTIP_CLASS} {
      position: absolute;
      right: 20px;
      top: 50%;
      display: block;
      box-sizing: border-box;
      width: max-content;
      max-width: min(320px, calc(100vw - 72px));
      transform: translateY(-50%);
      border-radius: 8px;
      background: rgba(80, 80, 80, .92);
      color: #ffffff;
      font: 600 13px system-ui, sans-serif;
      line-height: 18px;
      padding: 10px 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
    .${TIMELINE_MARKER_CLASS}:hover .${TIMELINE_TOOLTIP_CLASS},
    .${TIMELINE_MARKER_CLASS}:focus-visible .${TIMELINE_TOOLTIP_CLASS} {
      opacity: 1;
      visibility: visible;
      z-index: 2147482501;
    }
    .${TIMELINE_TARGET_CLASS} {
      animation: codexpp-conversation-timeline-pulse 1.2s ease-out;
    }
    @keyframes codexpp-conversation-timeline-pulse {
      0% { box-shadow: 0 0 0 0 rgba(16, 163, 127, .35); }
      100% { box-shadow: 0 0 0 14px rgba(16, 163, 127, 0); }
    }
  `;
  document.documentElement.appendChild(style);
}

function timelineIconSvg() {
  return [
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
    '<path d="M10 4.167v11.666M10 4.167 6.667 7.5M10 4.167 13.333 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    '<path d="M5.833 15.833h8.334" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    '</svg>',
  ].join("");
}

function renderSettings(root, state) {
  root.innerHTML = "";

  const wrapper = el("section", "display:grid;gap:12px;");
  wrapper.append(
    sectionTitle(t("sectionTitle")),
    settingsCard([
      settingsRow({
        title: t("enableTitle"),
        description: t("enableDescription"),
        control: switchControl(state.enabled, (value) => {
          state.enabled = value;
          state.api.storage.set(STORAGE_KEY_ENABLED, value);
          if (value) {
            scheduleRefresh(state);
          } else {
            removeConversationTimeline();
          }
          state.settingsRerender?.();
        }),
      }),
      settingsRow({
        title: t("notesTitle"),
        description: t("notesDescription"),
        control: statusPill(state.enabled ? t("enabled") : t("disabled"), state.enabled ? "pass" : "warn"),
      }),
    ])
  );

  root.appendChild(wrapper);
  state.settingsRerender = () => renderSettings(root, state);
}

function truncateTimelineQuestion(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= TIMELINE_QUESTION_LIMIT) return normalized;
  return `${chars.slice(0, TIMELINE_QUESTION_LIMIT).join("")}…`;
}

function conversationTimelineRoot() {
  return document.querySelector(".thread-scroll-container") || document.querySelector("main") || document.querySelector('[role="main"]');
}

function timelineQuestionSelector() {
  return [
    '[data-message-author-role="user"]',
    '[data-testid="conversation-turn"][data-message-author-role="user"]',
    '[data-testid="conversation-turn"] [data-message-author-role="user"]',
    '[class*="user-message"]',
    '[class*="UserMessage"]',
  ].join(", ");
}

function nodeOrAncestorLooksLikeCodexUserBubble(node) {
  if (node.nodeType !== 1) return false;
  const className = String(node.className || "");
  if (className.includes("bg-token-foreground/5") && node.parentElement?.classList?.contains("items-end")) return true;
  const bubble = node.closest?.("[class*='bg-token-foreground/5']");
  return !!bubble?.parentElement?.classList?.contains("items-end");
}

function nodeLooksLikeCodexUserBubble(node) {
  if (nodeOrAncestorLooksLikeCodexUserBubble(node)) return true;
  return !!node.querySelector?.(".group.flex.w-full.flex-col.items-end.justify-end.gap-1 > [class*='bg-token-foreground/5']");
}

function isExtensionUiNode(node) {
  return !!node?.closest?.(`.${TIMELINE_CLASS}`);
}

function nodeLooksLikeTimelineQuestion(node) {
  if (node.nodeType !== 1 || isExtensionUiNode(node)) return false;
  const questionSelector = timelineQuestionSelector();
  return !!node.matches?.(questionSelector) || !!node.closest?.(questionSelector) || !!node.querySelector?.(questionSelector) || nodeLooksLikeCodexUserBubble(node);
}

function conversationTimelineQuestionCandidates(root) {
  const explicitCandidates = Array.from(root.querySelectorAll([
    '[data-message-author-role="user"]',
    '[data-testid="conversation-turn"][data-message-author-role="user"]',
    '[data-testid="conversation-turn"] [data-message-author-role="user"]',
    '[class*="user-message"]',
    '[class*="UserMessage"]',
  ].join(", ")));
  const codexUserBubbles = Array.from(root.querySelectorAll(".group.flex.w-full.flex-col.items-end.justify-end.gap-1")).flatMap((group) => {
    return Array.from(group.children).filter((child) => String(child.className || "").includes("bg-token-foreground/5"));
  });
  return [...explicitCandidates, ...codexUserBubbles];
}

function extractTimelineQuestionText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll("button, svg, [aria-hidden='true'], .sr-only").forEach((child) => child.remove());
  return clone.textContent.replace(/\s+/g, " ").trim();
}

function timelineNodeId(node) {
  if (!node.__codexppConversationTimelineNodeId) {
    window.__codexppConversationTimelineNodeCounter = (window.__codexppConversationTimelineNodeCounter || 0) + 1;
    node.__codexppConversationTimelineNodeId = String(window.__codexppConversationTimelineNodeCounter);
  }
  return node.__codexppConversationTimelineNodeId;
}

function visibleTimelineNode(node) {
  if (!node.isConnected) return false;
  const style = getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 || !!node.textContent?.trim();
}

function conversationTimelineQuestions() {
  const root = conversationTimelineRoot();
  if (!root?.matches?.('.thread-scroll-container, main, [role="main"]')) return [];
  const seen = new Set();
  return conversationTimelineQuestionCandidates(root).flatMap((node) => {
    if (node.closest('[data-app-action-sidebar-thread-id]')) return [];
    if (isExtensionUiNode(node)) return [];
    const target = node.closest('[data-testid="conversation-turn"]') || node;
    if (seen.has(target)) return [];
    seen.add(target);
    if (!visibleTimelineNode(target)) return [];
    const text = extractTimelineQuestionText(node);
    if (!text) return [];
    return [{ node: target, text, nodeId: timelineNodeId(target) }];
  });
}

function timelineScrollerViewportTop(scroller) {
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) return 0;
  return scroller.getBoundingClientRect().top;
}

function timelineScrollableHeight(scroller) {
  return Math.max(1, scroller.scrollHeight - scroller.clientHeight);
}

function timelineRawMarkerTop(question, scroller) {
  const scrollOffset = scroller.scrollTop + question.node.getBoundingClientRect().top - timelineScrollerViewportTop(scroller);
  const percent = (scrollOffset / timelineScrollableHeight(scroller)) * 100;
  return Math.max(TIMELINE_MIN_TOP_PERCENT, Math.min(TIMELINE_MAX_TOP_PERCENT, percent));
}

function timelineMarkerTops(questions, scroller) {
  if (questions.length <= 1) return [50];
  const minGap = Math.min(
    TIMELINE_MAX_MARKER_GAP_PERCENT,
    (TIMELINE_MAX_TOP_PERCENT - TIMELINE_MIN_TOP_PERCENT) / Math.max(questions.length - 1, 1)
  );
  const tops = questions.map((question) => timelineRawMarkerTop(question, scroller));
  for (let index = 1; index < tops.length; index += 1) {
    tops[index] = Math.max(tops[index], tops[index - 1] + minGap);
  }
  for (let index = tops.length - 1; index >= 0; index -= 1) {
    const maxForIndex = TIMELINE_MAX_TOP_PERCENT - ((tops.length - 1 - index) * minGap);
    tops[index] = Math.min(tops[index], maxForIndex);
  }
  return tops.map((top) => Math.max(TIMELINE_MIN_TOP_PERCENT, Math.min(TIMELINE_MAX_TOP_PERCENT, top)));
}

function removeConversationTimeline() {
  document.querySelectorAll(`.${TIMELINE_CLASS}`).forEach((node) => node.remove());
}

function nearestTimelineScroller(node) {
  for (let current = node?.parentElement; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) return current;
  }
  return document.querySelector(".thread-scroll-container") || document.scrollingElement || document.documentElement;
}

function scrollTimelineTarget(node) {
  const scroller = nearestTimelineScroller(node);
  const nodeRect = node.getBoundingClientRect();
  const nextTop = scroller.scrollTop + nodeRect.top - timelineScrollerViewportTop(scroller) - (scroller.clientHeight / 2) + (nodeRect.height / 2);
  scroller.scrollTo({ top: nextTop, behavior: "smooth" });
}

function highlightTimelineTarget(node) {
  node.classList.remove(TIMELINE_TARGET_CLASS);
  void node.offsetWidth;
  node.classList.add(TIMELINE_TARGET_CLASS);
  clearTimeout(node.__codexppConversationTimelineHighlightTimer);
  node.__codexppConversationTimelineHighlightTimer = setTimeout(() => {
    node.classList.remove(TIMELINE_TARGET_CLASS);
  }, 1300);
}

function createConversationTimelineMarker(question) {
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = TIMELINE_MARKER_CLASS;
  marker.style.top = `${question.markerTop}%`;
  marker.setAttribute("aria-label", t("jumpTo", truncateTimelineQuestion(question.text)));

  const tooltip = document.createElement("span");
  tooltip.className = TIMELINE_TOOLTIP_CLASS;
  tooltip.id = `codexpp-conversation-timeline-tooltip-${question.nodeId}`;
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = truncateTimelineQuestion(question.text);
  marker.setAttribute("aria-describedby", tooltip.id);
  marker.appendChild(tooltip);

  const activateMarker = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    document.querySelectorAll(`.${TIMELINE_MARKER_CLASS}.codexpp-conversation-timeline-marker-active`).forEach((node) => {
      node.classList.remove("codexpp-conversation-timeline-marker-active");
    });
    marker.classList.add("codexpp-conversation-timeline-marker-active");
    scrollTimelineTarget(question.node);
    highlightTimelineTarget(question.node);
  };

  marker.addEventListener("pointerup", activateMarker, true);
  marker.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") activateMarker(event);
  }, true);
  return marker;
}

function prepareTimelineQuestions(questions) {
  if (questions.length === 0) return [];
  const scroller = nearestTimelineScroller(questions[0].node);
  const tops = timelineMarkerTops(questions, scroller);
  return questions.map((question, index) => ({ ...question, markerTop: Number(tops[index].toFixed(3)) }));
}

function timelineSignature(questions) {
  return questions.map((question) => `${question.nodeId}:${Math.round(question.markerTop * 10)}:${truncateTimelineQuestion(question.text)}`).join("|");
}

function scanRelevantSelector() {
  return [
    '[data-message-author-role]',
    '[data-testid="conversation-turn"]',
    '[class*="user-message"]',
    '[class*="UserMessage"]',
    ".thread-scroll-container",
    "main",
    '[role="main"]',
  ].join(", ");
}

function nodeSelfOrAncestorMatchesScanRelevance(node) {
  if (node.nodeType !== 1) return false;
  if (isExtensionUiNode(node)) return false;
  const questionSelector = timelineQuestionSelector();
  const relevantSelector = scanRelevantSelector();
  return !!node.matches?.(relevantSelector) ||
    !!node.closest?.(relevantSelector) ||
    !!node.matches?.(questionSelector) ||
    !!node.closest?.(questionSelector) ||
    nodeOrAncestorLooksLikeCodexUserBubble(node);
}

function isScanRelevantNode(node) {
  if (node.nodeType !== 1) return false;
  if (isExtensionUiNode(node)) return false;
  return nodeSelfOrAncestorMatchesScanRelevance(node) || !!node.querySelector?.(scanRelevantSelector()) || nodeLooksLikeTimelineQuestion(node);
}

function isChatContentMutation(mutation) {
  const target = mutation.target;
  if (!target?.closest?.('[data-message-author-role], [data-testid="conversation-turn"], main .prose')) return false;
  return !Array.from(mutation.addedNodes).some((node) => node.nodeType === 1 && isScanRelevantNode(node)) &&
    !Array.from(mutation.removedNodes).some((node) => node.nodeType === 1 && isScanRelevantNode(node));
}

function shouldScheduleScan(mutations) {
  if (!mutations) return true;
  return mutations.some((mutation) => {
    if (isChatContentMutation(mutation)) return false;
    const target = mutation.target;
    if (isExtensionUiNode(target)) return false;
    if (target?.nodeType === 1 && nodeSelfOrAncestorMatchesScanRelevance(target)) return true;
    const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
    return changedNodes.some((node) => node.nodeType === 1 && isScanRelevantNode(node));
  });
}

function sectionTitle(text) {
  return textEl("div", text, "font-size:16px;font-weight:650;line-height:1.3;");
}

function settingsCard(children) {
  const card = el("div", "border:1px solid var(--token-border, rgba(127,127,127,0.18));border-radius:12px;overflow:hidden;display:grid;");
  for (const child of children) card.appendChild(child);
  const last = card.lastElementChild;
  if (last) last.style.borderBottom = "0";
  return card;
}

function settingsRow({ title, description, control }) {
  const row = el("div", "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--token-border, rgba(127,127,127,0.14));");
  const copy = el("div", "display:grid;gap:2px;min-width:0;");
  copy.append(
    textEl("div", title, "font-size:14px;font-weight:550;"),
    textEl("div", description, "font-size:12px;line-height:1.4;color:var(--token-text-secondary, var(--text-secondary, #666));")
  );
  row.append(copy, control);
  return row;
}

function switchControl(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.setAttribute(
    "style",
    "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)];display:block;height:16px;width:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12);transition:transform .2s ease-out;"
  );
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.setAttribute(
      "style",
      "appearance:none;border:0;background:transparent;padding:0;display:inline-flex;align-items:center;cursor:pointer;"
    );
    pill.setAttribute(
      "style",
      [
        "position:relative",
        "display:inline-flex",
        "align-items:center",
        "width:32px",
        "height:20px",
        "border-radius:999px",
        "transition:background .2s ease-out",
        `background:${on ? "var(--token-charts-blue, #2563eb)" : "rgba(127,127,127,.35)"}`,
      ].join(";")
    );
    knob.style.transform = on ? "translateX(14px)" : "translateX(2px)";
  };
  apply(initial);
  btn.appendChild(pill);
  btn.addEventListener("click", async () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    apply(next);
    await onChange(next);
  });
  return btn;
}

function statusPill(text, state) {
  const colors = {
    pass: ["#0f7b45", "rgba(15,123,69,0.10)"],
    warn: ["#9a5b00", "rgba(154,91,0,0.12)"],
  };
  const [color, background] = colors[state] || colors.warn;
  return textEl(
    "span",
    text,
    `display:inline-flex;align-items:center;justify-content:center;min-height:24px;padding:0 9px;border-radius:999px;background:${background};color:${color};font-size:12px;font-weight:600;white-space:nowrap;`
  );
}

function el(tag, style) {
  const node = document.createElement(tag);
  if (style) node.setAttribute("style", style);
  return node;
}

function textEl(tag, text, style) {
  const node = el(tag, style);
  node.textContent = text;
  return node;
}
