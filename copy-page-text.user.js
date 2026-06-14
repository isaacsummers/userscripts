// ==UserScript==
// @name         Clean Page Text Copier
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Expand all hidden/collapsed content and copy clean text. Toggle via extension. Draggable button.
// @author       Isaac
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

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

    document.addEventListener('mouseup', (e) => {
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

    function copyAll() {
        // Expand Bootstrap 3 + 4/5 collapses
        document.querySelectorAll('.collapse').forEach(el => {
            el.classList.add('in', 'show');
        });

        // Open all <details> elements
        document.querySelectorAll('details').forEach(el => (el.open = true));

        // Strip [hidden] attributes
        document.querySelectorAll('[hidden]').forEach(el => el.removeAttribute('hidden'));

        // Unhide aria-hidden panels
        document.querySelectorAll('[aria-hidden="true"]').forEach(el => {
            el.setAttribute('aria-hidden', 'false');
        });

        // TreeWalker — grabs ALL text nodes including display:none
        const skipTags = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link']);
        const walker = document.createTreeWalker(
            document.body,
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
        const deduped = lines.filter((line, i) => line !== lines[i - 1]);
        const output = deduped.join('\n');

        // Copy to clipboard
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

    function flash(label, color) {
        btn.innerHTML = label;
        btn.style.background = color;
        setTimeout(() => {
            btn.innerHTML = '📋 Copy All Text';
            btn.style.background = '#6200ea';
        }, 2000);
    }
})();
