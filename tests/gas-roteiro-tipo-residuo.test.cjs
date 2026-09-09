const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isNaN
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

const rotasValues = [
  ['idPJ', 'idRota', 'idRoteiro', 'Ordem', 'Inativo'],
  ['100', '2912', '1', '1', '0'],
  ['200', '2967', '1', '2', '0']
];

const clientesValues = [
  ['idPJ', 'idUnico2', 'Cliente', 'Número', 'Complemento', 'CEP', 'Telefone1', 'Telefone2'],
  ['100', 'uuid-1', 'CLIENTE UM', '10', '', '88000000', '48999990000', ''],
  ['200', 'uuid-2', 'CLIENTE DOIS', '20', '', '88000000', '48988880000', '']
];

const roteirosValues = [
  ['idRoteiro', 'Roteiro', 'Tipo de Resíduo'],
  ['1', 'SV07', 'Vidro']
];

const result = context.buildFlatRoteiros_(rotasValues, clientesValues, roteirosValues);

assert.strictEqual(result.rows.length, 2);
assert.strictEqual(result.rows[0].Roteiro, 'SV07');
assert.strictEqual(result.rows[0].TipoResiduo, 'Vidro', 'linha achatada deve trazer o tipo de residuo do roteiro');
assert.strictEqual(result.rows[1].TipoResiduo, 'Vidro', 'mesmo roteiro para os dois clientes -> mesmo tipo de residuo');

// Roteiro sem a coluna "Tipo de Resíduo" preenchida na planilha: nao deve
// falhar, so vem vazio.
const roteirosSemColuna = [
  ['idRoteiro', 'Roteiro'],
  ['1', 'SV07']
];
const resultSemColuna = context.buildFlatRoteiros_(rotasValues, clientesValues, roteirosSemColuna);
assert.strictEqual(resultSemColuna.rows[0].TipoResiduo, '', 'sem a coluna Tipo de Residuo, campo deve vir vazio, sem lancar erro');

console.log('buildFlatRoteiros_: propaga TipoResiduo por roteiro, tolera coluna ausente: OK');
