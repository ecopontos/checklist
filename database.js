/**
 * Database module for App3 - Coleta & Roteiros
 * Uses sql.js (SQLite WebAssembly)
 */

class AppDatabase {
    constructor() {
        this.db = null;
        this.SQL = null;
    }

    async init() {
        if (this.db) return;

        // Load sql.js
        this.SQL = await initSqlJs({
            locateFile: file => `./vendor/${file}`
        });

        // Try to load from localStorage
        const savedDb = localStorage.getItem('app3_db');
        if (savedDb) {
            const uInt8Array = new Uint8Array(JSON.parse(savedDb));
            this.db = new this.SQL.Database(uInt8Array);
        } else {
            this.db = new this.SQL.Database();
        }
        this.createTables();
        this.migrateSchema();
    }

    // Migração idempotente: adiciona colunas de cliente em bancos locais já
    // existentes (o CREATE TABLE IF NOT EXISTS não as adicionaria). Ao incluir
    // id_cliente pela primeira vez, força um reimport para popular os campos
    // novos a partir das rows achatadas do Sheets.
    migrateSchema() {
        const cols = this._tableColumns('clientes');
        if (cols.length) {
            const adds = [];
            if (!cols.includes('id_cliente')) adds.push('id_cliente TEXT');
            if (!cols.includes('complemento')) adds.push('complemento TEXT');
            if (!cols.includes('telefone1')) adds.push('telefone1 TEXT');
            if (!cols.includes('telefone2')) adds.push('telefone2 TEXT');
            if (adds.length) {
                const addedIdCliente = adds.some(def => def.startsWith('id_cliente'));
                adds.forEach(def => this.db.run(`ALTER TABLE clientes ADD COLUMN ${def}`));
                if (addedIdCliente) {
                    localStorage.removeItem('app3_last_drive_sync');
                }
                this.save();
            }
        }

        const roteirosCols = this._tableColumns('roteiros');
        if (roteirosCols.length && !roteirosCols.includes('tipo_residuo')) {
            this.db.run('ALTER TABLE roteiros ADD COLUMN tipo_residuo TEXT');
            this.save();
        }
    }

    _tableColumns(table) {
        const res = this.db.exec(`PRAGMA table_info(${table})`);
        if (!res.length) return [];
        const nameIdx = res[0].columns.indexOf('name');
        return res[0].values.map(v => v[nameIdx]);
    }

    createTables() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS roteiros (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT UNIQUE NOT NULL,
                last_sync TEXT,
                sync_id TEXT
            );

            CREATE TABLE IF NOT EXISTS clientes (
                id_rota TEXT PRIMARY KEY,
                id_cliente TEXT,
                cliente TEXT NOT NULL,
                logradouro TEXT,
                numero TEXT,
                complemento TEXT,
                cep TEXT,
                telefone1 TEXT,
                telefone2 TEXT,
                roteiro_id INTEGER,
                ordem INTEGER,
                ativo INTEGER DEFAULT 1,
                last_sync TEXT,
                sync_id TEXT,
                FOREIGN KEY (roteiro_id) REFERENCES roteiros(id)
            );

