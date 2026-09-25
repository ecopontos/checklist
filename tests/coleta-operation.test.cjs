const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('coleta-operation.js', 'utf8');
assert.match(source, /function parseOperationQuantity/);
assert.match(source, /validCivilDate\(value\)/);
assert.match(source, /db\.saveColetaOperation\(\{ operationId, data: date, roteiro: roteiroNome, entries: payload \}\)/);
assert.match(source, /checklistContext = \{ requestId, roteiroNome \}/);
assert.match(source, /requestId !== checklistContext\?\.requestId/);
assert.match(source, /if \(!await waitForChecklistData\(requestId\)\) return/);
assert.match(source, /startColetaSync\(db/);
assert.doesNotMatch(source, /pushColetas|markColetaSynced/);
assert.match(source, /if \(hasInvalidTableQuantity\(\)\) return/);

function quantity(value) {
  if (value === '' || value == null) return 0;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
assert.equal(quantity('12'), 12);
assert.equal(quantity('1.5'), null);
assert.equal(quantity('1e2'), null);
assert.equal(quantity('-1'), null);
assert.equal(quantity(String(Number.MAX_SAFE_INTEGER) + '0'), null);

console.log('coleta-operation: regressions ok');
