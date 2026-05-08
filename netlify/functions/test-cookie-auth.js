exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { pmuser, arcId, url } = body;
  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: 'url is required' }) };
  }

  const cookieParts = [];
  if (pmuser)  cookieParts.push(`pmuser=${pmuser}`);
  if (arcId)   cookieParts.push(`ArcId.USER_INFO=${arcId}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Referer': 'https://www.google.com/',
        ...(cookieParts.length ? { 'Cookie': cookieParts.join('; ') } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const html = await response.text();

    const PAYWALL_PATTERNS = [
      /hazte\s+premium/i,
      /suscr[ií]bete/i,
      /iniciar\s+ses[ií]n/i,
      /paywall/i,
      /subscriber[- ]only/i,
      /contenido\s+exclusivo/i,
      /acceso\s+restringido/i,
    ];

    const matches = PAYWALL_PATTERNS
      .filter(re => re.test(html))
      .map(re => re.source);

    // Grab ~500 chars of visible text near the article body as a preview
    const bodyMatch = html.match(/<(?:p|article)[^>]*>([\s\S]{100,500}?)<\/(?:p|article)>/i);
    const preview = bodyMatch
      ? bodyMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 400)
      : '(could not extract preview)';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        httpStatus: response.status,
        paywallFound: matches.length > 0,
        paywallMatches: matches,
        preview,
        htmlLength: html.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
