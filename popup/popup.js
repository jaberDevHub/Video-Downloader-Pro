/**
 * OmniStream - Popup Logic
 * Handles real-time search, quality filtering, preview modal,
 * and seamless one-click downloads.
 */

document.addEventListener("DOMContentLoaded", async () => {
  let activeTabId = null;
  let allMedia = [];
  let currentFilter = "all";

  // Elements
  const mediaListEl = document.getElementById("mediaList");
  const emptyStateEl = document.getElementById("emptyState");
  const detectedCountEl = document.getElementById("detectedCount");
  const searchInput = document.getElementById("searchInput");
  const rescanBtn = document.getElementById("rescanBtn");
  const clearBtn = document.getElementById("clearBtn");
  const deepScanBtn = document.getElementById("deepScanBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const allCountEl = document.getElementById("allCount");
  const filterTabs = document.querySelectorAll(".filter-tab");

  // Modal elements
  const previewModal = document.getElementById("previewModal");
  const previewVideo = document.getElementById("previewVideo");
  const previewTitle = document.getElementById("previewTitle");
  const closeModalBtn = document.getElementById("closeModalBtn");

  // 1. Get active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      activeTabId = tab.id;
    }
  } catch (e) {
    console.error("Tab query failed:", e);
  }

  // 2. Load tab media from background
  async function loadMedia() {
    if (!activeTabId) return;

    chrome.runtime.sendMessage({
      type: "GET_TAB_MEDIA",
      tabId: activeTabId
    }, (response) => {
      if (response && Array.isArray(response.media)) {
        allMedia = response.media;
        renderList();
      }
    });
  }

  // Helper: format duration in mm:ss
  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  // Render media cards
  function renderList() {
    const query = searchInput.value.toLowerCase().trim();

    // Sort active video to the very top
    allMedia.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));

    const filtered = allMedia.filter((item) => {
      // Search filter
      const matchesQuery = !query ||
        item.title.toLowerCase().includes(query) ||
        item.extension.toLowerCase().includes(query) ||
        (item.quality && item.quality.toLowerCase().includes(query));

      if (!matchesQuery) return false;

      // Category tab filter
      if (currentFilter === "playing") {
        const hasActive = allMedia.some(m => m.isActive);
        return hasActive ? !!item.isActive : true;
      }
      if (currentFilter === "video") {
        return !["mp3", "m4a", "aac", "wav", "ogg", "flac"].includes(item.extension);
      }
      if (currentFilter === "audio") {
        return ["mp3", "m4a", "aac", "wav", "ogg", "flac"].includes(item.extension);
      }
      return true;
    });

    detectedCountEl.textContent = allMedia.length;
    allCountEl.textContent = allMedia.length;

    if (allMedia.length > 1) {
      downloadAllBtn.classList.remove("hidden");
    } else {
      downloadAllBtn.classList.add("hidden");
    }

    if (filtered.length === 0) {
      mediaListEl.innerHTML = "";
      emptyStateEl.classList.remove("hidden");
      return;
    }

    emptyStateEl.classList.add("hidden");
    mediaListEl.innerHTML = "";

    filtered.forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = `media-card ${item.isActive ? "is-active-card" : ""}`;

      // Display title: robust fallback if generic, empty, or whitespace
      let rawTitle = (item.title || "").trim();
      let displayTitle = rawTitle;
      if (!displayTitle || displayTitle.toLowerCase() === "video" || displayTitle.toLowerCase() === "video stream") {
        displayTitle = filtered.length > 1 ? `Media Stream #${idx + 1}` : "Media Stream";
      }

      // Thumbnail
      const thumbHtml = item.thumbnail
        ? `<img src="${item.thumbnail}" alt="preview" onerror="this.parentElement.innerHTML='<div class=\\'media-thumb-placeholder\\'>▶</div>'" />`
        : `<div class="media-thumb-placeholder">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
               <polygon points="5 3 19 12 5 21 5 3"></polygon>
             </svg>
           </div>`;

      // Meta tags
      const activeTag = item.isActive ? `<span class="badge badge-active">🟢 PLAYING NOW</span>` : "";
      const formatTag = item.extension.toUpperCase();
      const qualityTag = item.quality ? `<span class="badge badge-quality">${item.quality}</span>` : "";
      const sizeTag = item.sizeFormatted ? `<span class="badge badge-size">${item.sizeFormatted}</span>` : "";
      const durTag = item.duration ? `<span class="media-duration">${formatDuration(item.duration)}</span>` : "";

      card.innerHTML = `
        <div class="media-thumb" data-url="${encodeURIComponent(item.url)}" data-title="${encodeURIComponent(displayTitle)}">
          ${thumbHtml}
          <div class="media-thumb-play-overlay">
            <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        </div>
        <div class="media-info">
          <span class="media-title" title="${displayTitle}">${displayTitle}</span>
          <div class="media-meta-row">
            ${activeTag}
            <span class="badge badge-format">${formatTag}</span>
            ${qualityTag}
            ${sizeTag}
            ${durTag}
          </div>
        </div>
        <div class="media-actions">
          <button class="btn-copy" title="Copy video URL" data-url="${encodeURIComponent(item.url)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="btn-download" data-id="${item.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>Save</span>
          </button>
        </div>
      `;

      // Event: Download
      const dlBtn = card.querySelector(".btn-download");
      dlBtn.addEventListener("click", () => {
        dlBtn.classList.add("loading");
        dlBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
            <path d="M12 2a10 10 0 0 1 10 10"></path>
          </svg>
          <span>Saving...</span>
        `;

        chrome.runtime.sendMessage({
          type: "TRIGGER_DOWNLOAD",
          item: item,
          tabId: activeTabId
        }, (res) => {
          dlBtn.classList.remove("loading");
          if (res?.ok) {
            dlBtn.style.background = "linear-gradient(135deg, #10b981 0%, #059669 100%)";
            dlBtn.innerHTML = `
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>Saved!</span>
            `;
            setTimeout(() => {
              dlBtn.style.background = "";
              dlBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>Save</span>
              `;
            }, 3000);
          } else {
            alert(`Download failed: ${res?.error || "Unknown error"}`);
          }
        });
      });

      // Event: Copy URL
      const copyBtn = card.querySelector(".btn-copy");
      copyBtn.addEventListener("click", () => {
        const rawUrl = decodeURIComponent(copyBtn.getAttribute("data-url"));
        navigator.clipboard.writeText(rawUrl).then(() => {
          copyBtn.style.borderColor = "#10b981";
          copyBtn.style.color = "#10b981";
          setTimeout(() => {
            copyBtn.style.borderColor = "";
            copyBtn.style.color = "";
          }, 1500);
        });
      });

      // Event: Preview
      const thumb = card.querySelector(".media-thumb");
      thumb.addEventListener("click", () => {
        const rawUrl = decodeURIComponent(thumb.getAttribute("data-url"));
        const rawTitle = decodeURIComponent(thumb.getAttribute("data-title"));
        openPreview(rawUrl, rawTitle);
      });

      mediaListEl.appendChild(card);
    });
  }

  // Open Preview Modal
  function openPreview(url, title) {
    previewTitle.textContent = title || "Video Preview";
    previewVideo.src = url;
    previewModal.classList.remove("hidden");
    previewVideo.play().catch(() => {});
  }

  // Close Preview Modal
  function closePreview() {
    previewVideo.pause();
    previewVideo.src = "";
    previewModal.classList.add("hidden");
  }

  closeModalBtn.addEventListener("click", closePreview);
  previewModal.addEventListener("click", (e) => {
    if (e.target === previewModal) closePreview();
  });

  // Re-scan handler
  const triggerScan = () => {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { type: "TRIGGER_DOM_SCAN" }, () => {
      chrome.runtime.lastError;
      setTimeout(loadMedia, 400);
    });
  };

  rescanBtn.addEventListener("click", triggerScan);
  deepScanBtn.addEventListener("click", triggerScan);

  // Clear handler
  clearBtn.addEventListener("click", () => {
    if (!activeTabId) return;
    chrome.runtime.sendMessage({
      type: "CLEAR_TAB_MEDIA",
      tabId: activeTabId
    }, () => {
      allMedia = [];
      renderList();
    });
  });

  // Download All handler
  downloadAllBtn.addEventListener("click", () => {
    allMedia.forEach((item, idx) => {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: "TRIGGER_DOWNLOAD",
          item: item,
          tabId: activeTabId
        });
      }, idx * 600);
    });
  });

  // Filter tabs
  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      filterTabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentFilter = tab.getAttribute("data-filter");
      renderList();
    });
  });

  // Search input
  searchInput.addEventListener("input", renderList);

  // Initial load
  await loadMedia();
});
