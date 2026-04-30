function fromB64url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  return padded + (pad ? '='.repeat(4 - pad) : '');
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig = Uint8Array.from(atob(fromB64url(s)), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'HMAC', key, sig, new TextEncoder().encode(`${h}.${p}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(fromB64url(p)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export default async function authCheck(request, context) {
  const token = (request.headers.get('cookie') || '')
    .match(/(?:^|;\s*)auth=([^;]*)/)?.[1];

  if (token) {
    const secret = Deno.env.get('JWT_SECRET');
    if (secret && await verifyJWT(token, secret)) {
      return context.next();
    }
  }

  return Response.redirect(
    'https://felasfa.app/?redirect=' + encodeURIComponent(request.url), 302
  );
}

export const config = { path: '/*' };
