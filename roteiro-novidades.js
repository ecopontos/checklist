// Uma única seleção para PDF e impressão HTML. Não altera ciência nem cadastro.
export function listarNovidades(db, roteiroId, clientes) {
    const ids = new Set(db.getNovidadesRoteiro(roteiroId).map(i => i.id_rota));
    return clientes.filter(c => c.ativo && ids.has(String(c.id_rota)))
        .map(c => ({ id_rota:String(c.id_rota), cliente:c.cliente, ordem:c.ordem }));
}
