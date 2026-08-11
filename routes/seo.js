const express = require('express');
const router  = express.Router();
const { getDb } = require('../config/firebase');

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Safely embed a JSON-LD object inside a <script> tag — guards against a
// literal "</script>" inside any field (e.g. a product description)
// prematurely closing the tag.
function jsonLdScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function renderNotFound() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Product Not Found — Kerich Pharmaceuticals</title>
<meta name="robots" content="noindex, follow">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{font-family:'DM Sans',Arial,sans-serif;background:#0A0A0F;color:#F5F0E8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px;}
a{color:#C9A84C;}</style></head>
<body><div><h1>Product not found</h1><p>It may be out of stock or no longer listed.</p>
<p><a href="/shop.html">← Back to the shop</a></p></div></body></html>`;
}

// GET /sitemap.xml — dynamic: static pages + every active product.
// Superseded the old hand-written static file, which could never stay
// in sync with a 1,470-product catalog that changes as stock/pricing
// updates happen.
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);

    const staticUrls = [
      { loc: 'https://kerichpharma.co.ke/',            priority: '1.0', freq: 'weekly'  },
      { loc: 'https://kerichpharma.co.ke/shop.html',   priority: '0.9', freq: 'daily'   },
      { loc: 'https://kerichpharma.co.ke/news.html',   priority: '0.5', freq: 'weekly'  },
      { loc: 'https://kerichpharma.co.ke/Aboutus.html',priority: '0.4', freq: 'monthly' },
    ];

    const snap = await db.collection('products').where('active', '==', true).get();
    const productUrls = snap.docs.map(d => ({
      loc: `https://kerichpharma.co.ke/product/${encodeURIComponent(d.data().sku)}`,
      priority: '0.6', freq: 'weekly',
    }));

    const all = [...staticUrls, ...productUrls];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${all.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (err) { next(err); }
});

// GET /product/:sku — server-rendered product landing page: real <title>,
// meta description, canonical URL, Open Graph, and Product JSON-LD
// (accurate price/availability, pulled live — never fabricated). This is
// the only genuinely crawlable/indexable/shareable URL for an individual
// product; shop.html itself is a single client-rendered page that loads
// all products via JS, which search engines can't reliably deep-link
// into or show as separate rich results.
router.get('/product/:sku', async (req, res, next) => {
  try {
    const db = getDb();
    const snap = await db.collection('products').where('sku', '==', req.params.sku).limit(1).get();
    if (snap.empty) return res.status(404).send(renderNotFound());

    const p = snap.docs[0].data();
    if (!p.active) return res.status(404).send(renderNotFound());

    const sku          = escHtml(p.sku);
    const name          = escHtml(p.name);
    const description   = escHtml(p.description || `${p.name} — available at Kerich Pharmaceuticals, Nairobi. Order online with same-day delivery.`);
    const canonicalUrl  = `https://kerichpharma.co.ke/product/${encodeURIComponent(p.sku)}`;
    const shopUrl       = `https://kerichpharma.co.ke/shop.html?search=${encodeURIComponent(p.sku)}`;
    const image         = p.image ? escHtml(p.image) : 'https://kerichpharma.co.ke/images/og-default.png';
    const inStock       = (p.stock || 0) > 0;
    const priceStr      = Number(p.price || 0).toLocaleString();
    const metaTitle     = `${p.name} — KES ${priceStr} | Kerich Pharmaceuticals`;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.name,
      sku: p.sku,
      description: p.description || undefined,
      image: p.image || undefined,
      category: p.category || undefined,
      offers: {
        '@type': 'Offer',
        url: canonicalUrl,
        priceCurrency: 'KES',
        price: p.price || 0,
        availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        seller: { '@type': 'Pharmacy', name: 'Kerich Pharmaceuticals Ltd' },
      },
    };

    const breadcrumbLd = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://kerichpharma.co.ke/' },
        { '@type': 'ListItem', position: 2, name: 'Shop', item: 'https://kerichpharma.co.ke/shop.html' },
        { '@type': 'ListItem', position: 3, name: p.name, item: canonicalUrl },
      ],
    };

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(metaTitle)}</title>
<meta name="description" content="${description.slice(0,300)}">
<link rel="canonical" href="${canonicalUrl}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="product">
<meta property="og:title" content="${escHtml(metaTitle)}">
<meta property="og:description" content="${description.slice(0,300)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${image}">
<meta property="product:price:amount" content="${p.price || 0}">
<meta property="product:price:currency" content="KES">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(metaTitle)}">
<meta name="twitter:image" content="${image}">
<script type="application/ld+json">${jsonLdScript(jsonLd)}</script>
<script type="application/ld+json">${jsonLdScript(breadcrumbLd)}</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'DM Sans',sans-serif;background:#0A0A0F;color:#F5F0E8;min-height:100vh;}
.wrap{max-width:640px;margin:0 auto;padding:32px 20px 60px;}
.crumb{font-size:12px;color:#7A7468;margin-bottom:20px;}
.crumb a{color:#7A7468;text-decoration:none;}
.crumb a:hover{color:#C9A84C;}
.card{background:#1C1C2A;border:1px solid rgba(201,168,76,0.15);border-radius:16px;overflow:hidden;}
.photo{width:100%;height:280px;object-fit:contain;background:#1A1A26;padding:16px;}
.body{padding:24px 26px;}
.cat{font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;}
h1{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:700;margin-bottom:12px;line-height:1.25;}
.price{font-size:24px;font-weight:600;color:#C9A84C;margin-bottom:6px;}
.stock{font-size:13px;margin-bottom:18px;}
.stock.in{color:#5DCAA5;}
.stock.out{color:#E24B4A;}
.desc{font-size:14px;color:#B8B0A0;line-height:1.7;margin-bottom:24px;}
.cta{display:block;text-align:center;background:#C9A84C;color:#1A1200;font-weight:600;padding:14px;border-radius:10px;text-decoration:none;font-size:14px;}
.back{display:block;text-align:center;margin-top:16px;font-size:12px;color:#7A7468;text-decoration:none;}
.back:hover{color:#C9A84C;}
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb"><a href="/">Home</a> / <a href="/shop.html">Shop</a> / ${name}</div>
  <div class="card">
    <img class="photo" src="${image}" alt="${name}" loading="lazy">
    <div class="body">
      ${p.category ? `<div class="cat">${escHtml(p.category)}</div>` : ''}
      <h1>${name}</h1>
      <div class="price">KES ${priceStr}</div>
      <div class="stock ${inStock ? 'in' : 'out'}">${inStock ? '✓ In stock' : '✕ Currently out of stock'}</div>
      <div class="desc">${description}</div>
      <a class="cta" href="${shopUrl}">View in Shop &amp; Add to Cart →</a>
    </div>
  </div>
  <a class="back" href="/shop.html">← Back to all products</a>
</div>
</body>
</html>`);
  } catch (err) { next(err); }
});

module.exports = router;
