// functions/api/resolve.js - Cloudflare Pages Function for /api/resolve

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

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    // 1. Resolve TeraViralHub URL
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

    // 2. Fetch Share Info
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
    if (!share || !share.shareid) throw new Error('Share information not found or expired');

    let files = [];
    let primaryFile = null;

    if (String(share.fileInfo.isdir) === '1') {
      // Folder handling with fallback
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

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
