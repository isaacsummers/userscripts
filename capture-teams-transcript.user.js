// ==UserScript==
// @name         Teams Transcript Capture
// @namespace    x
// @version      1.0
// @description  Capture full Teams meeting transcripts from virtualized list view
// @match        https://*.sharepoint.com/*
// @match        https://teams.microsoft.com/*
// @match        https://*.teams.microsoft.com/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. Pure helper functions (from capture-teams-transcript.js)
  // ---------------------------------------------------------------------------

  function parseSpeakerName(entryEl) {
    // aria-label on the entry element (baseEntry-500)
    var label = entryEl.getAttribute("aria-label") || "";
    var ariaMatch = label.match(/^(.+?)\s+\d+\s*(hour|minute|second)/i);
    if (ariaMatch) return ariaMatch[1].trim();

    // Display name span in sibling itemHeader (speaker-change entries)
    var listItem = entryEl.closest('[id^="listItem-"]');
    if (listItem) {
      var nameEl = listItem.querySelector("[class*='itemDisplayName']");
      if (nameEl) return nameEl.textContent.trim();
    }

    // timestampSpeakerAriaLabel span (always present, contains "Speaker N minutes M seconds")
    var tsLabel = entryEl.querySelector('[id^="timestampSpeakerAriaLabel-"]');
    if (tsLabel) {
      var tsText = tsLabel.textContent.trim();
      var tsMatch = tsText.match(/^(.+?)\s+\d+\s*(hour|minute|second)/i);
      if (tsMatch) return tsMatch[1].trim();
    }

    // Walk up to ms-List-cell and check aria-label on baseEntry within
    var cell = entryEl.closest(".ms-List-cell");
    if (cell) {
      var baseEntry = cell.querySelector('[class*="baseEntry"]');
      if (baseEntry && baseEntry !== entryEl) {
        var cellLabel = baseEntry.getAttribute("aria-label") || "";
        var cellMatch = cellLabel.match(/^(.+?)\s+\d+\s*(hour|minute|second)/i);
        if (cellMatch) return cellMatch[1].trim();
      }
    }

    return "Unknown";
  }

  function parseEntryText(entryEl) {
    // When targeting entry-N, the text lives in the sub-entry-N child
    var subEntry = entryEl.querySelector('[id^="sub-entry-"]');
    if (subEntry) return subEntry.textContent.trim();

    // Direct entryText class lookup
    var textEl =
      entryEl.querySelector("[class*='entryText']") ||
      entryEl.querySelector("[class*='entry-text']");
    if (textEl) return textEl.textContent.trim();

    // Fallback: grab all paragraph text
    var paragraphs = entryEl.querySelectorAll("p");
    if (paragraphs.length > 0) {
      return Array.from(paragraphs)
        .map(function (p) {
          return p.textContent.trim();
        })
        .join(" ");
    }

    return entryEl.textContent.trim();
  }

  function parseEntryIndex(entryEl) {
    var id = entryEl.id || "";
    var match = id.match(/^(?:sub-)?entry-(\d+)$/);
    return match ? parseInt(match[1], 10) : -1;
  }

  function parseTimestamp(entryEl) {
    // Try Header-timestamp element for compact display time
    var listItem = entryEl.closest('[id^="listItem-"]');
    if (listItem) {
      var tsEl = listItem.querySelector('[id^="Header-timestamp-"]');
      if (tsEl) {
        var tsText = tsEl.textContent.trim();
        // Already compact like "1:56" or "27:02" — use directly
        if (/^\d+:\d{2}(:\d{2})?$/.test(tsText)) return tsText;
        // ISO duration like "PT27M2S" — parse it
        var isoMatch = tsText.match(
          /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i
        );
        if (isoMatch) {
          var h = parseInt(isoMatch[1] || "0", 10);
          var m = parseInt(isoMatch[2] || "0", 10);
          var s = parseInt(isoMatch[3] || "0", 10);
          if (h > 0)
            return (
              h +
              ":" +
              String(m).padStart(2, "0") +
              ":" +
              String(s).padStart(2, "0")
            );
          return m + ":" + String(s).padStart(2, "0");
        }
      }
    }

    // Parse from aria-label "Speaker 1 minute 56 seconds"
    var label = entryEl.getAttribute("aria-label") || "";

    // If aria-label is empty, try timestampSpeakerAriaLabel span
    if (!label) {
      var tsLabelEl = entryEl.querySelector(
        '[id^="timestampSpeakerAriaLabel-"]'
      );
      if (tsLabelEl) label = tsLabelEl.textContent.trim();
    }

    if (label) {
      var hourMatch = label.match(/(\d+)\s+hours?/i);
      var minMatch = label.match(/(\d+)\s+minutes?/i);
      var secMatch = label.match(/(\d+)\s+seconds?/i);
      var h2 = hourMatch ? parseInt(hourMatch[1], 10) : 0;
      var m2 = minMatch ? parseInt(minMatch[1], 10) : 0;
      var s2 = secMatch ? parseInt(secMatch[1], 10) : 0;
      if (h2 > 0)
        return (
          h2 +
          ":" +
          String(m2).padStart(2, "0") +
          ":" +
          String(s2).padStart(2, "0")
        );
      if (m2 > 0 || s2 > 0) return m2 + ":" + String(s2).padStart(2, "0");
    }

    return "";
  }

  function parseEntryElement(entryEl) {
    return {
      index: parseEntryIndex(entryEl),
      speaker: parseSpeakerName(entryEl),
      timestamp: parseTimestamp(entryEl),
      text: parseEntryText(entryEl),
    };
  }

  function formatOutput(entriesMap, totalExpected, meta) {
    var sorted = Array.from(entriesMap.values()).sort(function (a, b) {
      return a.index - b.index;
    });
    var result = {
      captured: sorted.length,
      total_expected: totalExpected,
      entries: sorted,
    };
    if (meta) {
      if (meta.title)       result.title       = meta.title;
      if (meta.date)        result.date        = meta.date;
      if (meta.description) result.description = meta.description;
    }
    return result;
  }

  /**
   * Merge consecutive same-speaker entries and render as one-line-per-turn
   * text for direct LLM consumption.
   *
   * Format:
   *   [M:SS] Speaker Name: all text from that turn joined on one line
   */
  function formatLLM(entries, totalExpected, meta) {
    if (!entries || entries.length === 0) return "";

    // Sort by index
    var sorted = entries.slice().sort(function (a, b) {
      return a.index - b.index;
    });

    // Merge consecutive same-speaker entries into blocks
    var blocks = [];
    var cur = null;
    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i];
      if (cur && cur.speaker === e.speaker) {
        cur.texts.push(e.text);
      } else {
        if (cur) blocks.push(cur);
        cur = { speaker: e.speaker, timestamp: e.timestamp, texts: [e.text] };
      }
    }
    if (cur) blocks.push(cur);

    // Build header
    var lines = [];
    if (meta && meta.title)       lines.push("title: "       + meta.title);
    if (meta && meta.date)        lines.push("date: "        + meta.date);
    if (meta && meta.description) lines.push("description: " + meta.description);
    lines.push("entries: " + sorted.length);
    if (totalExpected > 0) {
      lines.push("total_expected: " + totalExpected);
      if (sorted.length < totalExpected) {
        lines.push("missing: " + (totalExpected - sorted.length));
      }
    }
    var speakers = {};
    blocks.forEach(function (b) { speakers[b.speaker] = true; });
    lines.push("speakers: " + Object.keys(speakers).length);
    lines.push("turns: " + blocks.length);
    lines.push("");

    // One line per turn
    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j];
      var ts = b.timestamp || "0:00";
      var text = b.texts.join(" ");
      lines.push("[" + ts + "] " + b.speaker + ": " + text);
      if (j < blocks.length - 1) lines.push("");
    }

    lines.push("");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Meeting metadata — scrape title, date, description from the live page
  // ---------------------------------------------------------------------------

  /**
   * Try to extract meeting metadata from the live Teams DOM.
   *
   * Teams' exact class names change with deployments, so we use multiple
   * strategies in order of reliability and log what was found so you can
   * tune selectors if anything comes back empty.
   *
   * Returns { title, date, description } — any field may be "" if not found.
   */
  function getMeetingMetadata() {
    var meta = { title: "", date: "", description: "" };

    // --- Title ---
    // Strategy 1: <title> tag (most reliable on full-page saves, works live too)
    var pageTitle = document.title || "";
    if (pageTitle) {
      // Strip " | Microsoft Teams" suffix
      meta.title = pageTitle.replace(/\s*\|\s*Microsoft Teams\s*$/i, "").trim();
    }

    // Strategy 2: h1/h2 with role="heading" near the recap area
    if (!meta.title) {
      var headings = document.querySelectorAll('h1[role="heading"], h2[role="heading"], [role="heading"][aria-level="1"], [role="heading"][aria-level="2"]');
      for (var i = 0; i < headings.length; i++) {
        var t = (headings[i].textContent || "").trim();
        if (t && t.length > 2 && t.length < 200) {
          meta.title = t;
          break;
        }
      }
    }

    // Strategy 3: data-tid attributes Teams uses on recap header elements
    if (!meta.title) {
      var tidTitle = document.querySelector('[data-tid*="meeting-title"], [data-tid*="recap-title"], [data-tid*="event-title"]');
      if (tidTitle) meta.title = (tidTitle.textContent || "").trim();
    }

    // --- Date ---
    // Strategy 1: data-tid date elements
    var tidDate = document.querySelector('[data-tid*="meeting-date"], [data-tid*="recap-date"], [data-tid*="event-date"], [data-tid*="recap-header-date"]');
    if (tidDate) meta.date = (tidDate.textContent || "").trim();

    // Strategy 2: <time> element (Teams sometimes uses a <time datetime="..."> for the meeting time)
    if (!meta.date) {
      var timeEl = document.querySelector('time[datetime]');
      if (timeEl) {
        meta.date = (timeEl.getAttribute('datetime') || timeEl.textContent || "").trim();
      }
    }

    // Strategy 3: class name heuristics
    if (!meta.date) {
      var dateEl = document.querySelector('[class*="meetingDate"], [class*="recapDate"], [class*="eventDate"], [class*="meeting-date"]');
      if (dateEl) meta.date = (dateEl.textContent || "").trim();
    }

    // --- Description ---
    // Strategy 1: data-tid description elements
    var tidDesc = document.querySelector('[data-tid*="meeting-description"], [data-tid*="recap-description"], [data-tid*="event-description"]');
    if (tidDesc) meta.description = (tidDesc.textContent || "").trim();

    // Strategy 2: meta tag
    if (!meta.description) {
      var metaDesc = document.querySelector('meta[name="description"], meta[property="og:description"]');
      if (metaDesc) meta.description = (metaDesc.getAttribute('content') || "").trim();
    }

    // Strategy 3: class name heuristics
    if (!meta.description) {
      var descEl = document.querySelector('[class*="meetingDescription"], [class*="recapDescription"], [class*="eventDescription"]');
      if (descEl) meta.description = (descEl.textContent || "").trim();
    }

    console.log("[Transcript Capture] Meeting metadata:", JSON.stringify(meta));
    return meta;
  }

  // ---------------------------------------------------------------------------
  // ISO 8601 duration (PT26M48S) → compact timestamp (26:48)
  // ---------------------------------------------------------------------------

  function parseISODuration(str) {
    if (!str || typeof str !== "string") return str || "";
    var m = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (!m) return str; // not ISO duration, return as-is
    var h = parseInt(m[1] || "0", 10);
    var min = parseInt(m[2] || "0", 10);
    var sec = parseInt(m[3] || "0", 10);
    if (h > 0) return h + ":" + String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return min + ":" + String(sec).padStart(2, "0");
  }

  // ---------------------------------------------------------------------------
  // React fiber extraction — fast path, skip scrolling entirely if it works
  // ---------------------------------------------------------------------------

  function tryReactFiberExtraction(listEl, totalExpected) {
    try {
      var fiberKey = Object.keys(listEl).find(function (k) {
        return k.startsWith("__reactFiber$");
      });
      if (!fiberKey) return null;

      var fiber = listEl[fiberKey];
      var items = null;

      // Walk up the fiber tree looking for memoizedProps.items
      for (var depth = 0; fiber && depth < 30; depth++) {
        var props = fiber.memoizedProps;
        if (props && Array.isArray(props.items) && props.items.length > 0) {
          items = props.items;
          break;
        }
        fiber = fiber.return;
      }

      if (!items) return null;
      if (totalExpected > 0 && items.length < totalExpected * 0.8) return null;

      // Log the first item's keys so we can see the actual data model
      if (items[0]) {
        console.log("[Transcript Capture] Fiber item keys:", Object.keys(items[0]).join(", "));
        console.debug("[Transcript Capture] Fiber item[0] sample:", JSON.stringify(items[0]).slice(0, 500));
      }

      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) continue;

        // The shape depends on Teams' internal data model — try many candidate fields
        var speaker = item.displayName || item.speaker || item.name
          || item.participantName || item.authorName || item.author
          || (item.participant && (item.participant.displayName || item.participant.name))
          || "Unknown";

        var rawTimestamp = item.timestamp || item.time || item.startTime
          || item.offset || item.timeOffset || "";

        var text = item.text || item.content || item.message
          || item.body || item.transcript || "";

        var entry = {
          index: i,
          speaker: speaker,
          timestamp: parseISODuration(rawTimestamp),
          text: text,
        };

        // Skip items that don't look like transcript entries
        if (!entry.text && entry.speaker === "Unknown") continue;
        entries.push(entry);
      }

      if (entries.length === 0) return null;

      // Safety net: if most speakers are still "Unknown", the field mapping is wrong.
      // Fall through to DOM path which reliably extracts speaker names.
      var unknownCount = entries.filter(function (e) { return e.speaker === "Unknown"; }).length;
      if (unknownCount > entries.length * 0.5) {
        console.debug("[Transcript Capture] Fiber extraction rejected: " + unknownCount + "/" + entries.length + " speakers unknown — falling through to DOM path");
        return null;
      }

      console.log(
        "[Transcript Capture] React fiber extraction succeeded: " +
          entries.length +
          " entries"
      );
      return entries;
    } catch (err) {
      console.debug(
        "[Transcript Capture] Fiber extraction failed:",
        err.message
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM scanning + scroll approach
  // ---------------------------------------------------------------------------

  function scanVisibleEntries(entriesMap) {
    var elements = document.querySelectorAll(
      '[class*="baseEntry"][id^="entry-"]'
    );
    elements.forEach(function (el) {
      if (!/^entry-\d+$/.test(el.id)) return;
      if (entriesMap.has(el.id)) return;
      var parsed = parseEntryElement(el);
      if (parsed.index < 0) return;
      entriesMap.set(el.id, parsed);
    });
  }

  function getTotalExpected() {
    // aria-setsize lives on sub-entry-N elements, not entry-N
    var firstSubEntry = document.querySelector('[id^="sub-entry-"]');
    if (!firstSubEntry) return -1;
    var setSize = firstSubEntry.getAttribute("aria-setsize");
    return setSize ? parseInt(setSize, 10) : -1;
  }

  function findScrollContainer(listEl) {
    // Try the known SharePoint viewer class first
    var spContainer = document.querySelector(
      ".ms-ScrollablePane--contentContainer"
    );
    if (spContainer) return spContainer;

    // Walk up from the list element to find the closest scrollable ancestor
    var el = listEl.parentElement;
    while (el && el !== document.body) {
      var style = getComputedStyle(el);
      var overflowY = style.overflowY || style.overflow;
      if (overflowY === "auto" || overflowY === "scroll") {
        return el;
      }
      el = el.parentElement;
    }

    // Last resort fallback
    return document.scrollingElement || document.documentElement;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function scrollThroughList(
    scrollContainer,
    entriesMap,
    totalExpected
  ) {
    var SCROLL_INCREMENT = 200;
    var SCROLL_DELAY_MS = 150;
    var TIMEOUT_MS = 60000;

    var startTime = Date.now();

    var progressInterval = setInterval(function () {
      console.log(
        "[Transcript Capture] Capturing... " +
          entriesMap.size +
          " entries found"
      );
    }, 1000);

    // Scroll to top first
    scrollContainer.scrollTop = 0;
    await sleep(300);

    try {
      while (true) {
        // Timeout guard
        if (Date.now() - startTime > TIMEOUT_MS) {
          console.warn(
            "[Transcript Capture] Timeout after 60s. Reporting what was captured."
          );
          break;
        }

        // Early completion: captured everything
        if (totalExpected > 0 && entriesMap.size >= totalExpected) break;

        var prevScrollTop = scrollContainer.scrollTop;
        scrollContainer.scrollTop += SCROLL_INCREMENT;
        await sleep(SCROLL_DELAY_MS);

        // Scan after each scroll step (catches anything the observer might miss)
        scanVisibleEntries(entriesMap);

        // Reached bottom — can't scroll further (tolerance-based for fractional pixels)
        if (Math.abs(scrollContainer.scrollTop - prevScrollTop) < 1) {
          // Retry once in case virtualizer is still loading
          await sleep(500);
          scrollContainer.scrollTop += SCROLL_INCREMENT;
          await sleep(SCROLL_DELAY_MS);
          if (Math.abs(scrollContainer.scrollTop - prevScrollTop) < 1) {
            // Final scan and brief wait for stragglers
            await sleep(300);
            scanVisibleEntries(entriesMap);
            break; // Truly at bottom
          }
        }
      }
    } finally {
      clearInterval(progressInterval);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Button UI functions
  // ---------------------------------------------------------------------------

  function showCaptureButton() {
    if (document.getElementById("tm-transcript-capture-btn")) return;

    var btn = document.createElement("button");
    btn.id = "tm-transcript-capture-btn";
    btn.textContent = "\uD83D\uDCCB Capture Transcript";
    btn.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:99999;padding:8px 16px;" +
      "border:none;border-radius:20px;background:rgba(30,30,30,0.85);" +
      "color:#fff;font-size:13px;cursor:pointer;" +
      "font-family:system-ui,-apple-system,sans-serif;transition:opacity 0.2s;" +
      "opacity:0.7;box-shadow:0 2px 8px rgba(0,0,0,0.3);";
    btn.onmouseenter = function () {
      btn.style.opacity = "1";
    };
    btn.onmouseleave = function () {
      if (!btn.disabled) btn.style.opacity = "0.7";
    };
    btn.onclick = function () {
      runCapture(btn);
    };
    document.body.appendChild(btn);
  }

  function waitForTranscriptPanel() {
    // Check if already present
    if (document.querySelector(".ms-List")) {
      showCaptureButton();
      return;
    }

    // Watch for it to appear
    var observer = new MutationObserver(function () {
      if (document.querySelector(".ms-List")) {
        observer.disconnect();
        showCaptureButton();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // 3. Main capture flow
  // ---------------------------------------------------------------------------

  async function captureTranscript(cancelToken) {
    var listEl = document.querySelector(".ms-List");
    if (!listEl) {
      throw new Error(
        "No .ms-List element found. Are you on the Teams transcript page?"
      );
    }

    var firstEntry = document.querySelector(
      '[id^="entry-"][class*="baseEntry"]'
    );
    if (!firstEntry) {
      var subEntry = document.querySelector('[id^="sub-entry-"]');
      if (!subEntry) {
        throw new Error(
          "No transcript entries found. The transcript may not be loaded yet."
        );
      }
    }

    var scrollContainer = findScrollContainer(listEl);
    console.log(
      "[Transcript Capture] Using scroll container:",
      scrollContainer.tagName,
      scrollContainer.className.slice(0, 100)
    );

    var totalExpected = getTotalExpected();
    console.log(
      "[Transcript Capture] Starting. Expected entries: " +
        (totalExpected > 0 ? totalExpected : "unknown")
    );

    // --- Fast path: try React fiber extraction ---

    var fiberEntries = tryReactFiberExtraction(listEl, totalExpected);
    if (fiberEntries) {
      return {
        captured: fiberEntries.length,
        total_expected:
          totalExpected > 0 ? totalExpected : fiberEntries.length,
        entries: fiberEntries,
      };
    }

    // --- Slow path: MutationObserver + auto-scroll ---

    var entriesMap = new Map();

    // Initial scan of what's already visible
    scanVisibleEntries(entriesMap);

    // Set up observer before scrolling
    var observer = new MutationObserver(function () {
      if (!cancelToken.cancelled) scanVisibleEntries(entriesMap);
    });
    observer.observe(listEl, { childList: true, subtree: true });

    // Scroll through the entire list
    await scrollThroughList(scrollContainer, entriesMap, totalExpected, cancelToken);

    // Disconnect observer — done collecting
    observer.disconnect();

    // Final scan in case anything slipped through
    scanVisibleEntries(entriesMap);

    return formatOutput(
      entriesMap,
      totalExpected > 0 ? totalExpected : entriesMap.size
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Button click handler — manages UI state, cancel, copy, and save
  // ---------------------------------------------------------------------------

  function saveTextAsFile(text, filename) {
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function resetBtn(btn) {
    // Remove any child spans (Copy/Save links)
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.textContent = "\uD83D\uDCCB Capture Transcript";
    btn.style.background = "rgba(30,30,30,0.85)";
    btn.style.opacity = "0.7";
    btn.style.cursor = "pointer";
    btn.disabled = false;
    btn.onclick = function () { runCapture(btn); };
  }

  async function runCapture(btn) {
    if (btn.disabled) return;

    // Shared cancel token — scroll loop checks this each iteration
    var cancelToken = { cancelled: false };

    // Show cancel button while running
    btn.disabled = false; // keep clickable for cancel
    btn.textContent = "\u23F9 Cancel";
    btn.style.background = "rgba(160,30,30,0.9)";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.onclick = function () {
      cancelToken.cancelled = true;
      btn.textContent = "Cancelling...";
      btn.disabled = true;
    };

    try {
      var meta = getMeetingMetadata();
      var output = await captureTranscript(cancelToken);

      if (cancelToken.cancelled) {
        resetBtn(btn);
        return;
      }

      var text = formatLLM(output.entries, output.total_expected, meta);

      // Always log to console as a safety net
      console.log(text);
      console.log(
        "[Transcript Capture] Captured " +
          output.captured + " of " + output.total_expected + " entries."
      );

      if (typeof GM_notification === "function") {
        GM_notification({
          text: "Captured " + output.captured + " of " + output.total_expected + " entries",
          title: "Transcript Capture",
          timeout: 3000,
        });
      }

      var summary = output.captured + "/" + output.total_expected + " entries";

      // Derive a sensible filename from meeting title + date
      var safeName = (meta.title || "transcript")
        .replace(/[\\\/:*?"<>|]/g, "-").replace(/\s+/g, "-").slice(0, 80);
      var safeDate = (meta.date || "").replace(/[\s,\/]/g, "-").replace(/-+/g, "-") || "";
      var filename = (safeName + (safeDate ? "-" + safeDate : "") + ".md").replace(/-+/g, "-");

      // Show ✅ N/N — 📋 Copy  💾 Save
      btn.disabled = true;
      btn.style.background = "rgba(34,139,34,0.9)";
      btn.style.cursor = "default";
      btn.textContent = "\u2705 " + summary + " — ";

      var copySpan = document.createElement("span");
      copySpan.textContent = "\uD83D\uDCCB Copy";
      copySpan.style.cssText = "cursor:pointer;text-decoration:underline;margin-right:10px;";
      copySpan.onclick = async function () {
        var ok = false;
        if (typeof GM_setClipboard === "function") {
          GM_setClipboard(text, "text"); ok = true;
        } else {
          try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
            console.warn("[Transcript Capture] Clipboard write failed:", e.message);
          }
        }
        // Remove child spans before setting text
        while (btn.firstChild) btn.removeChild(btn.firstChild);
        btn.textContent = ok ? "\u2705 Copied!" : "\u2705 Check console";
        setTimeout(function () { resetBtn(btn); }, 2000);
      };

      var saveSpan = document.createElement("span");
      saveSpan.textContent = "\uD83D\uDCBE Save";
      saveSpan.style.cssText = "cursor:pointer;text-decoration:underline;";
      saveSpan.onclick = function () {
        saveTextAsFile(text, filename);
        while (btn.firstChild) btn.removeChild(btn.firstChild);
        btn.textContent = "\u2705 Saved as " + filename;
        setTimeout(function () { resetBtn(btn); }, 3000);
      };

      btn.appendChild(copySpan);
      btn.appendChild(saveSpan);

      // Auto-reset after 15s if no action taken
      setTimeout(function () {
        if (btn.disabled) resetBtn(btn);
      }, 15000);

    } catch (err) {
      console.error("[Transcript Capture] Error:", err);

      if (typeof GM_notification === "function") {
        GM_notification({
          text: err.message,
          title: "Transcript Capture Error",
          timeout: 5000,
        });
      }

      while (btn.firstChild) btn.removeChild(btn.firstChild);
      btn.textContent = "\u274C Error";
      btn.style.background = "rgba(180,30,30,0.9)";
      setTimeout(function () { resetBtn(btn); }, 3000);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Kick off — watch for the transcript panel to appear
  // ---------------------------------------------------------------------------

  waitForTranscriptPanel();
})();
