// worker.js - Universal Cloudflare Worker & Pages entrypoint

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

/**
 * High performance & bulletproof JSON extractor for window.__INITIAL_STATE__
 * Avoids V8 regex backtracking issues on large 180KB HTML pages.
 */
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
  if (jsonStr.endsWith(';')) {
    jsonStr = jsonStr.slice(0, -1).trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/**
 * Robust share info fetcher with multi-domain fallback
 */
async function fetchShareInfoWithFallback(surl, env) {
  const targetSurl = surl.startsWith('1') ? surl.slice(1) : surl;
  const ndus = getNdus(env);
  const primaryHost = getHost(env);

  const candidateHosts = [
    'www.momerybox.com',
    'www.tibibox.com',
    'freeterabox.com',
    primaryHost,
    'www.1024tera.com',
    'dm.1024terabox.com',
    'www.1024terabox.com',
    'www.terabox.app'
  ];
  const uniqueHosts = [...new Set(candidateHosts.filter(Boolean))];

  const debugAttempts = [];

  for (const host of uniqueHosts) {
    try {
      const shareUrl = `https://${host}/sharing/link?surl=${targetSurl}`;
      // Note: Do NOT send user ndus cookie on the initial public HTML share page,
      // as TeraBox flags datacenter IPs reusing domestic session cookies with 400141 'need verify'.
      const res = await fetch(shareUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        redirect: 'follow'
      });

      const html = await res.text();
      const data = extractInitialState(html);
      const share = data?.pinia?.share?.shareInfo;
      if (share && share.shareid) {
        return { share, activeHost: host };
      }
      debugAttempts.push(`${host}(${res.status}): ${html.trim().slice(0, 100)}`);
    } catch (err) {
      debugAttempts.push(`${host}(err): ${err.message}`);
    }
  }

  throw new Error('All hosts failed: ' + debugAttempts.join(' | '));
}

