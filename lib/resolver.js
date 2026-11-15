// lib/resolver.js - Core TeraBox & TeraViralHub Resolver Engine

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The primary TeraBox domain matching the user's login session
const TERABOX_HOST = process.env.TERABOX_HOST || 'dm.1024terabox.com';

/**
 * Extracts the 21-25 character TeraBox surl from either TeraViralHub or standard TeraBox links.
 */
async function resolveToSurl(inputUrl) {
  const cleanUrl = inputUrl.trim();

  // 1. Check if it's a TeraViralHub URL
  if (cleanUrl.includes('teraviralhub.com')) {
    const res = await fetch(cleanUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch TeraViralHub page (${res.status})`);
    }
    const html = await res.text();

    const match = html.match(/thumbnails\/([A-Za-z0-9_-]{21,25})_/);
    if (!match) {
      throw new Error('Could not find underlying TeraBox link in TeraViralHub page');
    }
    return match[1];
  }

  // 2. Check if it's a direct TeraBox URL
  const surlParamMatch = cleanUrl.match(/[?&]surl=([A-Za-z0-9_-]+)/);
  if (surlParamMatch) {
    return surlParamMatch[1];
  }

  const slashSMatch = cleanUrl.match(/\/s\/(?:1)?([A-Za-z0-9_-]+)/);
  if (slashSMatch) {
    return slashSMatch[1];
  }

  // Fallback: If raw code was passed
  if (/^[A-Za-z0-9_-]{20,25}$/.test(cleanUrl)) {
    return cleanUrl.startsWith('1') ? cleanUrl.slice(1) : cleanUrl;
  }

  throw new Error('Unsupported URL format. Please provide a TeraBox or TeraViralHub link.');
}

/**
 * Builds cookie header with authenticated ndus token.
 */
function buildCookieHeader(randsk, ndus = process.env.TERABOX_NDUS) {
  const parts = [];
  if (ndus) {
    const cleanNdus = ndus.replace(/^ndus=/, '').trim();
    parts.push(`ndus=${cleanNdus}`);
  }
  if (randsk) {
    parts.push(`randsk=${randsk}`);
  }
  parts.push('lang=en');
  return parts.join('; ');
}

function extractInitialState(html) {
  if (!html) return null;
  const marker = 'window.__INITIAL_STATE__';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eqIdx = html.indexOf('=', start);
  if (eqIdx === -1) return null;
  const scriptEnd = html.indexOf('</script>', eqIdx);
  if (scriptEnd === -1) return null;

  let jsonStr = html.substring(eqIdx + 1, scriptEnd).trim();
  if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1).trim();

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/**
 * Fetches share metadata from TeraBox for a given surl with fallback domains.
 */
async function fetchShareInfo(surl) {
  const targetSurl = surl.startsWith('1') ? surl.slice(1) : surl;
  const candidateHosts = [TERABOX_HOST, 'www.1024tera.com', 'dm.1024terabox.com', 'www.1024terabox.com', 'www.terabox.app'];
  const uniqueHosts = [...new Set(candidateHosts.filter(Boolean))];

  let lastError = null;

  for (const host of uniqueHosts) {
    try {
      const shareUrl = `https://${host}/sharing/link?surl=${targetSurl}`;
      const res = await fetch(shareUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': buildCookieHeader()
        },
        redirect: 'follow'
      });

      if (!res.ok) {
        lastError = new Error(`Host ${host} returned HTTP ${res.status}`);
        continue;
      }

      const html = await res.text();
      const data = extractInitialState(html);
      const share = data?.pinia?.share?.shareInfo;
      if (share && share.shareid) {
        return share;
      }
      lastError = new Error(`Metadata missing on ${host}`);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('Failed to parse TeraBox session metadata');
}

/**
 * Lists files if the share target is a folder with fallback across domains.
 */
async function listFolderFiles(share) {
  const dir = share.fileInfo.path;
  const domains = [TERABOX_HOST, 'www.1024tera.com', 'www.1024terabox.com'];

  for (const domain of domains) {
    try {
      const listUrl = `https://${domain}/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&order=asc&desc=0&dir=${encodeURIComponent(dir)}&num=100&page=1&shorturl=${share.surl}&root=0`;

      const res = await fetch(listUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': `https://${domain}/sharing/link?surl=${share.surl}`,
          'Cookie': buildCookieHeader(share.randsk),
          'Accept': 'application/json, text/plain, */*'
        }
      });

      const json = await res.json();
      if (json.errno === 0 && Array.isArray(json.list) && json.list.length > 0) {
        return json.list;
      }
    } catch (e) {
      console.warn(`Folder list on ${domain} failed, trying next domain...`);
    }
  }

  return [];
}

/**
 * Generates an HLS M3U8 playlist with segment URLs rewritten to stream through our proxy.
 */
async function getStreamingM3U8(share, fid, hostUrl, quality = 'M3U8_AUTO_480') {
  const streamUrl = `https://${TERABOX_HOST}/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${share.shareid}&uk=${share.uk}&sign=${share.sign}&timestamp=${share.timestamp}&fid=${fid}&type=${quality}`;

  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': `https://${TERABOX_HOST}/sharing/link?surl=${share.surl}`,
      'Cookie': buildCookieHeader(share.randsk)
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch streaming playlist (${res.status})`);
  }

  const rawM3u8 = await res.text();
  if (!rawM3u8.includes('#EXTM3U')) {
    throw new Error('Streaming not available for this file');
  }

  const lines = rawM3u8.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return `${hostUrl}/api/segment?url=${encodeURIComponent(trimmed)}`;
    }
    return line;
  });

  const segmentCount = lines.filter(l => l.startsWith('#EXTINF:')).length;

  return {
    playlist: rewritten.join('\n'),
    segmentCount,
    isFullDuration: segmentCount > 5
  };
}

module.exports = {
  USER_AGENT,
  TERABOX_HOST,
  resolveToSurl,
  fetchShareInfo,
  listFolderFiles,
  getStreamingM3U8
};
