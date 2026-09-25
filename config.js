// Valores padrão da integração com o GAS (Google Apps Script).
// Servem de fallback quando o usuário ainda não configurou manualmente
// a URL/token na tela Admin (localStorage sempre tem prioridade).
// Não coloque segredos reais aqui — este arquivo é versionado no git.
// Para embutir os valores reais no instalador, copie
// config.local.example.js para config.local.js (ignorado pelo git) e
// preencha antes de rodar "npm run build".
window.APP_CONFIG = window.APP_CONFIG || {
    gasUrl: 'https://script.google.com/macros/s/AKfycbzVyXmq7XBIVeweoOM27-fJDvUxPL4IWImVRBy4cbpfn92Q-p-rIMoJAFVZKr23Hw0/exec',
    gasRouteToken: ''
};

// Regras locais usadas para preencher {residuo} no disparo de WhatsApp.
// Um padrao terminado em * casa por prefixo; sem * exige o nome exato.
window.ROTEIRO_TIPOS_RESIDUO = window.ROTEIRO_TIPOS_RESIDUO || [
    { tipo: 'Organicos', padroes: ['SAT*', 'SOBI*', 'SatEpan', 'ESCOLA-ORGANICO-*'] },
    { tipo: 'Vidro', padroes: ['SV*'] }
];

window.getTipoResiduoPorRoteiro = function (roteiroNome) {
    var nome = String(roteiroNome || '').trim().toUpperCase();
    if (!nome) return '';

    for (var i = 0; i < window.ROTEIRO_TIPOS_RESIDUO.length; i++) {
        var regra = window.ROTEIRO_TIPOS_RESIDUO[i];
        for (var j = 0; j < regra.padroes.length; j++) {
            var padrao = String(regra.padroes[j] || '').trim().toUpperCase();
            var prefixo = padrao.endsWith('*') ? padrao.slice(0, -1) : null;
            if ((prefixo !== null && nome.startsWith(prefixo)) || nome === padrao) {
                return regra.tipo;
            }
        }
    }
    return '';
};
