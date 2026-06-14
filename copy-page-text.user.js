// ==UserScript==
// @name         Clean Page Text Copier
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Expand collapsed content, extract script-embedded modal dialogs, and copy clean text. SPA/React-aware - waits for rendered content, handles client-side navigation. Draggable button.
// @author       Isaac
// @match        *://*/*
// @match        *://*.ibm.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Minimum characters in a SPA container to consider the page loaded
    const SPA_CONTENT_THRESHOLD = 100;

    const btn = document.createElement('button');
    btn.innerHTML = '📋 Copy All Text';
    btn.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        padding: 10px 18px;
        background: #6200ea;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-family: sans-serif;
        font-size: 13px;
        font-weight: 600;
        cursor: grab;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        user-select: none;
        touch-action: none;
    `;

    document.body.appendChild(btn);

    // --- Drag logic ---
    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let moved = false;

    btn.addEventListener('mousedown', (e) => {
        dragging = true;
        moved = false;
        const rect = btn.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        btn.style.cursor = 'grabbing';
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        btn.style.left = rect.left + 'px';
        btn.style.top = rect.top + 'px';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        moved = true;
        btn.style.left = (e.clientX - dragOffsetX) + 'px';
        btn.style.top = (e.clientY - dragOffsetY) + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        btn.style.cursor = 'grab';
        if (!moved) copyAll();
    });

    // Touch support
    btn.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        dragging = true;
        moved = false;
        const rect = btn.getBoundingClientRect();
        dragOffsetX = touch.clientX - rect.left;
        dragOffsetY = touch.clientY - rect.top;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        btn.style.left = rect.left + 'px';
        btn.style.top = rect.top + 'px';
        e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        moved = true;
        const touch = e.touches[0];
        btn.style.left = (touch.clientX - dragOffsetX) + 'px';
        btn.style.top = (touch.clientY - dragOffsetY) + 'px';
    });

    document.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved) copyAll();
    });

    // --- SPA navigation: cancel any in-progress retry loop on route change ---
    let retryTimer = null;

    function cancelRetry() {
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
            btn.innerHTML = '📋 Copy All Text';
            btn.style.background = '#6200ea';
        }
    }

    const _pushState = history.pushState.bind(history);
    history.pushState = function (...args) {
        _pushState(...args);
        cancelRetry();
    };

    const _replaceState = history.replaceState.bind(history);
    history.replaceState = function (...args) {
        _replaceState(...args);
        cancelRetry();
    };

    window.addEventListener('popstate', cancelRetry);

    // --- SPA root detection ---
    // Common SPA mount-point selectors; checked in order of specificity.
    // IBM Learning-specific containers are listed first as high-priority candidates.
    const SPA_SELECTORS = [
        '#layout-level-react-content',
        '#layout-level-react',
        '#react-app', '#app', '#root', '#__next', '#__nuxt'
    ];

    function getSpaRoot() {
        for (const sel of SPA_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && (el.innerText || '').trim().length >= SPA_CONTENT_THRESHOLD) {
                return el;
            }
        }
        return null;
    }

    function hasSpaContainer() {
        return SPA_SELECTORS.some(sel => document.querySelector(sel));
    }

    // --- Text extraction ---
    function extractText(root) {
        // Expand Bootstrap 3 + 4/5 collapses
        root.querySelectorAll('.collapse').forEach(el => {
            el.classList.add('in', 'show');
        });

        // Open all <details> elements
        root.querySelectorAll('details').forEach(el => (el.open = true));

        // Strip [hidden] attributes
        root.querySelectorAll('[hidden]').forEach(el => el.removeAttribute('hidden'));

        // Unhide aria-hidden panels
        root.querySelectorAll('[aria-hidden="true"]').forEach(el => {
            el.setAttribute('aria-hidden', 'false');
        });

        // Force-show tab panels and accordion bodies so their text is reachable
        root.querySelectorAll('.tabcontent, .tab-pane').forEach(el => {
            el.style.removeProperty('display');
        });
        root.querySelectorAll('.panel-body, .panel-collapse').forEach(el => {
            el.classList.add('in', 'show');
            el.style.removeProperty('display');
        });

        const skipTags = new Set(['script', 'style', 'noscript', 'svg', 'head', 'meta', 'link']);
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    const tag = node.parentElement?.tagName?.toLowerCase();
                    return skipTags.has(tag)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const lines = [];
        let node;
        while ((node = walker.nextNode())) {
            const text = node.textContent.trim();
            if (text) lines.push(text);
        }

        // Deduplicate consecutive identical lines
        return lines.filter((line, i) => line !== lines[i - 1]).join('\n');
    }

    // --- Hidden panel extraction ---
    // Explicitly walks .tabcontent and .panel-body elements to capture content
    // that may not have been reached by the main TreeWalker (e.g. deeply nested
    // collapsed panels). Deduplicates against mainText via a prefix check.
    function extractHiddenPanels(root, mainText) {
        const sections = [];
        root.querySelectorAll('.tabcontent, .panel-body').forEach(el => {
            const text = extractText(el).trim();
            if (text.length > 20 && !mainText.includes(text.slice(0, 80))) {
                sections.push(text);
            }
        });
        return sections.join('\n\n');
    }

    // --- Modal content extraction ---
    // Some pages embed dialog content as HTML strings inside <script> event listeners
    // (e.g. `element.addEventListener('click', () => { document.dialogMaker(\`...\`) })`).    
    // This parses those template literals directly rather than clicking each trigger.
    function extractModalContent(root) {
        const sections = [];
        root.querySelectorAll('script').forEach(script => {
            const src = script.textContent;
            // \s* allows optional whitespace between closing backtick and paren
            const matches = [...src.matchAll(/dialogMaker\(`([\s\S]*?)`\s*\)/g)];
            matches.forEach(m => {
                const tmp = document.createElement('div');
                tmp.innerHTML = m[1];
                const title = tmp.querySelector('[slot="title"]')?.textContent?.trim();
                const body = tmp.querySelector('[slot="content"]')?.textContent?.trim();
                if (title && body) sections.push(`### ${title}\n${body}`);
            });
        });
        return sections;
    }

    // --- Copy logic ---
    function assembleOutput(root) {
        const mainText = extractText(root);
        const parts = [mainText];

        const hiddenPanelText = extractHiddenPanels(root, mainText);
        if (hiddenPanelText) {
            parts.push('--- Hidden Panel Content ---');
            parts.push(hiddenPanelText);
        }

        const modalSections = extractModalContent(root);
        if (modalSections.length > 0) {
            parts.push('--- Modal Content ---');
            parts.push(modalSections.join('\n\n'));
        }
        return parts.join('\n\n');
    }

    function copyAll(retryCount = 0) {
        if (hasSpaContainer()) {
            const spaRoot = getSpaRoot();
            if (!spaRoot) {
                // Content not yet rendered - retry up to 6 times (~9s total)
                if (retryCount < 6) {
                    flash('⏳ Loading...', '#e65100');
                    retryTimer = setTimeout(() => copyAll(retryCount + 1), 1500);
                    return;
                }
                // Timed out - fall back to the full document body
                flash('⚠️ Copied (partial)', '#b71c1c', 3000);
                doWrite(assembleOutput(document.body));
                return;
            }
            doWrite(assembleOutput(spaRoot));
        } else {
            doWrite(assembleOutput(document.body));
        }
    }

    function doWrite(output) {
        retryTimer = null;
        navigator.clipboard.writeText(output)
            .then(() => flash('✅ Copied!', '#00897b'))
            .catch(() => {
                const ta = document.createElement('textarea');
                ta.value = output;
                Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0', left: '0' });
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                flash('✅ Copied!', '#00897b');
            });
    }

    function flash(label, color, durationMs = 2000) {
        btn.innerHTML = label;
        btn.style.background = color;
        setTimeout(() => {
            btn.innerHTML = '📋 Copy All Text';
            btn.style.background = '#6200ea';
        }, durationMs);
    }
})();
