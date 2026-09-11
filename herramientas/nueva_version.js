/**
 * Sube el número de versión en todos los sitios a la vez:
 *   app/package.json (version), app/www/config.js (VERSION) y app/android/app/build.gradle (versionCode/versionName).
 *
 * Uso: node herramientas/nueva_version.js 1.2.0
 * Luego: git commit -am "v1.2.0" && git tag v1.2.0 && git push && git push --tags  -> GitHub publica la release.
 */
const fs = require('fs');
const path = require('path');

const nueva = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(nueva || '')) { console.error('Uso: node herramientas/nueva_version.js X.Y.Z'); process.exit(1); }
const raiz = path.join(__dirname, '..', 'app');

const pkgRuta = path.join(raiz, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgRuta, 'utf8'));
pkg.version = nueva;
fs.writeFileSync(pkgRuta, JSON.stringify(pkg, null, 2) + '\n');

const cfgRuta = path.join(raiz, 'www', 'config.js');
fs.writeFileSync(cfgRuta, fs.readFileSync(cfgRuta, 'utf8').replace(/VERSION: '[^']*'/, `VERSION: '${nueva}'`));

const gradleRuta = path.join(raiz, 'android', 'app', 'build.gradle');
if (fs.existsSync(gradleRuta)) {
  const [ma, mi, pa] = nueva.split('.').map(Number);
  const codigo = ma * 10000 + mi * 100 + pa;   // 1.2.3 -> 10203 (siempre creciente)
  fs.writeFileSync(gradleRuta, fs.readFileSync(gradleRuta, 'utf8')
    .replace(/versionCode \d+/, `versionCode ${codigo}`)
    .replace(/versionName "[^"]*"/, `versionName "${nueva}"`));
}
console.log('Versión actualizada a', nueva);
