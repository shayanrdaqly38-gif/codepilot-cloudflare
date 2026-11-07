// GET /api/gfx/moon.png
// PNG شفاف (RGBA) از ماه کامل پیکسلی — بدون پس‌زمینه، بدون وابستگی خارجی.
// پارامتر اختیاری ?s=2|4|8|16 → ۸۰ / ۱۶۰ / ۳۲۰ / ۶۴۰ پیکسل (پیش‌فرض ۸).

import { buildMoonPng } from '../../_lib/moon.js';

export async function onRequest({ request }) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
  }

  let s = 8;
  try {
    const parsed = Number(new URL(request.url).searchParams.get('s') || 8);
    if (Number.isFinite(parsed)) s = Math.max(2, Math.min(16, Math.round(parsed)));
  } catch {
    s = 8;
  }

  const png = buildMoonPng(s);
  return new Response(png, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'public, max-age=86400'
    }
  });
}
