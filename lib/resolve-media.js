// Turns *any* GIF page link (Klipy, Tenor, Giphy, Imgur, Redgifs, Reddit...)
// or a direct media URL into { url, kind, source, title } that a browser can show.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|gifv)(\?|#|$)/i;
const IMAGE_EXT = /\.(gif|webp|apng|png|jpe?g|avif)(\?|#|$)/i;

function fetchTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' }).finally(() => clearTimeout(t));
}

function kindFromUrl(u) {
  if (/\.gifv(\?|#|$)/i.test(u)) return 'video'; // imgur gifv is actually an mp4
  if (VIDEO_EXT.test(u)) return 'video';
  if (IMAGE_EXT.test(u)) return 'image';
  return null;
}

function titleFromUrl(u) {
  try {
    const p = decodeURIComponent(new URL(u).pathname).replace(/\/+$/, '');
    const last = p.split('/').pop() || 'gif';
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').slice(0, 80) || 'gif';
  } catch {
    return 'gif';
  }
}

function metaContent(html, prop) {
  const re = new RegExp(
    '<meta[^>]+(?:property|name)=["\']' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>',
    'i'
  );
  const tag = html.match(re);
  if (!tag) return null;
  const m = tag[0].match(/content=["\']([^"\']+)["\']/i);
  return m ? decodeEntities(m[1]) : null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2F;/gi, '/');
}

function unescapeSlashes(s) {
  return s.replace(/\\\//g, '/');
}

function pickTitle(html, fallback) {
  const og = metaContent(html, 'og:title');
  if (og) return og.split(/\s+[|\u2013\u2014-]\s+/)[0].slice(0, 90);
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t) return decodeEntities(t[1]).trim().split(/\s+[|\u2013\u2014-]\s+/)[0].slice(0, 90);
  return fallback;
}

async function looksLike(url) {
  // HEAD the candidate to learn if it is an image or a video.
  try {
    const r = await fetchTimeout(url, { method: 'HEAD', headers: { 'User-Agent': UA } }, 6000);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('video/')) return 'video';
    if (ct.startsWith('image/')) return 'image';
  } catch {}
  return kindFromUrl(url) || 'image';
}

async function resolveMedia(rawUrl) {
  const input = String(rawUrl || '').trim();
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('That does not look like a link.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) links work.');

  const host = url.hostname.replace(/^www\./, '');

  // 1) Direct media file — done.
  const direct = kindFromUrl(url.href);
  if (direct) {
    return { url: url.href, kind: direct, source: host, title: titleFromUrl(url.href) };
  }

  // 2) It's a page — fetch it and hunt for the direct media URL.
  let html = '';
  try {
    const r = await fetchTimeout(url.href, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (r.ok) html = await r.text();
  } catch {}

  if (html) {
    const plain = unescapeSlashes(html);
    const candidates = [];

    // Klipy: https://static2.klipy.com/ii/<hash>/xx/yy/name.gif
    for (const m of plain.matchAll(/https?:\/\/static\d*\.klipy\.com\/[^\s"'<>)]+?\.(?:gif|mp4|webp)/gi)) {
      candidates.push(m[0]);
    }
    // Tenor direct media
    for (const m of plain.matchAll(/https?:\/\/media\d*\.tenor\.com\/[^\s"'<>\\)]+?\.(?:gif|mp4)/gi)) {
      candidates.push(m[0]);
    }
    // Giphy direct media
    for (const m of plain.matchAll(/https?:\/\/i?\d?\.?giphy\.com\/media\/[A-Za-z0-9]+\/giphy\.(?:gif|mp4)/gi)) {
      candidates.push(m[0].replace('://giphy.com', '://i.giphy.com'));
    }
    // Imgur direct
    for (const m of plain.matchAll(/https?:\/\/i\.imgur\.com\/[A-Za-z0-9]+\.(?:gif|mp4|webp)/gi)) {
      candidates.push(m[0]);
    }

    const prefer = (re) => candidates.find((c) => re.test(c));
    const best =
      prefer(/\.gif($|\?)/i) ||
      prefer(/\.mp4($|\?)/i) ||
      candidates[0] ||
      metaContent(html, 'og:video:secure_url') ||
      metaContent(html, 'og:video:url') ||
      metaContent(html, 'og:video') ||
      metaContent(html, 'twitter:player:stream') ||
      metaContent(html, 'og:image:secure_url') ||
      metaContent(html, 'og:image') ||
      metaContent(html, 'twitter:image');

    if (best) {
      const clean = unescapeSlashes(best).replace(/&amp;/g, '&');
      let kind = kindFromUrl(clean);
      if (!kind) kind = await looksLike(clean);
      return { url: clean, kind, source: host, title: pickTitle(html, titleFromUrl(url.href)) };
    }
  }

  // 3) Page had nothing usable.
  throw new Error(
    'Could not find a GIF on that page. Try the direct image link (right-click the GIF -> "Copy image address").'
  );
}

module.exports = { resolveMedia, UA };
