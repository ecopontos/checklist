// Valores padrão da integração com o GAS (Google Apps Script).
// Servem de fallback quando o usuário ainda não configurou manualmente
// a URL/token na tela Admin (localStorage sempre tem prioridade).
// Não coloque segredos reais aqui — este arquivo é versionado no git.
// A URL do GAS NÃO vem embarcada de propósito (decisão de 2026-10-06): o repo
// é público e a URL do web app de produção não deve estar nele. Configure na
// tela Admin (fica no localStorage do aparelho) ou embuta no instalador via
// config.local.js (copie de config.local.example.js antes do npm run build).
window.APP_CONFIG = window.APP_CONFIG || {
    gasUrl: '',
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

// Escolhe, entre as opcoes de tipo de residuo do checklist (ex.: "Vidros",
// "Organicos"), a que corresponde ao tipo guardado no roteiro (ex.: "Vidro" ou
// o texto longo do Access "Reciclaveis Organico (Restos de Alimentos)").
// Ignora acentos e maiusculas e aceita plural/singular. Devolve '' se nenhuma
// opcao corresponde; quem chama decide o que fazer.
window.escolherOpcaoTipoResiduo = function (opcoes, tipo) {
    function norm(texto) {
        return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    }
    var alvo = norm(tipo);
    if (!alvo) return '';
    for (var i = 0; i < opcoes.length; i++) {
        if (norm(opcoes[i]) === alvo) return opcoes[i];
    }
    for (var j = 0; j < opcoes.length; j++) {
        var radical = norm(opcoes[j]).replace(/s$/, '');
        if (radical.length >= 4 && alvo.indexOf(radical) !== -1) return opcoes[j];
    }
    return '';
};
