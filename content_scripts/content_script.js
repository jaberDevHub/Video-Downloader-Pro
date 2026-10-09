/**
 * OmniStream - Content Script
 * Scans page DOM, catches media player events, extracts high-res thumbnails,
 * and notifies the background service worker.
 */

(function () {
  "use strict";

  // Prevent duplicate execution within the same frame context
  if (window.__omniStreamLoaded) return;
  window.__omniStreamLoaded = true;

  const MEDIA_EXTENSIONS = new Set([
    "mp4", "webm", "m3u8", "mpd", "m4v", "mkv", "ts", "mov", "flv", "avi",
    "wmv", "mpg", "mpeg", "3gp", "ogv", "mp3", "m4a", "aac", "wav", "ogg", "flac"
  ]);

  const seenUrls = new Set();
  let debounceTimer = null;

  function sanitizeTitle(str) {
    if (!str || typeof str !== "string") return document.title || "Video";
    return str
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || document.title || "Video";
  }

  function getExtension(url) {
    try {
      const pathname = new URL(url, window.location.href).pathname.toLowerCase();
      const match = pathname.match(/\.([a-z0-9]+)(?:[\?#]|$)/);
      if (match && MEDIA_EXTENSIONS.has(match[1])) {
        return match[1];
      }
      if (url.includes(".m3u8") || url.includes("application/x-mpegURL")) return "m3u8";
      if (url.includes(".mpd") || url.includes("application/dash+xml")) return "mpd";
      return "mp4";
    } catch {
      return "mp4";
    }
  }

  function isLikelyMediaUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("data:") || url.startsWith("javascript:")) return false;
    const lower = url.toLowerCase();
    for (const ext of MEDIA_EXTENSIONS) {
      if (lower.includes(`.${ext}`)) return true;
    }
    if (lower.includes("blob:http") || lower.includes("m3u8") || lower.includes("mpd")) {
      return true;
    }
    return false;
  }

  // --- Smart Thumbnail Extraction ---
  function getPageThumbnail() {
    // 1. OpenGraph & Twitter tags
    const metaSelectors = [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image:src"]',
      'meta[name="twitter:image"]',
      'meta[itemprop="image"]'
    ];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      const content = el?.getAttribute("content");
      if (content && (content.startsWith("http") || content.startsWith("//"))) {
        return content.startsWith("//") ? window.location.protocol + content : content;
      }
    }

    // 2. Video poster
    const videoWithPoster = document.querySelector("video[poster]");
    if (videoWithPoster) {
      const poster = videoWithPoster.getAttribute("poster");
      if (poster) {
        try { return new URL(poster, window.location.href).href; } catch {}
      }
    }

    // 3. JSON-LD Schema
    const ldJsonTags = document.querySelectorAll('script[type="application/ld+json"]');
    for (const tag of ldJsonTags) {
      try {
        const data = JSON.parse(tag.textContent || "");
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const thumb = item.thumbnailUrl || (typeof item.image === "string" ? item.image : item.image?.url);
          if (thumb && typeof thumb === "string") return thumb;
        }
      } catch {}
    }

    // 4. Prominent image fallback
    const images = document.querySelectorAll("img[src]");
    let best = null;
    let maxArea = 0;
    for (const img of images) {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const area = w * h;
      if (area > 15000 && area > maxArea) {
        maxArea = area;
        try { best = new URL(src, window.location.href).href; } catch {}
      }
    }

    return best || null;
  }

  function isVideoActive(el) {
    if (!(el instanceof HTMLVideoElement)) return false;
    if (!el.paused && el.currentTime > 0 && !el.ended) return true;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const center = vh / 2;
    return rect.top <= center && rect.bottom >= center;
  }

  function getMediaTitle(element) {
    // 1. TikTok specific extractor (captures @creator and caption)
    if (window.location.hostname.includes("tiktok.com") && element) {
      try {
        const container = element.closest('[data-e2e*="item"], div[class*="DivItemContainer"], div[class*="DivVideoFeed"], article') || document;
        const authorEl = container.querySelector('[data-e2e="video-author-uniqueid"], [data-e2e="user-title"], a[href*="/@"]');
        let author = authorEl?.textContent?.trim() || "";
        if (author && !author.startsWith("@")) author = `@${author}`;

        const descEl = container.querySelector('[data-e2e="video-desc"], [data-e2e="browse-video-desc"], div[class*="DivTextContentContainer"]');
        let desc = descEl?.textContent?.trim() || "";
        if (desc.length > 55) desc = desc.substring(0, 55) + "...";

        if (author || desc) {
          return sanitizeTitle(`${author}${author && desc ? ' - ' : ''}${desc}`);
        }
      } catch {}
    }

    // 2. Standard metadata
    if (element) {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) return sanitizeTitle(ariaLabel);
      const titleAttr = element.getAttribute("title");
      if (titleAttr) return sanitizeTitle(titleAttr);
      const closestHeading = element.closest("article, section, .video-container, .player")?.querySelector("h1, h2, h3");
      if (closestHeading?.textContent?.trim()) {
        return sanitizeTitle(closestHeading.textContent.trim());
      }
    }
    const h1 = document.querySelector("h1");
    if (h1?.textContent?.trim()) {
      return sanitizeTitle(h1.textContent.trim());
    }
    return sanitizeTitle(document.title);
  }

  // --- Scan DOM ---
  function scanPageMedia() {
    const found = [];
    const pageThumb = getPageThumbnail();

    // 1. Video & Audio Elements
    const mediaElements = document.querySelectorAll("video, audio");
    mediaElements.forEach((mediaEl) => {
      const srcList = [];
      const directSrc = mediaEl.currentSrc || mediaEl.getAttribute("src");
      if (directSrc) srcList.push(directSrc);

      mediaEl.querySelectorAll("source").forEach((source) => {
        const s = source.getAttribute("src");
        if (s) srcList.push(s);
      });

      const isActive = isVideoActive(mediaEl);

      srcList.forEach((rawUrl) => {
        try {
          const absoluteUrl = new URL(rawUrl, window.location.href).href;
          if (!seenUrls.has(absoluteUrl) && isLikelyMediaUrl(absoluteUrl)) {
            seenUrls.add(absoluteUrl);

            const width = mediaEl.videoWidth || (mediaEl.width ? parseInt(mediaEl.width) : null);
            const height = mediaEl.videoHeight || (mediaEl.height ? parseInt(mediaEl.height) : null);
            const duration = Number.isFinite(mediaEl.duration) ? mediaEl.duration : null;
            const poster = mediaEl.getAttribute("poster") || pageThumb;

            found.push({
              url: absoluteUrl,
              title: getMediaTitle(mediaEl),
              extension: getExtension(absoluteUrl),
              thumbnail: poster,
              width: width,
              height: height,
              duration: duration,
              sourceType: mediaEl.tagName.toLowerCase(),
              pageUrl: window.location.href,
              isActive: isActive,
              detectedAt: Date.now()
            });
          }
        } catch {}
      });
    });

    // 2. Anchors pointing directly to media
    const links = document.querySelectorAll("a[href]");
    links.forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      try {
        const absoluteUrl = new URL(href, window.location.href).href;
        if (!seenUrls.has(absoluteUrl) && isLikelyMediaUrl(absoluteUrl)) {
          seenUrls.add(absoluteUrl);
          found.push({
            url: absoluteUrl,
            title: sanitizeTitle(a.textContent?.trim() || a.getAttribute("title") || document.title),
            extension: getExtension(absoluteUrl),
            thumbnail: pageThumb,
            width: null,
            height: null,
            duration: null,
            sourceType: "link",
            pageUrl: window.location.href,
            detectedAt: Date.now()
          });
        }
      } catch {}
    });

    if (found.length > 0) {
      sendMediaToBackground(found);
    }
  }

  function sendMediaToBackground(mediaList) {
    try {
      chrome.runtime.sendMessage({
        type: "MEDIA_DISCOVERED",
        media: mediaList
      }, () => {
        if (chrome.runtime.lastError) {
          // Context might be refreshing
        }
      });
    } catch {}
  }

  // --- Real-time Video Event Interception ---
  // Captures videos loaded dynamically through JS players (Video.js, Plyr, custom HTML5 players)
  function attachMediaListeners() {
    const handleMediaPlay = (event) => {
      const target = event.target;
      if (target instanceof HTMLVideoElement || target instanceof HTMLAudioElement) {
        const src = target.currentSrc || target.src;
        if (src && !seenUrls.has(src) && isLikelyMediaUrl(src)) {
          seenUrls.add(src);
          const item = {
            url: src,
            title: getMediaTitle(target),
            extension: getExtension(src),
            thumbnail: target.getAttribute("poster") || getPageThumbnail(),
            width: target.videoWidth || null,
            height: target.videoHeight || null,
            duration: Number.isFinite(target.duration) ? target.duration : null,
            sourceType: target.tagName.toLowerCase(),
            pageUrl: window.location.href,
            isActive: true,
            detectedAt: Date.now()
          };
          sendMediaToBackground([item]);

          // Notify background of active stream
          chrome.runtime.sendMessage({
            type: "SET_ACTIVE_VIDEO",
            url: src,
            title: item.title,
            thumbnail: item.thumbnail
          }, () => { chrome.runtime.lastError; });
        }
      }
    };

    window.addEventListener("play", handleMediaPlay, true);
    window.addEventListener("playing", handleMediaPlay, true);
    window.addEventListener("loadedmetadata", handleMediaPlay, true);
  }

  // --- SPA Dynamic Mutation Observer ---
  function observeMutations() {
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        scanPageMedia();
      }, 350);
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }

  // Initialize
  function init() {
    scanPageMedia();
    attachMediaListeners();
    observeMutations();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // In-page Blob Downloader (bypasses CDN hotlink blocks like TikTok/Instagram)
  async function downloadViaPageBlob(url, filename) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename || "video.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Re-scan & In-page download message listener
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "TRIGGER_DOM_SCAN") {
      scanPageMedia();
      sendResponse({ status: "scanned" });
      return true;
    }
    if (msg?.type === "DOWNLOAD_VIA_PAGE") {
      downloadViaPageBlob(msg.url, msg.filename).then(sendResponse);
      return true;
    }
  });
})();

