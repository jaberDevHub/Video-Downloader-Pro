/**
 * OmniStream - Background Service Worker
 * Intercepts network media streams, parses HLS/DASH manifests,
 * handles anti-hotlink downloads, and manages tab media inventories.
 */

const MEDIA_TYPES = [
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska",
  "video/x-flv", "video/3gpp", "video/mp2t", "application/x-mpegurl",
  "application/vnd.apple.mpegurl", "application/dash+xml", "audio/mpeg", "audio/mp4",
  "audio/ogg", "audio/wav", "audio/aac", "audio/webm", "audio/flac"
];

const EXT_REGEX = /\.(mp4|webm|m3u8|mpd|m4v|mkv|ts|mov|flv|avi|wmv|mpg|mpeg|3gp|ogv|mp3|m4a|aac|wav|ogg|flac)(?:[\?#]|$)/i;

// In-memory tab registry
const tabMediaStore = new Map();
const tabHeadersStore = new Map();

// Helper: Format bytes into readable string
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return null;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Helper: Extract file extension
function extractExtension(url) {
  const match = url.match(EXT_REGEX);
  if (match) return match[1].toLowerCase();
  if (url.includes("m3u8")) return "m3u8";
  if (url.includes("mpd")) return "mpd";
  return "mp4";
}

// Helper: Format title from URL if missing
function titleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").pop() || "Video";
    return decodeURIComponent(filename.replace(EXT_REGEX, "")).replace(/[-_]/g, " ").trim() || "Video Stream";
  } catch {
    return "Video Stream";
  }
}

// Update Extension Toolbar Badge
async function updateTabBadge(tabId) {
  if (!tabId || tabId < 0) return;
  const items = tabMediaStore.get(tabId) || [];
  const count = items.length;

  try {
    if (count > 0) {
      await chrome.action.setBadgeText({ tabId, text: String(count) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }); // Royal Blue
      await chrome.action.setTitle({ tabId, title: `Video Downloader Pro: ${count} media stream(s) detected` });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({ tabId, title: "Video Downloader Pro - Stream & Media Saver" });
    }
  } catch {}
}