            CREATE TABLE IF NOT EXISTS coletas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_rota TEXT,
                data TEXT,
                quantidade INTEGER,
                intercorrencia TEXT,
                last_sync TEXT,
                sync_id TEXT,
                FOREIGN KEY (id_rota) REFERENCES clientes(id_rota)
            );

            CREATE TABLE IF NOT EXISTS roteiro_change_outbox (
                change_id TEXT PRIMARY KEY,
                id_rota TEXT NOT NULL,
                inativo INTEGER NOT NULL,
                ordem REAL NOT NULL,
                roteiro TEXT NOT NULL,
                alterado_em TEXT NOT NULL,
                origem TEXT NOT NULL,
                sent_at TEXT
            );

            CREATE TABLE IF NOT EXISTS cliente_change_outbox (
                change_id TEXT PRIMARY KEY,
                id_cliente TEXT NOT NULL,
                campos TEXT NOT NULL,
                alterado_em TEXT NOT NULL,
                origem TEXT NOT NULL,
                sent_at TEXT
            );

            CREATE TABLE IF NOT EXISTS logradouro_legado (
                id_rota TEXT PRIMARY KEY,
                logradouro TEXT NOT NULL
            );
        `);
        this.save();
    }

    save() {
        const data = this.db.export();
        const array = Array.from(data);
        localStorage.setItem('app3_db', JSON.stringify(array));
    }

    // --- Roteiros ---
    addRoteiro(nome, tipoResiduo = '') {
        this.db.run(`
            INSERT INTO roteiros (nome, tipo_residuo) VALUES (?, ?)
            ON CONFLICT(nome) DO UPDATE SET tipo_residuo = excluded.tipo_residuo
        `, [nome, tipoResiduo]);
        this.save();
    }

    getRoteiros() {
        const res = this.db.exec("SELECT id, nome, tipo_residuo FROM roteiros ORDER BY nome");
        return res.length ? res[0].values.map(v => ({ id: v[0], nome: v[1], tipo_residuo: v[2] || '' })) : [];
    }

    // --- Clientes ---
    // Se a planilha nao trouxer logradouro (ela nunca traz — só o CSV legado do
    // Access tem essa coluna), cai para o valor já salvo e, na falta dele, para
    // o backfill legado persistido em logradouro_legado. Isso torna o backfill
    // independente da ordem entre o import do CSV e o primeiro sync de uma rota
    // nova vinda do Sheets.
    upsertCliente(cliente) {
        this.db.run(`
            INSERT INTO clientes (id_rota, id_cliente, cliente, logradouro, numero, complemento, cep, telefone1, telefone2, roteiro_id, ordem, ativo)
            VALUES (?, ?, ?, COALESCE(NULLIF(?, ''), (SELECT logradouro FROM logradouro_legado WHERE id_rota = ?)), ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_rota) DO UPDATE SET
                id_cliente = COALESCE(NULLIF(excluded.id_cliente, ''), id_cliente),
                cliente = excluded.cliente,
                logradouro = COALESCE(NULLIF(excluded.logradouro, ''), logradouro),
                numero = excluded.numero,
                complemento = excluded.complemento,
                cep = excluded.cep,
                telefone1 = excluded.telefone1,
                telefone2 = excluded.telefone2,
                roteiro_id = excluded.roteiro_id,
                ordem = excluded.ordem,
                ativo = excluded.ativo
        `, [
            cliente.idRota,
            cliente.idCliente || '',
            cliente.Cliente,
            cliente.logradouro,
            cliente.idRota,
            this._normalizeNumero(cliente.Número),
            cliente.Complemento || '',
            cliente.CEP,
            this._normalizeNumero(cliente.Telefone1),
            this._normalizeNumero(cliente.Telefone2),
            cliente.roteiro_id,
            this._normalizeOrdem(cliente.Ordem),
            cliente.ativo ? 1 : 0
        ]);
        this.save();
    }

    getClientesByRoteiro(roteiroId) {
        const res = this.db.exec(
            "SELECT * FROM clientes WHERE roteiro_id = ? ORDER BY CAST(REPLACE(TRIM(ordem), ',', '.') AS REAL), id_rota COLLATE NOCASE",
            [roteiroId]
        );
        if (!res.length) return [];
        const cols = res[0].columns;
        return res[0].values.map(v => {
            const obj = {};
            cols.forEach((c, i) => obj[c] = v[i]);
            return obj;
        });
    }

    getClienteByIdRota(idRota) {
        const res = this.db.exec(
            "SELECT c.*, r.nome AS roteiro_nome FROM clientes c JOIN roteiros r ON c.roteiro_id = r.id WHERE c.id_rota = ?",
            [idRota]
        );
        if (!res.length) return null;
        const obj = {};
        res[0].columns.forEach((column, index) => {
            obj[column] = res[0].values[0][index];
        });
        return obj;
    }

    getContatosWhatsapp(roteiroId) {
        const roteiro = this.getRoteiros().find(r => r.id === roteiroId);
        const roteiroNome = roteiro ? roteiro.nome : '';
        const clientes = this.getClientesByRoteiro(roteiroId).filter(c => c.ativo);

        const contatos = [];
        clientes.forEach(cliente => {
            [[1, cliente.telefone1], [2, cliente.telefone2]].forEach(([slot, raw]) => {
                const digits = this._normalizeTelefoneDigits(raw);
                if (!digits) return;
                contatos.push({
                    idRota: cliente.id_rota,
                    slot,
                    nome: cliente.cliente,
                    telefoneExibicao: raw,
                    telefoneDigits: digits,
                    roteiroNome
                });
            });
        });
        return contatos;
    }

    // Telefones abaixo de 8 digitos sao lixo (campo vazio, "0", etc.) e nunca
    // devem virar destinatario de disparo. Numeros com 10-11 digitos (DDD + numero)
    // nao possuem DDI e recebem o 55 (BR). Numeros com 12-13 digitos presume-se
    // que ja possuem codigo de pais (DDI).
    // Nota: A decisao e baseada em contagem de digitos, nao no prefixo, porque
    // o DDD 55 (Rio Grande do Sul) coincide com o DDI do Brasil.
    _normalizeTelefoneDigits(value) {
        const digits = String(value ?? '').replace(/\D/g, '');
        if (digits.length < 8) return '';
        if (digits.length <= 11) return '55' + digits;
        return digits;
    }

    applyRoteiroOrder(roteiroId, orderedIds) {
        const clientes = this.getClientesByRoteiro(roteiroId);
        if (!clientes.length) {
            throw new Error('O roteiro selecionado não possui pontos.');
        }

        const ids = orderedIds.map(id => String(id));
        const uniqueIds = new Set(ids);
        const currentById = new Map(clientes.map(cliente => [String(cliente.id_rota), cliente]));
        if (ids.length !== clientes.length || uniqueIds.size !== ids.length) {
            throw new Error('A lista reordenada contém pontos ausentes ou duplicados.');
        }
        if (ids.some(id => !currentById.has(id))) {
            throw new Error('A lista reordenada não corresponde ao roteiro selecionado.');
        }
        if (ids.some(id => !/^\d+$/.test(id))) {
            throw new Error('O roteiro possui pontos locais que ainda não existem na planilha.');
        }

        const routeResult = this.db.exec('SELECT nome FROM roteiros WHERE id = ?', [roteiroId]);
        if (!routeResult.length) throw new Error('Roteiro não encontrado.');
        const roteiroNome = String(routeResult[0].values[0][0]);
        const changed = ids.reduce((result, id, index) => {
            const cliente = currentById.get(id);
            const ordem = index + 1;
            if (this._normalizeOrdem(cliente.ordem) !== ordem) {
                result.push({ cliente, ordem });
            }
            return result;
        }, []);

        if (!changed.length) return { count: 0, changedIds: [] };

        let origem = localStorage.getItem('app3_device_id');
        if (!origem) {
            origem = this._newChangeId();
            localStorage.setItem('app3_device_id', origem);
        }
        const alteredAt = new Date().toISOString();
        let inTransaction = false;
        try {
            this.db.run('BEGIN TRANSACTION');
            inTransaction = true;
            changed.forEach(({ cliente, ordem }) => {
                this.db.run(
                    'UPDATE clientes SET ordem = ? WHERE id_rota = ? AND roteiro_id = ?',
                    [ordem, cliente.id_rota, roteiroId]
                );
                this.db.run(`
                    INSERT INTO roteiro_change_outbox
                        (change_id, id_rota, inativo, ordem, roteiro, alterado_em, origem)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    this._newChangeId(),
                    String(cliente.id_rota),
                    cliente.ativo ? 0 : 1,
                    ordem,
                    roteiroNome,
                    alteredAt,
                    origem
                ]);
            });
            this.db.run('COMMIT');
            inTransaction = false;
        } catch (error) {
            if (inTransaction) {
                try { this.db.run('ROLLBACK'); } catch (_) { /* mantém o erro original */ }
            }
            throw error;
        }

        this.save();
        return {
            count: changed.length,
            changedIds: changed.map(({ cliente }) => String(cliente.id_rota))
        };
    }

    _normalizeOrdem(value) {
        const normalized = String(value ?? '').trim().replace(',', '.');
        const order = Number(normalized);
        return Number.isFinite(order) ? order : 0;
    }

    _normalizeNumero(value) {
        // Planilhas exportam número de endereço formatado como decimal
        // (ex: "123,00"). Remove o ",00"/".00" artificial, preservando
        // valores não puramente numéricos (ex: "123A", "S/N").
        const str = String(value ?? '').trim();
        const match = str.match(/^(\d+)[.,]0+$/);
        return match ? match[1] : str;
    }

    importRoteirosCsv(csvText) {
        const cleanText = String(csvText || '').replace(/^\uFEFF/, '');
        const results = Papa.parse(cleanText, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: true
        });
        return this.importRoteirosRows(results.data);
    }

    // Importa a partir de linhas achatadas ja em objeto (mesmas colunas do CSV).
    // Usado tanto pelo import manual de CSV quanto pela sincronizacao com o
    // Sheets (action=roteiros), que entrega as linhas direto em JSON.
    importRoteirosRows(dataRows) {
        const rows = Array.isArray(dataRows) ? dataRows : [];

        const comOrdemValida = rows.filter(row => {
            const ordem = this._getCsvVal(row, 'Ordem');
            if (ordem === null || ordem === undefined || ordem === '') return false;
            // Number() nao entende decimal com virgula (formato do export do
            // Access, ex: "0,00") e vira NaN — que passaria no !== 0 sem
            // querer. _normalizeOrdem trata a virgula antes de comparar.
            return this._normalizeOrdem(ordem) !== 0;
        });

        const semDuplicataRoteiroCliente = new Map();
        comOrdemValida.forEach(row => {
            const chave = this._getCsvVal(row, 'Roteiro') + '||' + this._getCsvVal(row, 'Cliente');
            semDuplicataRoteiroCliente.set(chave, row);
        });
        const data = [...semDuplicataRoteiroCliente.values()];

        const uniqueRoteiros = [...new Set(data.map(r => this._getCsvVal(r, 'Roteiro')).filter(Boolean))];
        const tipoResiduoPorRoteiro = {};
        data.forEach(row => {
            const nome = this._getCsvVal(row, 'Roteiro');
            if (nome && !(nome in tipoResiduoPorRoteiro)) {
                tipoResiduoPorRoteiro[nome] = this._getCsvVal(row, 'TipoResiduo') || '';
            }
        });
        uniqueRoteiros.forEach(name => this.addRoteiro(name, tipoResiduoPorRoteiro[name] || ''));

        const roteiros = this.getRoteiros();
        const routeMap = {};
        roteiros.forEach(r => routeMap[r.nome] = r.id);

        // Preserva localmente qualquer id_rota/id_cliente com alteração ainda
        // não enviada ao Sheets (fila de push): sem isso, um import automático
        // (que roda a cada abertura do app) reverteria silenciosamente uma
        // reordenação de rota ou edição de cliente feita no app antes dela
        // ser sincronizada.
        const idRotasPendentes = this._getPendingRoteiroIdRotas();
        const idClientesPendentes = this._getPendingClienteIds();

        let clientesCount = 0;
        let pulados = 0;
        data.forEach(row => {
            const idRota = this._getCsvVal(row, 'idRota') || this._getCsvVal(row, 'id Rota');
            const clienteNome = this._getCsvVal(row, 'Cliente');
            const roteiroName = this._getCsvVal(row, 'Roteiro');

            if (!idRota || !clienteNome) return;

            const idRotaStr = idRota.toString();
            if (idRotasPendentes.has(idRotaStr)) { pulados++; return; }

            const idClienteAtual = this._getIdClienteByIdRota(idRotaStr);
            if (idClienteAtual && idClientesPendentes.has(idClienteAtual)) { pulados++; return; }

            this.upsertCliente({
                idRota: idRotaStr,
                idCliente: this._getCsvVal(row, 'idCliente') || '',
                Cliente: clienteNome,
                logradouro: this._getCsvVal(row, 'Logradouro') || this._getCsvVal(row, 'Rua') || '',
                Número: this._getCsvVal(row, 'Número') || this._getCsvVal(row, 'Num') || this._getCsvVal(row, 'Nº') || '',
                Complemento: this._getCsvVal(row, 'Complemento') || '',
                CEP: this._getCsvVal(row, 'CEP') || '',
                Telefone1: this._getCsvVal(row, 'Telefone1') || '',
                Telefone2: this._getCsvVal(row, 'Telefone2') || '',
                roteiro_id: routeMap[roteiroName],
                Ordem: this._getCsvVal(row, 'Ordem') || 0,
                ativo: this._getCsvVal(row, 'Inativo') != 1
            });
            clientesCount++;
        });

        return { roteiros: uniqueRoteiros.length, clientes: clientesCount, pulados };
    }

    _getPendingRoteiroIdRotas() {
        const res = this.db.exec("SELECT DISTINCT id_rota FROM roteiro_change_outbox WHERE sent_at IS NULL");
        return res.length ? new Set(res[0].values.map(v => String(v[0]))) : new Set();
    }

    _getPendingClienteIds() {
        const res = this.db.exec("SELECT DISTINCT id_cliente FROM cliente_change_outbox WHERE sent_at IS NULL");
        return res.length ? new Set(res[0].values.map(v => String(v[0]))) : new Set();
    }

    _getIdClienteByIdRota(idRota) {
        const res = this.db.exec("SELECT id_cliente FROM clientes WHERE id_rota = ?", [idRota]);
        return res.length && res[0].values.length ? String(res[0].values[0][0] || '') : '';
    }

    _getCsvVal(row, name) {
        const key = Object.keys(row).find(k => k.toLowerCase().trim() === name.toLowerCase());
        return key ? row[key] : null;
    }

    // Backfill pontual do logradouro a partir do CSV legado do Access
    // (cstExportaCheckList.csv), casado por id_rota. Ao contrário de
    // importRoteirosRows, atualiza SOMENTE a coluna logradouro — não toca em
    // ordem/ativo/roteiro_id/complemento/telefones, que já vêm do Sheets e
    // seriam apagados/revertidos se passassem pelo import genérico.
    //
    // Toda linha também é gravada em logradouro_legado, mesmo quando o
    // cliente ainda não existe localmente (rota nova que o Sheets ainda não
    // sincronizou): upsertCliente consulta essa tabela ao criar o cliente, o
    // que evita perder o dado por causa da ordem entre este import e o
    // próximo sync de roteiros.
    importLogradourosCsv(csvText) {
        const cleanText = String(csvText || '').replace(/^﻿/, '');
        const results = Papa.parse(cleanText, { header: true, skipEmptyLines: true });
        const rows = Array.isArray(results.data) ? results.data : [];

        let updated = 0;
        let semLogradouro = 0;
        let semCorrespondencia = 0;

        rows.forEach(row => {
            const idRota = String(this._getCsvVal(row, 'idRota') || '').trim();
            const logradouro = String(this._getCsvVal(row, 'logradouro') || '').trim();
            if (!idRota) return;
            if (!logradouro) { semLogradouro++; return; }

            this.db.run(`
                INSERT INTO logradouro_legado (id_rota, logradouro) VALUES (?, ?)
                ON CONFLICT(id_rota) DO UPDATE SET logradouro = excluded.logradouro
            `, [idRota, logradouro]);

            this.db.run('UPDATE clientes SET logradouro = ? WHERE id_rota = ?', [logradouro, idRota]);
            if (this.db.getRowsModified() > 0) {
                updated++;
            } else {
                semCorrespondencia++;
            }
        });

        this.save();
        return { updated, semLogradouro, semCorrespondencia, total: rows.length };
    }

    // --- Alterações de roteiros pendentes para a planilha ---
    queueRoteiroChange(idRota) {
        const cliente = this.getClienteByIdRota(idRota);
        if (!cliente || !/^\d+$/.test(String(cliente.id_rota))) {
            return { queued: false, reason: 'not-access-record' };
        }

        let origem = localStorage.getItem('app3_device_id');
        if (!origem) {
            origem = this._newChangeId();
            localStorage.setItem('app3_device_id', origem);
        }

        const change = {
            change_id: this._newChangeId(),
            id_rota: String(cliente.id_rota),
            inativo: cliente.ativo ? 0 : 1,
            ordem: this._normalizeOrdem(cliente.ordem),
            roteiro: cliente.roteiro_nome,
            alterado_em: new Date().toISOString(),
            origem
        };

        this.db.run(`
            INSERT INTO roteiro_change_outbox
                (change_id, id_rota, inativo, ordem, roteiro, alterado_em, origem)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            change.change_id,
            change.id_rota,
            change.inativo,
            change.ordem,
            change.roteiro,
            change.alterado_em,
            change.origem
        ]);
        this.save();
        return { queued: true, change };
    }

    getPendingRoteiroChanges(limit = 50) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
        const res = this.db.exec(`
            SELECT change_id, id_rota, inativo, ordem, roteiro, alterado_em, origem
            FROM roteiro_change_outbox
            WHERE sent_at IS NULL
            ORDER BY alterado_em, change_id
            LIMIT ?
        `, [safeLimit]);
        if (!res.length) return [];
        return res[0].values.map(values => {
            const row = {};
            res[0].columns.forEach((column, index) => {
                row[column] = values[index];
            });
            return row;
        });
    }

    markRoteiroChangesSent(changeIds) {
        const sentAt = new Date().toISOString();
        changeIds.forEach(changeId => {
            this.db.run(
                "UPDATE roteiro_change_outbox SET sent_at = ? WHERE change_id = ?",
                [sentAt, changeId]
            );
        });
        this.save();
    }

    getPendingRoteiroChangesCount() {
        const res = this.db.exec(
            "SELECT COUNT(*) FROM roteiro_change_outbox WHERE sent_at IS NULL"
        );
        return res.length ? Number(res[0].values[0][0]) : 0;
    }

    // --- Alterações de cliente pendentes para a planilha (shtClientes) ---
    queueClienteChange(idCliente, campos) {
        const id = String(idCliente || '').trim();
        if (!id || !campos || !Object.keys(campos).length) {
            return { queued: false, reason: 'no-change' };
        }
        let origem = localStorage.getItem('app3_device_id');
        if (!origem) {
            origem = this._newChangeId();
            localStorage.setItem('app3_device_id', origem);
        }
        const change = {
            change_id: this._newChangeId(),
            id_cliente: id,
            campos: JSON.stringify(campos),
            alterado_em: new Date().toISOString(),
            origem
        };
        this.db.run(`
            INSERT INTO cliente_change_outbox
                (change_id, id_cliente, campos, alterado_em, origem)
            VALUES (?, ?, ?, ?, ?)
        `, [change.change_id, change.id_cliente, change.campos, change.alterado_em, change.origem]);
        this.save();
        return { queued: true, change };
    }

    // Atualiza no cache local todas as linhas do mesmo cliente (id_cliente),
    // para a edição refletir imediatamente em todos os roteiros dele.
    updateClienteLocal(idCliente, campos) {
        const colByField = {
            Cliente: 'cliente',
            'Número': 'numero',
            Complemento: 'complemento',
            CEP: 'cep',
            Telefone1: 'telefone1',
            Telefone2: 'telefone2'
        };
        const id = String(idCliente || '').trim();
        if (!id) return;
        Object.keys(campos).forEach(field => {
            const col = colByField[field];
            if (!col) return;
            let value = campos[field];
            if (col === 'numero') value = this._normalizeNumero(value);
            this.db.run(`UPDATE clientes SET ${col} = ? WHERE id_cliente = ?`, [value, id]);
        });
        this.save();
    }

    getPendingClienteChanges(limit = 50) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
        const res = this.db.exec(`
            SELECT change_id, id_cliente, campos, alterado_em, origem
            FROM cliente_change_outbox
            WHERE sent_at IS NULL
            ORDER BY alterado_em, change_id
            LIMIT ?
        `, [safeLimit]);
        if (!res.length) return [];
        return res[0].values.map(values => {
            const row = {};
            res[0].columns.forEach((column, index) => { row[column] = values[index]; });
            try { row.campos = JSON.parse(row.campos); } catch (_) { row.campos = {}; }
            return row;
        });
    }

    markClienteChangesSent(changeIds) {
        const sentAt = new Date().toISOString();
        changeIds.forEach(changeId => {
            this.db.run(
                "UPDATE cliente_change_outbox SET sent_at = ? WHERE change_id = ?",
                [sentAt, changeId]
            );
        });
        this.save();
    }

    getPendingClienteChangesCount() {
        const res = this.db.exec(
            "SELECT COUNT(*) FROM cliente_change_outbox WHERE sent_at IS NULL"
        );
        return res.length ? Number(res[0].values[0][0]) : 0;
    }

    _newChangeId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
            const random = Math.floor(Math.random() * 16);
            const value = char === 'x' ? random : (random & 0x3) | 0x8;
            return value.toString(16);
        });
    }

    // --- Coletas ---
    addColeta(coleta) {
        // O sync_id é gerado e persistido já no insert (estável). Assim um
        // reenvio após falha de resposta carrega o MESMO id, e o GAS
        // deduplica por ele em vez de gravar a coleta duas vezes.
        const syncId = coleta.sync_id || crypto.randomUUID();
        this.db.run(`
            INSERT INTO coletas (id_rota, data, quantidade, intercorrencia, sync_id)
            VALUES (?, ?, ?, ?, ?)
        `, [coleta.id_rota, coleta.data, coleta.quantidade, coleta.intercorrencia, syncId]);
        const id = this.db.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
        this.save();
        return id;
    }

    getUltimaQuantidade(idRota) {
        const res = this.db.exec(
            "SELECT quantidade FROM coletas WHERE id_rota = ? ORDER BY id DESC LIMIT 1",
            [String(idRota)]
        );
        if (!res.length || !res[0].values.length) return null;
        return res[0].values[0][0];
    }

    getColetasByDate(data) {
        const res = this.db.exec(`
            SELECT c.*, cl.cliente
            FROM coletas c
            JOIN clientes cl ON c.id_rota = cl.id_rota
            WHERE c.data = ?
        `, [data]);
        if (!res.length) return [];
        const cols = res[0].columns;
        return res[0].values.map(v => {
            const obj = {};
            cols.forEach((c, i) => obj[c] = v[i]);
            return obj;
        });
    }

    markColetaSynced(id, syncId) {
        this.db.run("UPDATE coletas SET last_sync = ?, sync_id = ? WHERE id = ?", [new Date().toISOString(), syncId, id]);
        this.save();
    }

    getUnsyncedColetas() {
        const res = this.db.exec(`
            SELECT c.id, c.id_rota, c.data, c.quantidade, c.intercorrencia, cl.cliente, r.nome as roteiro, c.sync_id
            FROM coletas c
            JOIN clientes cl ON c.id_rota = cl.id_rota
            JOIN roteiros r ON cl.roteiro_id = r.id
            WHERE c.last_sync IS NULL
            ORDER BY c.data DESC
        `);
        if (!res.length) return [];
        const cols = res[0].columns;
        return res[0].values.map(v => {
            const obj = {};
            cols.forEach((c, i) => obj[c] = v[i]);
            return obj;
        });
    }

    // --- Export/Backup ---
    downloadDatabase() {
        const data = this.db.export();
        const blob = new Blob([data], { type: 'application/x-sqlite3' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `satelite_v3_backup_${new Date().toISOString().slice(0,10)}.db`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// O export do Access (cstExportaCheckList.csv) sai em UTF-16LE com BOM;
// detecta pelo BOM em vez de assumir UTF-8, para não corromper acentos.
// Usado tanto pelo upload manual (admin.html) quanto pela leitura automática
// da pasta de rede (google-sync.js).
export function decodeLegacyCsvBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(buffer);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(buffer);
    }
    return new TextDecoder('utf-8').decode(buffer);
}

const db = new AppDatabase();
export default db;
