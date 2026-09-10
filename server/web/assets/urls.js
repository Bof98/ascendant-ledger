// Resolve against this module's location so Caddy can strip any mount prefix.
export function scopedApiUrl(url, realm, moduleUrl) {
  if (!String(url).startsWith('/api/')) return url;
  const base = new URL('../', moduleUrl);
  const result = new URL(String(url).slice(1), base);
  result.searchParams.set('realm', realm);
  return `${result.pathname}${result.search}${result.hash}`;
}