// Add media to tab store
function addMediaItem(tabId, item) {
  if (!tabId || tabId < 0 || !item?.url) return false;

  let list = tabMediaStore.get(tabId);
  if (!list) {
    list = [];
    tabMediaStore.set(tabId, list);
  }

  // If new item is active, mark it and reset others
  if (item.isActive) {
    list.forEach(m => m.isActive = false);
  }

  // Deduplicate by URL
  const existingIndex = list.findIndex(m => m.url === item.url);
  if (existingIndex !== -1) {
    // Merge newer metadata if available
    const existing = list[existingIndex];
    list[existingIndex] = {
      ...existing,
      ...item,
      title: item.title && item.title !== "Video" ? item.title : existing.title,
      thumbnail: item.thumbnail || existing.thumbnail,
      size: item.size || existing.size,
      quality: item.quality || existing.quality,
      isActive: item.isActive !== undefined ? item.isActive : existing.isActive
    };
    return false;
  }

  list.push({
    id: `media_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    url: item.url,
    title: item.title || titleFromUrl(item.url),
    extension: item.extension || extractExtension(item.url),
    thumbnail: item.thumbnail || null,
    size: item.size || null,
    sizeFormatted: item.size ? formatBytes(item.size) : null,
    width: item.width || null,
    height: item.height || null,
    quality: item.quality || (item.height ? `${item.height}p` : null),
    duration: item.duration || null,
    sourceType: item.sourceType || "network",
    isActive: !!item.isActive,
    detectedAt: Date.now()
  });

  updateTabBadge(tabId);
  return true;
}

// Parse HLS master playlist for multiple resolution variants
async function parseHlsManifest(masterUrl, tabId, baseTitle, thumbnail) {
  try {
    const res = await fetch(masterUrl);
    if (!res.ok) return;
    const text = await res.text();

    if (!text.includes("#EXT-X-STREAM-INF")) {
      // Single stream playlist
      addMediaItem(tabId, {
        url: masterUrl,
        title: baseTitle || "HLS Stream",
        extension: "m3u8",
        thumbnail: thumbnail,
        quality: "HLS Stream"
      });
      return;
    }

    const lines = text.split(/\r?\n/);
    let currentInfo = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        currentInfo = {
          bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : null,
          width: resMatch ? parseInt(resMatch[1], 10) : null,
          height: resMatch ? parseInt(resMatch[2], 10) : null
        };
      } else if (currentInfo && line && !line.startsWith("#")) {
        const variantUrl = line.startsWith("http") ? line : new URL(line, masterUrl).href;
        const qualityLabel = currentInfo.height ? `${currentInfo.height}p` : "Adaptive";

        addMediaItem(tabId, {
          url: variantUrl,
          title: `${baseTitle || "Video"} (${qualityLabel})`,
          extension: "m3u8",
          thumbnail: thumbnail,
          width: currentInfo.width,
          height: currentInfo.height,
          quality: qualityLabel,
          masterPlaylistUrl: masterUrl
        });
        currentInfo = null;
      }
    }
  } catch (err) {
    console.debug("[OmniStream] HLS parse skipped:", err);
  }
}

// --- Network Sniffing via WebRequest ---
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.type === "main_frame") return;

    const url = details.url;
    let contentType = "";
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === "content-type") {
          contentType = (h.value || "").toLowerCase();
        } else if (name === "content-length") {
          contentLength = parseInt(h.value || "0", 10);
        }
      }
    }

    // Ignore small fragments or tracking pixels
    if (contentLength > 0 && contentLength < 80000 && !url.includes(".m3u8") && !url.includes(".mpd")) {
      return;
    }

    const isMediaMime = MEDIA_TYPES.some(m => contentType.includes(m));
    const isMediaExt = EXT_REGEX.test(url);
    const isYouTubeStream = url.includes("googlevideo.com/videoplayback");

    if (isYouTubeStream) {
      handleYouTubeStream(details, url, contentType, contentLength);
      return;
    }

    if (isMediaMime || isMediaExt) {
      const ext = extractExtension(url);

      if (ext === "m3u8") {
        parseHlsManifest(url, details.tabId);
      } else {
        addMediaItem(details.tabId, {
          url: url,
          extension: ext,
          size: contentLength > 0 ? contentLength : null,
          sourceType: "network"
        });
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// YouTube-specific stream parser
async function handleYouTubeStream(details, url, contentType, contentLength) {
  try {
    const parsedUrl = new URL(url);
    const itag = parsedUrl.searchParams.get("itag");
    
    // Remove chunk range parameters to download the full media stream
    parsedUrl.searchParams.delete("range");
    parsedUrl.searchParams.delete("rn");
    const fullStreamUrl = parsedUrl.href;

    let qualityLabel = "Stream";
    let isAudio = false;
    let ext = "mp4";

    // Common YouTube itags mapping
    switch (itag) {
      case "18":
        qualityLabel = "360p (Audio+Video)";
        ext = "mp4";
        break;
      case "22":
        qualityLabel = "720p HD (Audio+Video)";
        ext = "mp4";
        break;
      case "137":
        qualityLabel = "1080p FHD (Video only)";
        ext = "mp4";
        break;
      case "136":
        qualityLabel = "720p HD (Video only)";
        ext = "mp4";
        break;
      case "135":
        qualityLabel = "480p (Video only)";
        ext = "mp4";
        break;
      case "134":
        qualityLabel = "360p (Video only)";
        ext = "mp4";
        break;
      case "140":
        qualityLabel = "High Quality Audio";
        isAudio = true;
        ext = "m4a";
        break;
      case "251":
        qualityLabel = "HQ Opus Audio";
        isAudio = true;
        ext = "webm";
        break;
      default:
        if (contentType.includes("audio")) {
          qualityLabel = "Audio Track";
          isAudio = true;
          ext = "m4a";
        } else {
          qualityLabel = "Video Stream";
          ext = "mp4";
        }
    }

    // Attempt to extract YouTube video title from tab
    let videoTitle = "YouTube Video";
    let videoThumbnail = null;
    try {
      const tab = await chrome.tabs.get(details.tabId);
      if (tab?.title) {
        videoTitle = tab.title.replace(/\s*-\s*YouTube$/i, "").trim() || "YouTube Video";
      }
      if (tab?.url) {
        const ytIdMatch = tab.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (ytIdMatch) {
          videoThumbnail = `https://img.youtube.com/vi/${ytIdMatch[1]}/hqdefault.jpg`;
        }
      }
    } catch {}

    addMediaItem(details.tabId, {
      url: fullStreamUrl,
      title: `${videoTitle} (${qualityLabel})`,
      extension: ext,
      quality: qualityLabel,
      thumbnail: videoThumbnail,
      size: contentLength > 100000 ? contentLength : null,
      sourceType: isAudio ? "audio" : "video"
    });
  } catch (err) {
    console.debug("[OmniStream] YouTube parse error:", err);
  }
}

