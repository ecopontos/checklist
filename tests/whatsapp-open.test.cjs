const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

async function main() {
  const nativeCalls = [];
  const browserCalls = [];
  const document = { addEventListener() {} };
  const window = {
    __TAURI_INTERNALS__: {
      invoke(command, payload) {
        nativeCalls.push([command, payload]);
        return Promise.resolve();
      }
    },
    open(url, target) {
      browserCalls.push([url, target]);
      return {};
    }
  };

  vm.runInContext(
    fs.readFileSync('whatsapp-events.js', 'utf8'),
    vm.createContext({ document, window })
  );

  assert.strictEqual(
    typeof window.openWhatsappUrl,
    'function',
    'deve existir um adaptador testavel para abrir o WhatsApp'
  );

  const whatsappUrl = 'https://wa.me/5548999999999?text=Mensagem%20de%20teste';
  await window.openWhatsappUrl(whatsappUrl);
  assert.strictEqual(nativeCalls.length, 1);
  assert.strictEqual(nativeCalls[0][0], 'plugin:shell|open');
  assert.strictEqual(nativeCalls[0][1].path, whatsappUrl);
  assert.strictEqual(Object.hasOwn(nativeCalls[0][1], 'url'), false);

  delete window.__TAURI_INTERNALS__;
  await window.openWhatsappUrl(whatsappUrl);
  assert.deepStrictEqual(browserCalls, [[whatsappUrl, '_blank']]);

  window.open = () => null;
  await assert.rejects(window.openWhatsappUrl(whatsappUrl), /bloquead/i);
  window.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('shell indisponível')) };
  await assert.rejects(window.openWhatsappUrl(whatsappUrl), /shell indisponível/);

  console.log('whatsapp-open: URL enviada ao Tauri no campo path: OK');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
