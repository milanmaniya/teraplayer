// lib/resolver.js - Core TeraBox & TeraViralHub Resolver Engine

const USER_AGENT_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
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

function extractShareState(html) {
  if (!html) return null;
  const marker = 'window.__INITIAL_STATE__';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eqIdx = html.indexOf('=', start);
  if (eqIdx === -1) return null;

  const scriptEnd = html.indexOf('</script>', eqIdx);
  const braceSemi = html.indexOf('};', eqIdx);

  const candidates = [];
  if (scriptEnd !== -1) {
    let s = html.substring(eqIdx + 1, scriptEnd).trim();
    if (s.endsWith(';')) s = s.slice(0, -1).trim();
    candidates.push(s);
  }
  if (braceSemi !== -1) {
    candidates.push(html.substring(eqIdx + 1, braceSemi + 1).trim());
  }

  for (const c of candidates) {
    try {
      const data = JSON.parse(c);
      const share = data.pinia?.share?.shareInfo || data.share?.shareInfo;
      if (share && (share.shareid || share.fileInfo?.server_filename)) {
        return share;
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Fetches share metadata from TeraBox for a given surl across all endpoints and mirrors.
 */
async function fetchShareInfo(surl) {
  const codes = [
    surl.startsWith('1') ? surl.slice(1) : surl,
    surl.startsWith('1') ? surl : `1${surl}`
  ];

  const candidateHosts = [
    'www.1024tera.com',
    TERABOX_HOST,
    'dm.1024terabox.com',
    'www.1024terabox.com',
    'www.terabox.app',
    'www.momerybox.com',
    'freeterabox.com'
  ];
  const uniqueHosts = [...new Set(candidateHosts.filter(Boolean))];

  let lastError = null;

  for (const targetSurl of codes) {
    for (const host of uniqueHosts) {
      // 1. Try Desktop sharing link
      try {
        const desktopUrl = `https://${host}/sharing/link?surl=${targetSurl}`;
        const res = await fetch(desktopUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cookie': buildCookieHeader()
          },
          redirect: 'follow'
        });

        if (res.ok) {
          const html = await res.text();
          const share = extractShareState(html);
          if (share && (share.shareid || share.fileInfo?.server_filename)) {
            return share;
          }
        }
      } catch (e) {
        lastError = e;
      }

      // 2. Try Mobile WAP endpoint
      try {
        const wapUrl = `https://${host}/wap/share/filelist?surl=${targetSurl}`;
        const res = await fetch(wapUrl, {
          headers: {
            'User-Agent': USER_AGENT_MOBILE,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cookie': buildCookieHeader()
          },
          redirect: 'follow'
        });

        if (res.ok) {
          const html = await res.text();
          const share = extractShareState(html);
          if (share && (share.shareid || share.fileInfo?.server_filename)) {
            return share;
          }
        }
      } catch (e) {
        lastError = e;
      }
    }
  }

  throw lastError || new Error('Failed to parse TeraBox session metadata');
}

/**
 * Lists files if the share target is a folder with fallback across domains.
 */
async function listFolderFiles(share) {
  const dir = share.fileInfo.path;
  const domains = ['www.1024tera.com', TERABOX_HOST, 'www.1024terabox.com'];

  for (const domain of domains) {
    try {
      const listUrl = `https://${domain}/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&order=asc&desc=0&dir=${encodeURIComponent(dir)}&num=100&page=1&shorturl=${share.surl}&root=0`;

      const res = await fetch(listUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': `https://${domain}/sharing/link?surl=${share.surl}`,
          'Cookie': buildCookieHeader(share.randsk)
        }
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (data.errno === 0 && Array.isArray(data.list)) {
        return data.list.map(f => {
          const sizeBytes = parseInt(f.size || 0, 10);
          const isDir = String(f.isdir) === '1';
          const isVideo = !isDir && (String(f.category) === '1' || /\.(mp4|mkv|mov|avi|flv|webm|m4v)$/i.test(f.server_filename));
          return {
            fs_id: f.fs_id,
            filename: f.server_filename,
            size_bytes: sizeBytes,
            size_formatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
            isdir: f.isdir,
            category: f.category,
            isVideo
          };
        });
      }
    } catch (e) {
      // Continue to next domain fallback
    }
  }

  return [];
}

/**
 * Retrieves the HLS M3U8 streaming playlist for a specific file.
 */
async function getStreamingM3U8(share, fid, hostUrl) {
  const streamHosts = [
    TERABOX_HOST,
    'dm.1024terabox.com',
    'www.1024tera.com',
    'www.1024terabox.com'
  ];

  let res = null;
  for (const h of [...new Set(streamHosts.filter(Boolean))]) {
    try {
      const streamUrl = `https://${h}/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${share.shareid}&uk=${share.uk}&sign=${share.sign}&timestamp=${share.timestamp}&fid=${fid}&type=M3U8_AUTO_480`;
      const sRes = await fetch(streamUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': `https://${h}/sharing/link?surl=${share.surl}`,
          'Cookie': buildCookieHeader(share.randsk)
        }
      });
      if (sRes.ok) {
        const text = await sRes.text();
        if (text.includes('#EXTM3U')) {
          res = text;
          break;
        }
      }
    } catch (e) {}
  }

  if (!res) {
    throw new Error('Streaming not available for this file');
  }

  const lines = res.split('\n');
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