// Capture referer headers to handle anti-hotlinking
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId >= 0 && details.requestHeaders) {
      const referer = details.requestHeaders.find(h => h.name.toLowerCase() === "referer")?.value;
      const origin = details.requestHeaders.find(h => h.name.toLowerCase() === "origin")?.value;
      if (referer || origin) {
        tabHeadersStore.set(details.tabId, { referer, origin });
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// Tab Navigation & Cleanup
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    // Page refreshed or navigated: clear previous tab media
    tabMediaStore.delete(tabId);
    tabHeadersStore.delete(tabId);
    updateTabBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaStore.delete(tabId);
  tabHeadersStore.delete(tabId);
});

// Download Helper with Bulletproof Anti-Hotlinking Rule Injection & Page Fallback
async function triggerDownload(mediaItem, tabId) {
  let referer = "";
  let origin = "";

  // 1. Resolve tab Referer and Origin
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      referer = tab.url;
      origin = new URL(tab.url).origin;
    }
  } catch {}

  const headers = tabHeadersStore.get(tabId);
  if (headers?.referer) referer = headers.referer;
  if (headers?.origin) origin = headers.origin;

  const ruleId = Math.floor(Math.random() * 100000) + 1000;
  let hostPattern = "";
  try {
    hostPattern = new URL(mediaItem.url).hostname;
  } catch {}

  // Clean filename
  const cleanTitle = (mediaItem.title || "video")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const ext = mediaItem.extension || "mp4";
  const filename = `${cleanTitle}.${ext}`;

  try {
    // 2. Inject Referer and Origin for the entire CDN hostname (works for TikTok, Instagram, etc.)
    if (referer && hostPattern) {
      const requestHeaders = [
        { header: "Referer", operation: "set", value: referer },
        { header: "Origin", operation: "set", value: origin || referer }
      ];

      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id: ruleId,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: requestHeaders
          },
          condition: {
            urlFilter: `||${hostPattern}/*`,
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
          }
        }],
        removeRuleIds: [ruleId]
      });
    }

    // 3. Initiate Chrome download
    const downloadId = await chrome.downloads.download({
      url: mediaItem.url,
      filename: `VideoDownloaderPro/${filename}`,
      saveAs: false,
      conflictAction: "uniquify"
    });

    // Clean up temporary DNR rules after 8 seconds
    setTimeout(() => {
      chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId]
      }).catch(() => {});
    }, 8000);

    return { ok: true, downloadId };
  } catch (err) {
    console.warn("[OmniStream] Direct Chrome download failed, falling back to in-page blob download:", err);

    // Fallback: Ask Content Script to fetch and download as local Blob
    try {
      const pageResult = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: "DOWNLOAD_VIA_PAGE",
          url: mediaItem.url,
          filename: filename
        }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            resolve({ ok: false, error: chrome.runtime.lastError?.message || res?.error });
          } else {
            resolve({ ok: true });
          }
        });
      });

      if (pageResult.ok) return { ok: true };
    } catch (fallbackErr) {
      console.error("[OmniStream] In-page fallback failed:", fallbackErr);
    }

    return { ok: false, error: err.message };
  }
}

// Runtime Message Handling from Content Script & Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message.tabId;

  if (message.type === "MEDIA_DISCOVERED") {
    if (Array.isArray(message.media) && tabId) {
      message.media.forEach(item => addMediaItem(tabId, item));
      sendResponse({ status: "recorded" });
    }
    return true;
  }

  if (message.type === "GET_TAB_MEDIA") {
    const list = tabMediaStore.get(tabId) || [];
    sendResponse({ media: list });
    return true;
  }

  if (message.type === "CLEAR_TAB_MEDIA") {
    tabMediaStore.delete(tabId);
    updateTabBadge(tabId);
    sendResponse({ status: "cleared" });
    return true;
  }

  if (message.type === "SET_ACTIVE_VIDEO") {
    if (tabId && message.url) {
      const list = tabMediaStore.get(tabId) || [];
      let found = false;
      list.forEach(m => {
        const matches = (m.url === message.url || message.url.includes(m.url) || m.url.includes(message.url));
        m.isActive = matches;
        if (matches) {
          found = true;
          if (message.title && (!m.title || m.title.toLowerCase().includes("video"))) {
            m.title = message.title;
          }
          if (message.thumbnail) m.thumbnail = message.thumbnail;
        }
      });
      sendResponse({ status: "updated", found });
    }
    return true;
  }

  if (message.type === "TRIGGER_DOWNLOAD") {
    triggerDownload(message.item, tabId).then(sendResponse);
    return true;
  }
});
