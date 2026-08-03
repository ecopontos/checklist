// Valores padrão da integração com o GAS (Google Apps Script).
// Servem de fallback quando o usuário ainda não configurou manualmente
// a URL/token na tela Admin (localStorage sempre tem prioridade).
// Não coloque segredos reais aqui — este arquivo é versionado no git.
// Para embutir os valores reais no instalador, copie
// config.local.example.js para config.local.js (ignorado pelo git) e
// preencha antes de rodar "npm run build".
window.APP_CONFIG = window.APP_CONFIG || {
    gasUrl: '',
    gasRouteToken: ''
};
