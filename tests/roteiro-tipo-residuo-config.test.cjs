const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const window = {};
const context = vm.createContext({ window });
vm.runInContext(fs.readFileSync('config.js', 'utf8'), context);

assert.strictEqual(
  typeof window.getTipoResiduoPorRoteiro,
  'function',
  'config.js deve expor o cruzamento entre nome do roteiro e tipo de residuo'
);

const casos = [
  ['SAT01', 'Organicos'],
  ['sat05', 'Organicos'],
  ['SOBI-C-03', 'Organicos'],
  ['SatEpan', 'Organicos'],
  ['ESCOLA-ORGANICO-2', 'Organicos'],
  ['SV01', 'Vidro'],
  ['sv08', 'Vidro'],
  ['ROTEIRO-SEM-MAPEAMENTO', ''],
  ['', '']
];

casos.forEach(([roteiro, esperado]) => {
  assert.strictEqual(
    window.getTipoResiduoPorRoteiro(roteiro),
    esperado,
    `${roteiro || '(vazio)'} deve resultar em ${esperado || 'string vazia'}`
  );
});

console.log('config: cruza roteiro com tipo de residuo por padrao: OK');
