// functions/api/m3u8.js - Cloudflare Pages Function for /api/m3u8

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_NDUS = 'YbbOLXupeHuiW6-qutQMS9aDgf9xNC5JDZDRR-Cu';
const DEFAULT_HOST = 'dm.1024terabox.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (ndus) parts.push(`ndus=${ndus.replace(/^ndus=/, '').trim()}`);
  if (randsk) parts.push(`randsk=${randsk}`);
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
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to parse TeraBox metadata');
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const surl = url.searchParams.get('surl');
  const fid = url.searchParams.get('fid');

  if (!surl || !fid) {
    return new Response('surl and fid are required', { status: 400, headers: CORS_HEADERS });
  }

  const ndus = getNdus(env);

  try {
    const { share, activeHost } = await fetchShareInfoWithFallback(surl, env);

    const hostsToTry = [activeHost, getHost(env), 'dm.1024terabox.com', 'www.1024tera.com'];
    let rawM3u8 = '';

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
    return new Response(err.message, { status: 500, headers: CORS_HEADERS });
  }
}
