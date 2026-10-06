/**
 * Descarga a la RAÍZ del repositorio los ejecutables de la versión publicada en GitHub Releases
 * (instalador y portable de Windows y APK de Android), para tenerlos siempre a mano.
 * Los .exe/.apk de la raíz están en .gitignore: no se versionan.
 *
 * Uso: node herramientas/descargar_release.js [X.Y.Z]   (por defecto, la versión de app/package.json)
 * Requiere la CLI `gh` autenticada.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(raiz, 'app', 'package.json'), 'utf8')).version;
const tag = 'v' + version;

// se borran los ejecutables de versiones anteriores para que en la raíz quede solo la última
fs.readdirSync(raiz).filter(f => /^USDT-CPA.*\.(exe|apk)$/i.test(f)).forEach(f => fs.unlinkSync(path.join(raiz, f)));

execFileSync('gh', ['release', 'download', tag, '--pattern', '*.exe', '--pattern', '*.apk', '--dir', raiz, '--clobber'], { stdio: 'inherit' });
const bajados = fs.readdirSync(raiz).filter(f => /^USDT-CPA.*\.(exe|apk)$/i.test(f));
console.log('Ejecutables de ' + tag + ' en la raíz: ' + bajados.join(', '));
