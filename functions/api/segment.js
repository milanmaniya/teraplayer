// functions/api/segment.js - Cloudflare Pages Function for /api/segment

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
  const { request, env } = context;
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
