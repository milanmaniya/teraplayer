// worker.js - Universal Cloudflare Worker & Pages entrypoint

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function buildCookieHeader(randsk, ndus) {
  const parts = [];
  if (ndus) {
    parts.push(`ndus=${ndus.replace(/^ndus=/, '').trim()}`);
  }
  if (randsk) {
    parts.push(`randsk=${randsk}`);
  }
  parts.push('lang=en');
  return parts.join('; ');
}

// 1. Resolve handler
async function handleResolve(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { url } = await request.json();
    if (!url) {
      return new Response(JSON.stringify({ success: false, error: 'URL required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const cleanUrl = url.trim();
    let surl = '';

    // Check TeraViralHub
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

    const host = env.TERABOX_HOST || 'dm.1024terabox.com';
    const ndus = env.TERABOX_NDUS || '';

    // Fetch share metadata
    const targetSurl = surl.startsWith('1') ? surl.slice(1) : surl;
    const shareUrl = `https://${host}/sharing/link?surl=${targetSurl}`;
    const shareRes = await fetch(shareUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Cookie': buildCookieHeader(null, ndus)
      }
    });

    const html = await shareRes.text();
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});<\/script>/);
    if (!stateMatch) throw new Error('Failed to parse TeraBox session metadata');

    const data = JSON.parse(stateMatch[1]);
    const share = data.pinia?.share?.shareInfo;
    if (!share || !share.shareid) throw new Error('Share information not found or link has expired');

    let files = [];
    let primaryFile = null;

    if (String(share.fileInfo.isdir) === '1') {
      const domains = [host, 'www.1024tera.com', 'www.1024terabox.com'];
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

    const requestUrl = new URL(request.url);
    const origin = requestUrl.origin;

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
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message || 'Error resolving video' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// 2. M3U8 Playlist Handler
async function handleM3u8(request, env) {
  const url = new URL(request.url);
  const surl = url.searchParams.get('surl');
  const fid = url.searchParams.get('fid');

  if (!surl || !fid) {
    return new Response('surl and fid are required', { status: 400 });
  }

  const host = env.TERABOX_HOST || 'dm.1024terabox.com';
  const ndus = env.TERABOX_NDUS || '';

  try {
    const targetSurl = surl.startsWith('1') ? surl.slice(1) : surl;
    const shareUrl = `https://${host}/sharing/link?surl=${targetSurl}`;
    const shareRes = await fetch(shareUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Cookie': buildCookieHeader(null, ndus)
      }
    });

    const html = await shareRes.text();
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});<\/script>/);
    if (!stateMatch) return new Response('Failed to parse share info', { status: 500 });

    const data = JSON.parse(stateMatch[1]);
    const share = data.pinia?.share?.shareInfo;
    if (!share) return new Response('Share not found', { status: 404 });

    const streamUrl = `https://${host}/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${share.shareid}&uk=${share.uk}&sign=${share.sign}&timestamp=${share.timestamp}&fid=${fid}&type=M3U8_AUTO_480`;

    const sRes = await fetch(streamUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `https://${host}/sharing/link?surl=${share.surl}`,
        'Cookie': buildCookieHeader(share.randsk, ndus)
      }
    });

    const rawM3u8 = await sRes.text();
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
    return new Response(err.message, { status: 500 });
  }
}

// 3. Segment Proxy Handler
async function handleSegment(request, env) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response('URL required', { status: 400 });
  }

  const host = env.TERABOX_HOST || 'dm.1024terabox.com';
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
    return new Response('Error proxying segment: ' + e.message, { status: 502 });
  }
}

// 4. Download Handler
async function handleDownload(request, env) {
  const url = new URL(request.url);
  const surl = url.searchParams.get('surl');
  const fid = url.searchParams.get('fid');

  if (!surl || !fid) return new Response('surl and fid required', { status: 400 });

  const host = env.TERABOX_HOST || 'dm.1024terabox.com';
  const ndus = env.TERABOX_NDUS || '';

  try {
    const targetSurl = surl.startsWith('1') ? surl.slice(1) : surl;
    const shareUrl = `https://${host}/sharing/link?surl=${targetSurl}`;
    const shareRes = await fetch(shareUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Cookie': buildCookieHeader(null, ndus)
      }
    });
    const html = await shareRes.text();
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});<\/script>/);
    const data = JSON.parse(stateMatch[1]);
    const share = data.pinia?.share?.shareInfo;

    const streamUrl = `https://${host}/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${share.shareid}&uk=${share.uk}&sign=${share.sign}&timestamp=${share.timestamp}&fid=${fid}&type=M3U8_AUTO_480`;
    const sRes = await fetch(streamUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `https://${host}/sharing/link?surl=${share.surl}`,
        'Cookie': buildCookieHeader(share.randsk, ndus)
      }
    });

    const m3u8 = await sRes.text();
    const lines = m3u8.split('\n').map(l => l.trim()).filter(Boolean);
    const segUrls = lines.filter(l => l.startsWith('http://') || l.startsWith('https://'));

    if (segUrls.length === 0) return new Response('No downloadable stream found', { status: 404 });

    // Stream first chunk or pipe
    const chunkRes = await fetch(segUrls[0], {
      headers: { 'User-Agent': USER_AGENT, 'Referer': `https://${host}/` }
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
    return new Response('Download error: ' + e.message, { status: 500 });
  }
}

// Main Cloudflare Fetch Router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
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
      return new Response(JSON.stringify({
        success: true,
        hasNdus: Boolean(env.TERABOX_NDUS && env.TERABOX_NDUS.length > 5),
        mode: env.TERABOX_NDUS ? 'Full HD Mode (Unlimited)' : 'Preview Mode'
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Serve Static Assets from public/
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
