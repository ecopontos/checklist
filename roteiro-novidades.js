// Uma única seleção para PDF e impressão HTML. Não altera ciência nem cadastro.
export function listarNovidades(db, roteiroId, clientes) {
    const ids = new Set(db.getNovidadesRoteiro(roteiroId).map(i => i.id_rota));
    return clientes.filter(c => c.ativo && ids.has(String(c.id_rota)))
        .map(c => ({ id_rota:String(c.id_rota), cliente:c.cliente, ordem:c.ordem }));
}

export function tituloNovidades(quantidade) {
    return `ATENÇÃO: ${quantidade} ${quantidade === 1 ? 'novo ponto' : 'novos pontos'} neste roteiro`;
}

export function renderResumoNovidades(container, novidades) {
    container.replaceChildren();
    container.hidden = !novidades.length;
    if (!novidades.length) return;
    const doc = container.ownerDocument;
    const title = doc.createElement('strong');
    title.textContent = tituloNovidades(novidades.length);
    container.appendChild(title);
    const list = doc.createElement('ul');
    for (const n of novidades) {
        const item = doc.createElement('li');
        item.textContent = `${n.ordem ?? ''} — ${n.cliente ?? ''}`;
        list.appendChild(item);
    }
    container.appendChild(list);
}

export function desenharResumoNovidades(doc, novidades, { startY, bottomReserve }) {
    if (!novidades.length) return startY;
    doc.autoTable({
        startY,
        head: [[{ content: tituloNovidades(novidades.length), colSpan: 2 }]],
        body: novidades.map(n => [String(n.ordem ?? ''), String(n.cliente ?? '')]),
        theme: 'grid',
        styles: { fontSize: 9, cellPadding: 2, textColor: 0, lineColor: 0, lineWidth: 0.3 },
        headStyles: { fillColor: 255, textColor: 0, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 18 } },
        rowPageBreak: 'avoid',
        margin: { top: 14, bottom: bottomReserve + 18 }
    });
    let next = doc.lastAutoTable.finalY + 5;
    if (next > doc.internal.pageSize.getHeight() - bottomReserve - 20) { doc.addPage(); next = 14; }
    return next;
}
