#!/usr/bin/env python3
"""Stamp local asset URLs in index.html with a content hash.

GitHub Pages serves HTML with a short max-age but assets can linger in a
browser cache, which is exactly how you end up running last week's app.js
against this week's data. Run this before publishing.
"""
import hashlib, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = ['styles.css', 'app.js', 'i18n.js', 'data/continents.js']

page = os.path.join(ROOT, 'index.html')
html = open(page, encoding='utf-8').read()

for rel in ASSETS:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        print('  ! missing %s' % rel)
        continue
    digest = hashlib.sha1(open(path, 'rb').read()).hexdigest()[:8]
    pattern = re.compile(r'(?<=["\'])' + re.escape(rel) + r'(?:\?v=[0-9a-f]+)?(?=["\'])')
    html, n = pattern.subn(rel + '?v=' + digest, html)
    print('  %-22s -> ?v=%s  (%d ref%s)' % (rel, digest, n, '' if n == 1 else 's'))

open(page, 'w', encoding='utf-8').write(html)
print('stamped index.html')
