// Converts the 2x poster renders (out/web/NN@2x.png) into optimized WebP for the portal's /demo page:
// packages/portal/public/demo/NN.webp (1270w) and NN@2x.webp (2540w).
// sharp is not a repo dependency; point SHARP_DIR at any folder where it is installed:
//   SHARP_DIR=/path/with/node_modules bun launch/media/convert-web.mjs
import { createRequire } from 'module';
import { mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(process.env.SHARP_DIR ?? here, 'noop.js'));
const sharp = require('sharp');
const src = join(here, 'out/web');
const out = join(here, '../../packages/portal/public/demo');
mkdirSync(out, { recursive: true });

let total = 0;
for (let i = 1; i <= 10; i++) {
  const n = String(i).padStart(2, '0');
  const input = join(src, `${n}@2x.png`);
  for (const [suffix, width] of [['', 1270], ['@2x', 2540]]) {
    const dest = join(out, `${n}${suffix}.webp`);
    await sharp(input).resize({ width }).webp({ quality: 82, effort: 6, smartSubsample: true }).toFile(dest);
    total += statSync(dest).size;
    console.log(`${n}${suffix}.webp ${(statSync(dest).size / 1024).toFixed(0)}KB`);
  }
}
console.log(`total ${(total / 1024).toFixed(0)}KB`);
