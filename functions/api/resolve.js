// functions/api/resolve.js - Cloudflare Pages Function for /api/resolve

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_NDUS = 'YbbOLXupeHuiW6-qutQMS9aDgf9xNC5JDZDRR-Cu';
const DEFAULT_HOST = 'dm.1024terabox.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range'
};

function getNdus(env) {
  return env.TERABOX_NDUS || env.ndus || env.NDUS || DEFAULT_NDUS;
}

function getHost(env) {
  return env.TERABOX_HOST || env.host || env.HOST || DEFAULT_HOST;
}

function buildCookieHeader(randsk, ndus) {
  const parts = [];
  if (ndus) {
    const clean = ndus.replace(/^ndus=/, '').trim();
    parts.push(`ndus=${clean}`);
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

async function fetchShareInfoWithFallback(surl, env) {
  const targetSurl = surl.startsWith('1') ? surl.slice(1) : surl;
  const ndus = getNdus(env);
  const primaryHost = getHost(env);

  const candidateHosts = [primaryHost, 'www.1024tera.com', 'dm.1024terabox.com', 'www.1024terabox.com', 'www.terabox.app'];
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
          'Cookie': buildCookieHeader(null, ndus)
        },
        redirect: 'follow'
      });

      if (!res.ok) {
        lastError = new Error(`Host ${host} HTTP ${res.status}`);
        continue;
      }

      const html = await res.text();
      const data = extractInitialState(html);
      const share = data?.pinia?.share?.shareInfo;
      if (share && share.shareid) {
        return { share, activeHost: host };
      }
      lastError = new Error(`Metadata missing on ${host}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to parse TeraBox metadata from all mirror hosts');
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    let rawUrl = '';
    const reqUrl = new URL(request.url);

    if (request.method === 'POST') {
      try {
        const body = await request.json();
        rawUrl = body.url;
      } catch (e) {
        rawUrl = reqUrl.searchParams.get('url');
      }
    } else {
      rawUrl = reqUrl.searchParams.get('url');
    }

    if (!rawUrl) {
      return new Response(JSON.stringify({ success: false, error: 'URL is required' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const cleanUrl = rawUrl.trim();
    let surl = '';

    if (cleanUrl.includes('teraviralhub.com')) {
      const tvhRes = await fetch(cleanUrl, { headers: { 'User-Agent': USER_AGENT } });
      const html = await tvhRes.text();
      const match = html.match(/thumbnails\/([A-Za-z0-9_-]{21,25})_/);
      if (!match) throw new Error('Could not find TeraBox link in TeraViralHub');
      surl = match[1];
    } else {
      const pMatch = cleanUrl.match(/[?&]surl=([A-Za-z0-9_-]+)/);
      const sMatch = cleanUrl.match(/\/s\/(?:1)?([A-Za-z0-9_-]+)/);
      surl = pMatch ? pMatch[1] : (sMatch ? sMatch[1] : cleanUrl);
    }

    const ndus = getNdus(env);
    const { share, activeHost } = await fetchShareInfoWithFallback(surl, env);

    let files = [];
    let primaryFile = null;

    if (String(share.fileInfo.isdir) === '1') {
      const domains = ['www.1024tera.com', activeHost, 'www.1024terabox.com'];
      for (const d of domains) {
        try {
          const listUrl = `https://${d}/share/list?app_id=250528&web=1&channel=dubox&clienttype=0&order=asc&desc=0&dir=${encodeURIComponent(share.fileInfo.path)}&num=100&page=1&shorturl=${share.surl}&root=0`;
          const lRes = await fetch(listUrl, {
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': `https://${d}/sharing/link?surl=${share.surl}`,
              'Cookie': buildCookieHeader(share.randsk, ndus)
            }
          });
          const lJson = await lRes.json();
          if (lJson.errno === 0 && Array.isArray(lJson.list)) {
            files = lJson.list.map(f => {
              const sizeBytes = parseInt(f.size || 0, 10);
              const isDir = String(f.isdir) === '1';
              const isVideo = !isDir && (String(f.category) === '1' || /\.(mp4|mkv|mov|avi|flv|webm|m4v)$/i.test(f.server_filename));
              return {
                fs_id: f.fs_id,
                filename: f.server_filename,
                size_bytes: sizeBytes,
                size_formatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
                isVideo
              };
            });
            break;
          }
        } catch (e) {}
      }

      const videoFiles = files.filter(f => f.isVideo);
      primaryFile = videoFiles.length > 0 ? videoFiles.sort((a, b) => b.size_bytes - a.size_bytes)[0] : files[0];
    } else {
      const sizeBytes = parseInt(share.fileInfo.size || 0, 10);
      primaryFile = {
        fs_id: share.fileInfo.fs_id,
        filename: share.fileInfo.server_filename,
        size_bytes: sizeBytes,
        size_formatted: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB',
        isVideo: true
      };
      files = [primaryFile];
    }

    if (!primaryFile) {
      throw new Error('No video found in this link');
    }

    const origin = reqUrl.origin;

    return new Response(JSON.stringify({
      success: true,
      surl,
      title: primaryFile.filename,
      size: primaryFile.size_formatted,
      activeFid: primaryFile.fs_id,
      files,
      streamUrl: `${origin}/api/m3u8?surl=${encodeURIComponent(surl)}&fid=${primaryFile.fs_id}`,
      downloadUrl: `${origin}/api/download?surl=${encodeURIComponent(surl)}&fid=${primaryFile.fs_id}`
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message || 'Error resolving video' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
}
