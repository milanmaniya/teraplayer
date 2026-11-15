// functions/api/m3u8.js - Cloudflare Pages Function for /api/m3u8

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function buildCookieHeader(randsk, ndus) {
  const parts = [];
  if (ndus) parts.push(`ndus=${ndus.replace(/^ndus=/, '').trim()}`);
  if (randsk) parts.push(`randsk=${randsk}`);
  parts.push('lang=en');
  return parts.join('; ');
}

export async function onRequestGet(context) {
  const { request, env } = context;
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

    // Rewrite segments
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