// 1. Resolve handler (Supports POST and GET)
async function handleResolve(request, env) {
  try {
    let rawUrl = '';
    const reqUrl = new URL(request.url);

    if (request.method === 'POST') {
      try {
        const body = await request.json();
        rawUrl = body.url;
      } catch (e) {
        // Fallback to query param if body was not JSON
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

    // Check TeraViralHub
    if (cleanUrl.includes('teraviralhub.com')) {
      const tvhRes = await fetch(cleanUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!tvhRes.ok) throw new Error(`TeraViralHub returned status ${tvhRes.status}`);
      const html = await tvhRes.text();
      const match = html.match(/thumbnails\/([A-Za-z0-9_-]{21,25})_/);
      if (!match) throw new Error('Could not find TeraBox surl in TeraViralHub thumbnail link');
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
      const folderHosts = ['www.1024tera.com', activeHost, 'www.1024terabox.com'];
      for (const d of folderHosts) {
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
      throw new Error('No video file found in this share');
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
    return new Response(JSON.stringify({
      success: false,
      error: err.message || 'Error resolving video link'
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
}

// 2. M3U8 Playlist Handler
async function handleM3u8(request, env) {
  const url = new URL(request.url);
  const surl = url.searchParams.get('surl');
  const fid = url.searchParams.get('fid');

  if (!surl || !fid) {
    return new Response('surl and fid are required', { status: 400, headers: CORS_HEADERS });
  }

  const ndus = getNdus(env);

  try {
    const { share, activeHost } = await fetchShareInfoWithFallback(surl, env);

    // Call streaming endpoint on the active host or primary host
    const hostsToTry = [activeHost, getHost(env), 'www.momerybox.com', 'freeterabox.com', 'dm.1024terabox.com', 'www.1024tera.com'];
    let rawM3u8 = '';
    let successHost = activeHost;

    for (const h of [...new Set(hostsToTry)]) {
      try {
        const streamUrl = `https://${h}/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${share.shareid}&uk=${share.uk}&sign=${share.sign}&timestamp=${share.timestamp}&fid=${fid}&type=M3U8_AUTO_480`;
        const sRes = await fetch(streamUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': `https://${h}/sharing/link?surl=${share.surl}`,
            'Cookie': buildCookieHeader(share.randsk, ndus)
          }
        });
        const text = await sRes.text();
        if (text.includes('#EXTM3U')) {
          rawM3u8 = text;
          successHost = h;
          break;
        }
      } catch (e) {}
    }

    if (!rawM3u8 || !rawM3u8.includes('#EXTM3U')) {
      return new Response('Streaming not available for this file', { status: 500, headers: CORS_HEADERS });
    }

    const origin = url.origin;
    const lines = rawM3u8.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return `${origin}/api/segment?url=${encodeURIComponent(trimmed)}`;
      }
      return line;
    });

    return new Response(rewritten.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (err) {
    return new Response('M3U8 generation error: ' + err.message, { status: 500, headers: CORS_HEADERS });
  }
}

// 3. Segment Proxy Handler
async function handleSegment(request, env) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response('URL required', { status: 400, headers: CORS_HEADERS });
  }

  const host = getHost(env);
  const headers = {
    'User-Agent': USER_AGENT,
    'Referer': `https://${host}/`
  };

  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  try {
    const segmentRes = await fetch(targetUrl, { headers });
    const responseHeaders = new Headers(segmentRes.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(segmentRes.body, {
      status: segmentRes.status,
      headers: responseHeaders
    });
  } catch (e) {
    return new Response('Error proxying segment: ' + e.message, { status: 502, headers: CORS_HEADERS });
  }
}

// 4. Download Handler
async function handleDownload(request, env) {
  const url = new URL(request.url);
  const surl = url.searchParams.get('surl');
  const fid = url.searchParams.get('fid');

  if (!surl || !fid) return new Response('surl and fid required', { status: 400, headers: CORS_HEADERS });

  const ndus = getNdus(env);

  try {
    const { share, activeHost } = await fetchShareInfoWithFallback(surl, env);

    const streamUrl = `https://${activeHost}/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${share.shareid}&uk=${share.uk}&sign=${share.sign}&timestamp=${share.timestamp}&fid=${fid}&type=M3U8_AUTO_480`;
    const sRes = await fetch(streamUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `https://${activeHost}/sharing/link?surl=${share.surl}`,
        'Cookie': buildCookieHeader(share.randsk, ndus)
      }
    });

    const m3u8 = await sRes.text();
    const lines = m3u8.split('\n').map(l => l.trim()).filter(Boolean);
    const segUrls = lines.filter(l => l.startsWith('http://') || l.startsWith('https://'));

    if (segUrls.length === 0) return new Response('No downloadable stream found', { status: 404, headers: CORS_HEADERS });

    const chunkRes = await fetch(segUrls[0], {
      headers: { 'User-Agent': USER_AGENT, 'Referer': `https://${activeHost}/` }
    });

    return new Response(chunkRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="video_${fid}.mp4"`,
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response('Download error: ' + e.message, { status: 500, headers: CORS_HEADERS });
  }
}

// Main Cloudflare Fetch Router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // API Routing
    if (url.pathname === '/api/resolve') {
      return handleResolve(request, env);
    }
    if (url.pathname === '/api/m3u8') {
      return handleM3u8(request, env);
    }
    if (url.pathname === '/api/segment') {
      return handleSegment(request, env);
    }
    if (url.pathname === '/api/download') {
      return handleDownload(request, env);
    }
    if (url.pathname === '/api/status') {
      const activeNdus = getNdus(env);
      return new Response(JSON.stringify({
        success: true,
        hasNdus: Boolean(activeNdus && activeNdus.length > 5),
        mode: activeNdus ? 'Full HD Mode (Unlimited)' : 'Preview Mode',
        activeHost: getHost(env)
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // Serve Static Assets from public/
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
