/**
 * Database module for App3 - Coleta & Roteiros
 * Uses sql.js (SQLite WebAssembly)
 */

// O banco SQLite inteiro é persistido como um único blob. No navegador/PWA
// vai para o IndexedDB (sem o limite de ~5 MB do localStorage); onde não há
// IndexedDB (ex.: testes em node:vm) continua no localStorage como antes.
const DB_KEY = 'app3_db';
const IDB_NAME = 'satelite-checklist';
const IDB_STORE = 'kv';

function idbOpen() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB bloqueado por outra aba.'));
    });
}

function idbRun(conn, mode, operation) {
    return new Promise((resolve, reject) => {
        const tx = conn.transaction(IDB_STORE, mode);
        const request = operation(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error || request.error);
        tx.onabort = () => reject(tx.error || new Error('Transação IndexedDB abortada.'));
    });
}

class AppDatabase {
    constructor() {
        this.db = null;
        this.SQL = null;
        this._idb = null;
        this._pendingBytes = null;
        this._writing = null;
        this._resetting = false;
        this._saveErrorNotified = false;
    }

    // Abre o IndexedDB e devolve os bytes salvos. Na primeira execução migra o
    // banco antigo do localStorage. Se um banco antigo reaparecer depois da
    // migração (versão pré-PWA usada de novo), ele é guardado como cópia de
    // segurança no IndexedDB em vez de sobrescrever o banco atual.
    async _loadFromIndexedDb() {
        this._idb = await idbOpen();
        const stored = await idbRun(this._idb, 'readonly', store => store.get(DB_KEY));
        const legacy = localStorage.getItem(DB_KEY);
        let bytes = stored ? new Uint8Array(stored) : null;
        if (legacy) {
            const legacyBytes = new Uint8Array(JSON.parse(legacy));
            if (bytes) {
                const backupKey = `${DB_KEY}_localstorage_${new Date().toISOString()}`;
                await idbRun(this._idb, 'readwrite', store => store.put(legacyBytes, backupKey));
                console.warn(`Banco antigo do localStorage preservado no IndexedDB como "${backupKey}".`);
            } else {
                await idbRun(this._idb, 'readwrite', store => store.put(legacyBytes, DB_KEY));
                bytes = legacyBytes;
            }
            localStorage.removeItem(DB_KEY);
        }
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(() => {});
        }
        return bytes;
    }

    _installUnloadGuard() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        // Gravações no IndexedDB são assíncronas e o app troca de página a
        // cada menu: segura a navegação por link até o banco terminar de
        // gravar, e pede confirmação se a página for fechada no meio.
        document.addEventListener('click', event => {
            if (!this.hasPendingWrites()) return;
            const link = event.target.closest && event.target.closest('a[href]');
            if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            const href = link.href;
            if (!href || href.startsWith('javascript:') || new URL(href).origin !== location.origin) return;
            event.preventDefault();
            this.flush().finally(() => { location.href = href; });
        }, true);
        window.addEventListener('beforeunload', event => {
            if (!this.hasPendingWrites()) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    async init() {
        if (this.db) return;

        // Load sql.js
        this.SQL = await initSqlJs({
            locateFile: file => `./vendor/${file}`
        });

        let savedBytes = null;
        if (typeof indexedDB !== 'undefined' && indexedDB) {
            try {
                savedBytes = await this._loadFromIndexedDb();
                this._installUnloadGuard();
            } catch (error) {
                console.warn('IndexedDB indisponível; usando localStorage.', error);
                this._idb = null;
            }
        }
        if (!this._idb) {
            const savedDb = localStorage.getItem(DB_KEY);
            if (savedDb) savedBytes = new Uint8Array(JSON.parse(savedDb));
        }
        this.db = savedBytes ? new this.SQL.Database(savedBytes) : new this.SQL.Database();
        this.createTables();
        this.migrateSchema();
        this.migrateColetaSchema();
        this.migrateCadastroSchema();
        // Importações antigas uniam pontos pelo nome. Força uma nova leitura
        // do cadastro uma única vez depois da correção da identidade por idRota.
        if (localStorage.getItem('app3_rota_identity_version') !== '2') {
            if (typeof localStorage.removeItem === 'function') {
                localStorage.removeItem('app3_last_drive_sync');
                localStorage.removeItem('app3_last_roteiros_csv_drive_sync');
            }
            localStorage.setItem('app3_rota_identity_version', '2');
        }
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

    // O app é o dono do cadastro de clientes e roteiros. Tudo que for criado
    // ou editado aqui recebe editado_em, e a importação do CSV do Access nunca
    // sobrescreve esses registros (ver importRoteirosRows).
    migrateCadastroSchema() {
        const addColumn = (table, column) => {
            const cols = this._tableColumns(table);
            if (cols.length && !cols.includes(column)) {
                this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
            }
        };
        addColumn('clientes', 'editado_em');
        addColumn('clientes', 'enviado_em');
        addColumn('roteiros', 'editado_em');
        addColumn('roteiros', 'enviado_em');
        // chave: nome original do roteiro (imutável), identifica o mesmo
        // roteiro em todos os dispositivos mesmo depois de renomeado.
        addColumn('roteiros', 'chave');
        this.db.run(`
            CREATE TABLE IF NOT EXISTS roteiro_alias (
                nome_origem TEXT PRIMARY KEY,
                roteiro_id INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cliente_excluido (
                id_rota TEXT PRIMARY KEY,
                excluido_em TEXT NOT NULL
            );
        `);
        addColumn('cliente_excluido', 'enviado_em');
        this.save();
    }

    _tableColumns(table) {
        const res = this.db.exec(`PRAGMA table_info(${table})`);
        if (!res.length) return [];
        const nameIdx = res[0].columns.indexOf('name');
        return res[0].values.map(v => v[nameIdx]);
    }

    migrateColetaSchema() {
        const cols = this._tableColumns('coletas');
        if (!cols.length) return;
        const additions = [
            ['operation_id', 'TEXT'],
            ['cliente_snapshot', 'TEXT'],
            ['roteiro_snapshot', 'TEXT'],
            ['context_source', 'TEXT']
        ];
        this._persistAtomic(() => {
            additions.forEach(([name, type]) => {
                if (!cols.includes(name)) this.db.run(`ALTER TABLE coletas ADD COLUMN ${name} ${type}`);
            });
            // Para registros antigos só é possível congelar o retrato local
            // disponível na migração. A origem fica explícita para auditoria.
            this.db.run(`UPDATE coletas SET
                cliente_snapshot = COALESCE(cliente_snapshot,
                    (SELECT cliente FROM clientes WHERE id_rota = coletas.id_rota), ''),
                roteiro_snapshot = COALESCE(roteiro_snapshot,
                    (SELECT r.nome FROM clientes cl JOIN roteiros r ON r.id = cl.roteiro_id
                     WHERE cl.id_rota = coletas.id_rota), ''),
                context_source = 'legacy-local'
                WHERE context_source IS NULL`);
        });
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
                operation_id TEXT,
                cliente_snapshot TEXT,
                roteiro_snapshot TEXT,
                context_source TEXT,
                FOREIGN KEY (id_rota) REFERENCES clientes(id_rota)
            );

            CREATE TABLE IF NOT EXISTS coleta_operations (
                operation_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
                campaign_id TEXT PRIMARY KEY,
                message_template TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active','completed')),
                created_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS whatsapp_campaign_items (
                item_id TEXT PRIMARY KEY,
                campaign_id TEXT NOT NULL,
                occurrence_id TEXT NOT NULL,
                id_rota TEXT NOT NULL,
                cliente_snapshot TEXT NOT NULL,
                roteiro_snapshot TEXT NOT NULL,
                coleta_data TEXT NOT NULL,
                intercorrencia_snapshot TEXT NOT NULL,
                message_snapshot TEXT NOT NULL,
                phones_snapshot TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','opened','deferred','confirmed')),
                phone_slot INTEGER,
                phone_snapshot TEXT,
                opened_at TEXT,
                confirmed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_whatsapp_item_occurrence
                ON whatsapp_campaign_items(occurrence_id);
            CREATE INDEX IF NOT EXISTS idx_whatsapp_item_campaign
                ON whatsapp_campaign_items(campaign_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_one_active
                ON whatsapp_campaigns(status) WHERE status = 'active';

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
        if (this._resetting) return;
        const data = this.db.export();
        if (this._idb) {
            this._pendingBytes = data;
            this._writeToIndexedDb();
            return;
        }
        const array = Array.from(data);
        localStorage.setItem(DB_KEY, JSON.stringify(array));
    }

    // Grava sempre o retrato mais recente; saves feitos durante uma gravação
    // em andamento são coalescidos na próxima volta do laço.
    _writeToIndexedDb() {
        if (this._writing) return this._writing;
        this._writing = (async () => {
            try {
                while (this._pendingBytes) {
                    const bytes = this._pendingBytes;
                    this._pendingBytes = null;
                    await idbRun(this._idb, 'readwrite', store => store.put(bytes, DB_KEY));
                }
            } catch (error) {
                console.error('Falha ao gravar o banco local no IndexedDB.', error);
                if (!this._saveErrorNotified && typeof alert === 'function') {
                    this._saveErrorNotified = true;
                    alert('Não foi possível salvar os dados locais neste dispositivo. '
                        + 'Faça um backup pela tela Admin antes de fechar o app.');
                }
            } finally {
                this._writing = null;
            }
        })();
        return this._writing;
    }

    hasPendingWrites() {
        return Boolean(this._writing || this._pendingBytes);
    }

    // Resolve quando o último save() já estiver gravado no disco.
    async flush() {
        while (this._writing) await this._writing;
    }

    // Apaga o banco local (Admin > Resetar). Depois disso nenhum save() grava
    // mais nada até a página ser recarregada.
    async resetStorage() {
        this._resetting = true;
        this._pendingBytes = null;
        await this.flush();
        if (this._idb) await idbRun(this._idb, 'readwrite', store => store.delete(DB_KEY));
        localStorage.removeItem(DB_KEY);
    }

    _persistAtomic(action) {
        const before = this.db.export();
        try {
            const result = action();
            this.save();
            return result;
        } catch (error) {
            this.db.close();
            this.db = new this.SQL.Database(before);
            throw error;
        }
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
    upsertCliente(cliente, { origemApp = false } = {}) {
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
        if (origemApp) {
            this.db.run('UPDATE clientes SET editado_em = ? WHERE id_rota = ?',
                [new Date().toISOString(), String(cliente.idRota)]);
            this.db.run('DELETE FROM cliente_excluido WHERE id_rota = ?', [String(cliente.idRota)]);
        }
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
        const tipoResiduo = roteiro ? roteiro.tipo_residuo : '';
        const clientes = this.getClientesByRoteiro(roteiroId).filter(c => c.ativo);

        const contatos = [];
        clientes.forEach(cliente => {
            this._getWhatsappPhones(cliente).forEach(phone => {
                contatos.push({
                    idRota: cliente.id_rota,
                    slot: phone.slot,
                    nome: cliente.cliente,
                    telefoneExibicao: phone.exibicao,
                    telefoneDigits: phone.digits,
                    roteiroNome,
                    tipoResiduo
                });
            });
        });
        return contatos;
    }

    getWhatsappContactDirectory() {
        const res = this.db.exec(`
            SELECT c.id_rota, c.cliente, c.telefone1, c.telefone2,
                COALESCE(r.nome, '') AS roteiro_nome,
                COALESCE(r.tipo_residuo, '') AS tipo_residuo
            FROM clientes c
            LEFT JOIN roteiros r ON r.id = c.roteiro_id
            WHERE c.ativo = 1
            ORDER BY COALESCE(r.nome, ''),
                CAST(REPLACE(TRIM(c.ordem), ',', '.') AS REAL), c.id_rota COLLATE NOCASE
        `);
        if (!res.length) return [];
        return res[0].values.map(values => {
            const cliente = Object.fromEntries(res[0].columns.map((column, index) => [column, values[index]]));
            return {
                idRota: String(cliente.id_rota),
                cliente: cliente.cliente,
                roteiroNome: cliente.roteiro_nome,
                tipoResiduo: cliente.tipo_residuo,
                phones: this._getWhatsappPhones(cliente)
            };
        });
    }

    _getWhatsappPhones(cliente) {
        return [[1, cliente.telefone1], [2, cliente.telefone2]].reduce((phones, [slot, raw]) => {
            const digits = this._normalizeTelefoneDigits(raw);
            if (digits) phones.push({ slot, exibicao: raw, digits });
            return phones;
        }, []);
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
        // O Access só conhece o nome original do roteiro (a chave).
        const routeResult = this.db.exec('SELECT COALESCE(chave, nome) FROM roteiros WHERE id = ?', [roteiroId]);
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
                    'UPDATE clientes SET ordem = ?, editado_em = ? WHERE id_rota = ? AND roteiro_id = ?',
                    [ordem, alteredAt, cliente.id_rota, roteiroId]
                );
                // Pontos criados no app (ids "APP-n") não existem no Access.
                if (!/^\d+$/.test(String(cliente.id_rota))) return;
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

    // --- Sincronização do cadastro entre dispositivos (GAS v14) ---
    getDeviceId() {
        let origem = localStorage.getItem('app3_device_id');
        if (!origem) {
            origem = this._newChangeId();
            localStorage.setItem('app3_device_id', origem);
        }
        return origem;
    }

    getCadastroRev() {
        const rev = Number(localStorage.getItem('app3_cadastro_rev'));
        return Number.isFinite(rev) && rev > 0 ? rev : 0;
    }

    setCadastroRev(rev) {
        localStorage.setItem('app3_cadastro_rev', String(Math.max(0, Number(rev) || 0)));
    }

    _roteiroChave(roteiroId) {
        const res = this.db.exec('SELECT COALESCE(chave, nome) FROM roteiros WHERE id = ?', [roteiroId]);
        return res.length ? String(res[0].values[0][0]) : '';
    }

    _findRoteiroIdByChave(chave) {
        const lookups = [
            ['SELECT id FROM roteiros WHERE chave = ?', [chave]],
            ['SELECT id FROM roteiros WHERE nome = ?', [chave]],
            ['SELECT roteiro_id FROM roteiro_alias WHERE nome_origem = ?', [chave]]
        ];
        for (const [sql, params] of lookups) {
            const res = this.db.exec(sql, params);
            if (res.length) return Number(res[0].values[0][0]);
        }
        return null;
    }

    // Registros que mudaram neste aparelho e ainda não foram confirmados pelo GAS.
    getCadastroPendente({ maxPontos = 200, maxRoteiros = 100 } = {}) {
        const origem = this.getDeviceId();
        const editados = this._queryRows(`
            SELECT c.id_rota, c.cliente, c.logradouro, c.numero, c.complemento, c.cep, c.telefone1,
                   c.telefone2, c.ordem, c.ativo, c.editado_em, COALESCE(r.chave, r.nome) AS roteiro
            FROM clientes c JOIN roteiros r ON r.id = c.roteiro_id
            WHERE c.editado_em IS NOT NULL AND (c.enviado_em IS NULL OR c.enviado_em < c.editado_em)
            ORDER BY c.editado_em, c.id_rota LIMIT ?`, [maxPontos]);
        const pontos = editados.map(row => ({
            id_rota: String(row.id_rota), cliente: row.cliente || '', logradouro: row.logradouro || '',
            numero: row.numero || '', complemento: row.complemento || '', cep: row.cep || '',
            telefone1: row.telefone1 || '', telefone2: row.telefone2 || '', roteiro: row.roteiro,
            ordem: this._normalizeOrdem(row.ordem), ativo: row.ativo ? 1 : 0, excluido: 0,
            editado_em: row.editado_em, origem
        }));
        this._queryRows(`
            SELECT id_rota, excluido_em FROM cliente_excluido
            WHERE enviado_em IS NULL OR enviado_em < excluido_em
            ORDER BY excluido_em LIMIT ?`, [Math.max(0, maxPontos - pontos.length)]
        ).forEach(row => pontos.push({
            id_rota: String(row.id_rota), cliente: '', roteiro: '', excluido: 1,
            editado_em: row.excluido_em, origem
        }));
        const roteiros = this._queryRows(`
            SELECT id, nome, COALESCE(chave, nome) AS chave, tipo_residuo, editado_em FROM roteiros
            WHERE editado_em IS NOT NULL AND (enviado_em IS NULL OR enviado_em < editado_em)
            ORDER BY editado_em LIMIT ?`, [maxRoteiros]).map(row => ({
            chave: row.chave, nome: row.nome, tipo_residuo: row.tipo_residuo || '',
            apelidos: this._queryRows('SELECT nome_origem FROM roteiro_alias WHERE roteiro_id = ?', [row.id])
                .map(alias => alias.nome_origem).filter(nome => nome !== row.nome),
            editado_em: row.editado_em, origem
        }));
        return { pontos, roteiros };
    }

    getCadastroPendenteCount() {
        const count = sql => Number(this.db.exec(sql)[0]?.values[0][0] || 0);
        return count(`SELECT COUNT(*) FROM clientes WHERE editado_em IS NOT NULL AND (enviado_em IS NULL OR enviado_em < editado_em)`)
            + count(`SELECT COUNT(*) FROM cliente_excluido WHERE enviado_em IS NULL OR enviado_em < excluido_em`)
            + count(`SELECT COUNT(*) FROM roteiros WHERE editado_em IS NOT NULL AND (enviado_em IS NULL OR enviado_em < editado_em)`);
    }

    // Marca como enviado o horário exato que foi ao GAS: se o registro foi
    // editado de novo durante o envio, continua pendente.
    marcarCadastroEnviado({ pontos = [], roteiros = [] }) {
        pontos.forEach(p => {
            if (p.excluido) {
                this.db.run('UPDATE cliente_excluido SET enviado_em = ? WHERE id_rota = ? AND excluido_em <= ?',
                    [p.editado_em, p.id_rota, p.editado_em]);
            } else {
                this.db.run('UPDATE clientes SET enviado_em = ? WHERE id_rota = ?', [p.editado_em, p.id_rota]);
            }
        });
        roteiros.forEach(r => {
            this.db.run('UPDATE roteiros SET enviado_em = ? WHERE COALESCE(chave, nome) = ?', [r.editado_em, r.chave]);
        });
        this.save();
    }

    // Aplica registros vindos do GAS. Sem `forcar`, uma edição local mais nova
    // que a remota é mantida (ela será enviada na próxima rodada); com `forcar`
    // (conflitos que o GAS decidiu a favor do servidor) a versão remota vale.
    aplicarCadastroRemoto({ pontos = [], roteiros = [] }, { forcar = false } = {}) {
        const resumo = { roteiros: 0, pontos: 0, excluidos: 0, ignorados: 0, avisos: [] };
        this._persistAtomic(() => {
            roteiros.forEach(r => this._aplicarRoteiroRemoto(r, forcar, resumo));
            pontos.forEach(p => this._aplicarPontoRemoto(p, forcar, resumo));
        });
        return resumo;
    }

    _aplicarRoteiroRemoto(remoto, forcar, resumo) {
        let id = this._findRoteiroIdByChave(remoto.chave);
        if (id === null) {
            const mesmoNome = this.db.exec('SELECT id FROM roteiros WHERE nome = ? COLLATE NOCASE', [remoto.nome]);
            if (mesmoNome.length) id = Number(mesmoNome[0].values[0][0]);
        }
        if (id === null) {
            this.db.run('INSERT INTO roteiros (nome, tipo_residuo, chave, editado_em, enviado_em) VALUES (?, ?, ?, ?, ?)',
                [remoto.nome, remoto.tipo_residuo || '', remoto.chave, remoto.editado_em, remoto.editado_em]);
            id = Number(this.db.exec('SELECT id FROM roteiros WHERE nome = ?', [remoto.nome])[0].values[0][0]);
            (remoto.apelidos || []).filter(a => a !== remoto.nome).forEach(apelido =>
                this.db.run('INSERT OR REPLACE INTO roteiro_alias (nome_origem, roteiro_id) VALUES (?, ?)', [apelido, id]));
            if (remoto.chave !== remoto.nome) {
                this.db.run('INSERT OR REPLACE INTO roteiro_alias (nome_origem, roteiro_id) VALUES (?, ?)', [remoto.chave, id]);
            }
            resumo.roteiros++;
            return;
        }
        const atual = this._queryRows('SELECT nome, editado_em FROM roteiros WHERE id = ?', [id])[0];
        if (!forcar && atual.editado_em && atual.editado_em > remoto.editado_em) { resumo.ignorados++; return; }
        let nome = atual.nome;
        if (remoto.nome !== atual.nome) {
            const ocupado = this.db.exec('SELECT id FROM roteiros WHERE nome = ? COLLATE NOCASE AND id <> ?', [remoto.nome, id]);
            if (ocupado.length) {
                resumo.avisos.push(`Roteiro "${remoto.nome}" não pôde ser renomeado: já existe outro com esse nome.`);
            } else {
                nome = remoto.nome;
            }
        }
        this.db.run('UPDATE roteiros SET nome = ?, tipo_residuo = ?, chave = ?, editado_em = ?, enviado_em = ? WHERE id = ?',
            [nome, remoto.tipo_residuo || '', remoto.chave, remoto.editado_em, remoto.editado_em, id]);
        const antigos = new Set([...(remoto.apelidos || []), remoto.chave, atual.nome]);
        antigos.delete(nome);
        antigos.forEach(apelido =>
            this.db.run('INSERT OR REPLACE INTO roteiro_alias (nome_origem, roteiro_id) VALUES (?, ?)', [apelido, id]));
        this.db.run('DELETE FROM roteiro_alias WHERE nome_origem = ? COLLATE NOCASE', [nome]);
        resumo.roteiros++;
    }

    _aplicarPontoRemoto(remoto, forcar, resumo) {
        const idRota = String(remoto.id_rota);
        const local = this._queryRows('SELECT editado_em, roteiro_id FROM clientes WHERE id_rota = ?', [idRota])[0];
        const lapide = this._queryRows('SELECT excluido_em FROM cliente_excluido WHERE id_rota = ?', [idRota])[0];
        const tempoLocal = [local?.editado_em, lapide?.excluido_em].filter(Boolean).sort().pop();
        if (!forcar && tempoLocal && tempoLocal > remoto.editado_em) { resumo.ignorados++; return; }

        if (remoto.excluido) {
            const coletas = Number(this.db.exec('SELECT COUNT(*) FROM coletas WHERE id_rota = ?', [idRota])[0].values[0][0]);
            if (local && coletas > 0) {
                // Há histórico de coleta neste aparelho: só inativa para não quebrar relatórios.
                this.db.run('UPDATE clientes SET ativo = 0, editado_em = ?, enviado_em = ? WHERE id_rota = ?',
                    [remoto.editado_em, remoto.editado_em, idRota]);
            } else {
                this.db.run('DELETE FROM clientes WHERE id_rota = ?', [idRota]);
                this.db.run('INSERT OR REPLACE INTO cliente_excluido (id_rota, excluido_em, enviado_em) VALUES (?, ?, ?)',
                    [idRota, remoto.editado_em, remoto.editado_em]);
            }
            resumo.excluidos++;
            return;
        }

        let roteiroId = this._findRoteiroIdByChave(remoto.roteiro);
        if (roteiroId === null) {
            this.db.run('INSERT INTO roteiros (nome, tipo_residuo, chave) VALUES (?, ?, ?)', [remoto.roteiro, '', remoto.roteiro]);
            roteiroId = Number(this.db.exec('SELECT id FROM roteiros WHERE nome = ?', [remoto.roteiro])[0].values[0][0]);
        }
        this.db.run(`
            INSERT INTO clientes (id_rota, cliente, logradouro, numero, complemento, cep, telefone1, telefone2,
                                  roteiro_id, ordem, ativo, editado_em, enviado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_rota) DO UPDATE SET
                cliente = excluded.cliente, logradouro = excluded.logradouro, numero = excluded.numero,
                complemento = excluded.complemento, cep = excluded.cep, telefone1 = excluded.telefone1,
                telefone2 = excluded.telefone2, roteiro_id = excluded.roteiro_id, ordem = excluded.ordem,
                ativo = excluded.ativo, editado_em = excluded.editado_em, enviado_em = excluded.enviado_em
        `, [idRota, remoto.cliente, remoto.logradouro || '', remoto.numero || '', remoto.complemento || '',
            remoto.cep || '', remoto.telefone1 || '', remoto.telefone2 || '', roteiroId,
            this._normalizeOrdem(remoto.ordem), remoto.ativo ? 1 : 0, remoto.editado_em, remoto.editado_em]);
        this.db.run('DELETE FROM cliente_excluido WHERE id_rota = ?', [idRota]);
        resumo.pontos++;
    }

    _upsertRoteiroImportado(nome, tipoResiduo, sobrescrever) {
        this.db.run(`
            INSERT INTO roteiros (nome, tipo_residuo) VALUES (?, ?)
            ON CONFLICT(nome) DO UPDATE SET tipo_residuo = CASE
                WHEN roteiros.editado_em IS NOT NULL AND ? = 0 THEN roteiros.tipo_residuo
                ELSE excluded.tipo_residuo END
        `, [nome, tipoResiduo, sobrescrever ? 1 : 0]);
        if (sobrescrever) this.db.run('UPDATE roteiros SET editado_em = NULL WHERE nome = ?', [nome]);
        this.save();
    }

    // --- Cadastro editado no app ---
    _requireNome(value, label) {
        const nome = String(value ?? '').trim().replace(/\s+/g, ' ');
        if (!nome) throw new Error(`Informe o ${label}.`);
        return nome;
    }

    _roteiroExiste(nome, ignorarId = null) {
        const res = this.db.exec(
            'SELECT id FROM roteiros WHERE nome = ? COLLATE NOCASE AND id IS NOT ?', [nome, ignorarId]);
        const alias = this.db.exec(
            'SELECT roteiro_id FROM roteiro_alias WHERE nome_origem = ? COLLATE NOCASE AND roteiro_id IS NOT ?',
            [nome, ignorarId]);
        return Boolean(res.length || alias.length);
    }

    criarRoteiro(nome, tipoResiduo = '') {
        const limpo = this._requireNome(nome, 'nome do roteiro');
        if (this._roteiroExiste(limpo)) throw new Error(`Já existe um roteiro chamado "${limpo}".`);
        this.db.run('INSERT INTO roteiros (nome, tipo_residuo, editado_em, chave) VALUES (?, ?, ?, ?)',
            [limpo, String(tipoResiduo || '').trim(), new Date().toISOString(), limpo]);
        this.save();
        return this.getRoteiros().find(r => r.nome === limpo);
    }

    // Renomeia e/ou muda o tipo de resíduo. O nome antigo vira alias para a
    // importação do Access continuar encontrando o roteiro, e todos os pontos
    // dele ficam protegidos contra sobrescrita.
    atualizarRoteiro(id, { nome, tipoResiduo }) {
        const atual = this.getRoteiros().find(r => r.id === Number(id));
        if (!atual) throw new Error('Roteiro não encontrado.');
        const novoNome = nome === undefined ? atual.nome : this._requireNome(nome, 'nome do roteiro');
        const novoTipo = tipoResiduo === undefined ? atual.tipo_residuo : String(tipoResiduo || '').trim();
        if (novoNome === atual.nome && novoTipo === atual.tipo_residuo) return atual;
        if (novoNome !== atual.nome && this._roteiroExiste(novoNome, atual.id)) {
            throw new Error(`Já existe um roteiro chamado "${novoNome}".`);
        }
        const agora = new Date().toISOString();
        this._persistAtomic(() => {
            this.db.run('UPDATE roteiros SET nome = ?, tipo_residuo = ?, editado_em = ?, chave = COALESCE(chave, ?) WHERE id = ?',
                [novoNome, novoTipo, agora, atual.nome, atual.id]);
            if (novoNome !== atual.nome) {
                this.db.run('INSERT OR REPLACE INTO roteiro_alias (nome_origem, roteiro_id) VALUES (?, ?)',
                    [atual.nome, atual.id]);
                this.db.run('DELETE FROM roteiro_alias WHERE nome_origem = ? COLLATE NOCASE', [novoNome]);
                this.db.run('UPDATE clientes SET editado_em = ? WHERE roteiro_id = ?', [agora, atual.id]);
            }
        });
        return this.getRoteiros().find(r => r.id === atual.id);
    }

    proximaOrdemRoteiro(roteiroId) {
        const res = this.db.exec(
            "SELECT MAX(CAST(REPLACE(TRIM(ordem), ',', '.') AS REAL)) FROM clientes WHERE roteiro_id = ?", [roteiroId]);
        const max = res.length ? Number(res[0].values[0][0]) : 0;
        return Math.floor(Number.isFinite(max) ? max : 0) + 1;
    }

    // Pontos criados no app recebem ids "APP-n", que nunca colidem com os ids
    // numéricos do Access.
    gerarIdRotaApp() {
        const res = this.db.exec(
            "SELECT MAX(CAST(SUBSTR(id_rota, 5) AS INTEGER)) FROM clientes WHERE id_rota LIKE 'APP-%'");
        const max = res.length ? Number(res[0].values[0][0]) : 0;
        return `APP-${(Number.isFinite(max) ? max : 0) + 1}`;
    }

    criarPonto({ idRota, cliente, logradouro, numero, complemento, cep, telefone1, telefone2, roteiroId, ordem, ativo = true }) {
        const nome = this._requireNome(cliente, 'nome do cliente');
        if (!this.getRoteiros().some(r => r.id === Number(roteiroId))) throw new Error('Selecione um roteiro.');
        const id = String(idRota || '').trim() || this.gerarIdRotaApp();
        if (this.getClienteByIdRota(id)) throw new Error(`Já existe um ponto com o ID Rota "${id}".`);
        this.upsertCliente({
            idRota: id, idCliente: '', Cliente: nome, logradouro: logradouro || '', Número: numero || '',
            Complemento: complemento || '', CEP: cep || '', Telefone1: telefone1 || '', Telefone2: telefone2 || '',
            roteiro_id: Number(roteiroId),
            Ordem: ordem === undefined || ordem === '' ? this.proximaOrdemRoteiro(roteiroId) : ordem,
            ativo
        }, { origemApp: true });
        return id;
    }

    // Só exclui pontos sem histórico de coleta; os demais devem ser inativados
    // para não quebrar relatórios. A exclusão fica registrada para a
    // importação do Access não recriar o ponto.
    excluirPonto(idRota) {
        const id = String(idRota);
        if (!this.getClienteByIdRota(id)) throw new Error('Ponto não encontrado.');
        const coletas = this.db.exec('SELECT COUNT(*) FROM coletas WHERE id_rota = ?', [id]);
        if (coletas.length && Number(coletas[0].values[0][0]) > 0) {
            throw new Error('Este ponto já tem coletas registradas. Inative-o em vez de excluir.');
        }
        this._persistAtomic(() => {
            this.db.run('DELETE FROM roteiro_change_outbox WHERE id_rota = ? AND sent_at IS NULL', [id]);
            this.db.run('DELETE FROM clientes WHERE id_rota = ?', [id]);
            this.db.run('INSERT OR REPLACE INTO cliente_excluido (id_rota, excluido_em) VALUES (?, ?)',
                [id, new Date().toISOString()]);
        });
    }

    // Marca pontos como editados no app (ordem, status, etc.).
    marcarPontosEditados(idRotas) {
        const agora = new Date().toISOString();
        [].concat(idRotas).forEach(id =>
            this.db.run('UPDATE clientes SET editado_em = ? WHERE id_rota = ?', [agora, String(id)]));
        this.save();
    }

    // CSV no mesmo formato do export do Access, para devolver ao legado.
    exportRoteirosCsv() {
        const header = ['Fonte', 'idRota', 'Inativo', 'Ordem', 'Roteiro', 'Cliente', 'logradouro',
            'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2', 'TipoResiduo'];
        const res = this.db.exec(`
            SELECT c.id_rota, c.ativo, c.ordem, r.nome, c.cliente, c.logradouro, c.numero, c.cep,
                   c.complemento, c.telefone1, c.telefone2, COALESCE(r.tipo_residuo, '')
            FROM clientes c JOIN roteiros r ON r.id = c.roteiro_id
            ORDER BY r.nome COLLATE NOCASE, CAST(REPLACE(TRIM(c.ordem), ',', '.') AS REAL), c.id_rota`);
        const campo = value => {
            const text = String(value ?? '');
            return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const linhas = (res.length ? res[0].values : []).map(v => {
            const [idRota, ativo, ordem, roteiro, cliente, logradouro, numero, cep, complemento, t1, t2, tipo] = v;
            const ordemNum = this._normalizeOrdem(ordem);
            const fonte = `${roteiro}-${ordemNum}`;
            return [fonte, idRota, ativo ? 0 : 1, ordemNum.toFixed(2).replace('.', ','), roteiro, cliente,
                logradouro, numero, cep, complemento, t1, t2, tipo].map(campo).join(';');
        });
        return [header.join(';'), ...linhas].join('\r\n');
    }

    downloadRoteirosCsv() {
        // BOM para o Excel/Access abrirem os acentos corretamente.
        const blob = new Blob(['\uFEFF', this.exportRoteirosCsv()], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `satelite_roteiros_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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

    importRoteirosCsv(csvText, options) {
        const cleanText = String(csvText || '').replace(/^\uFEFF/, '');
        const results = Papa.parse(cleanText, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: true
        });
        return this.importRoteirosRows(results.data, options);
    }

    // Importa a partir de linhas achatadas ja em objeto (mesmas colunas do CSV).
    // Usado tanto pelo import manual de CSV quanto pela sincronizacao com o
    // Sheets (action=roteiros), que entrega as linhas direto em JSON.
    //
    // O app é o dono do cadastro: pontos criados/editados aqui (editado_em) e
    // pontos excluídos aqui nunca são tocados pela importação, a menos que
    // { sobrescreverEditados: true } seja pedido explicitamente (importação
    // manual com a opção marcada). Linhas preservadas vão em `preservados`.
    importRoteirosRows(dataRows, { sobrescreverEditados = false } = {}) {
        const rows = Array.isArray(dataRows) ? dataRows : [];

        const comOrdemValida = rows.filter(row => {
            const ordem = this._getCsvVal(row, 'Ordem');
            if (ordem === null || ordem === undefined || ordem === '') return false;
            // Number() nao entende decimal com virgula (formato do export do
            // Access, ex: "0,00") e vira NaN — que passaria no !== 0 sem
            // querer. _normalizeOrdem trata a virgula antes de comparar.
            return this._normalizeOrdem(ordem) !== 0;
        });

        const porIdRota = new Map();
        const idRotasConflitantes = new Set();
        comOrdemValida.forEach(row => {
            const id = String(this._getCsvVal(row, 'idRota') || this._getCsvVal(row, 'id Rota') || '').trim();
            if (!id) return;
            const anterior = porIdRota.get(id);
            if (anterior) {
                const assinatura = value => JSON.stringify(Object.entries(value)
                    .map(([key, item]) => [key.trim().toLocaleLowerCase('pt-BR'), item])
                    .sort(([a], [b]) => a.localeCompare(b)));
                // O export do Access as vezes traz o mesmo idRota em duas linhas
                // divergindo SO no telefone (mesma ordem/roteiro/cliente/logradouro).
                // Antes isso lancava e abortava o CSV inteiro, derrubando todos os
                // pontos por causa de um telefone. Agora aplica last-wins (a
                // estrutura da rota e identica) e apenas registra o idRota para
                // revisao na origem — reportado em conflitosIdRota.
                if (assinatura(anterior) !== assinatura(row)) {
                    idRotasConflitantes.add(id);
                }
            }
            porIdRota.set(id, row);
        });
        const data = [...porIdRota.values()];

        const uniqueRoteiros = [...new Set(data.map(r => this._getCsvVal(r, 'Roteiro')).filter(Boolean))];
        const tipoResiduoPorRoteiro = {};
        data.forEach(row => {
            const nome = this._getCsvVal(row, 'Roteiro');
            if (nome && !(nome in tipoResiduoPorRoteiro)) {
                tipoResiduoPorRoteiro[nome] = this._getCsvVal(row, 'TipoResiduo') ||
                    this._getCsvVal(row, 'Tipo de Resíduo') || '';
            }
        });
        // Nomes de roteiros renomeados no app continuam apontando para o
        // roteiro renomeado, em vez de recriar o nome antigo.
        const aliasRes = this.db.exec('SELECT nome_origem, roteiro_id FROM roteiro_alias');
        const aliases = new Map(aliasRes.length ? aliasRes[0].values.map(v => [v[0], v[1]]) : []);
        uniqueRoteiros.filter(name => !aliases.has(name))
            .forEach(name => this._upsertRoteiroImportado(name, tipoResiduoPorRoteiro[name] || '', sobrescreverEditados));

        const roteiros = this.getRoteiros();
        const routeMap = {};
        roteiros.forEach(r => routeMap[r.nome] = r.id);
        aliases.forEach((id, nome) => { routeMap[nome] = id; });

        const editadosRes = this.db.exec('SELECT id_rota FROM clientes WHERE editado_em IS NOT NULL');
        const editados = new Set(editadosRes.length ? editadosRes[0].values.map(v => String(v[0])) : []);
        const excluidosRes = this.db.exec('SELECT id_rota FROM cliente_excluido');
        const excluidos = new Set(excluidosRes.length ? excluidosRes[0].values.map(v => String(v[0])) : []);

        // Preserva localmente qualquer id_rota/id_cliente com alteração ainda
        // não enviada ao Sheets (fila de push): sem isso, um import automático
        // (que roda a cada abertura do app) reverteria silenciosamente uma
        // reordenação de rota ou edição de cliente feita no app antes dela
        // ser sincronizada.
        const idRotasPendentes = this._getPendingRoteiroIdRotas();
        const idClientesPendentes = this._getPendingClienteIds();

        let clientesCount = 0;
        let pulados = 0;
        let preservados = 0;
        data.forEach(row => {
            const idRota = this._getCsvVal(row, 'idRota') || this._getCsvVal(row, 'id Rota');
            const clienteNome = this._getCsvVal(row, 'Cliente');
            const roteiroName = this._getCsvVal(row, 'Roteiro');

            if (!idRota || !clienteNome) return;

            const idRotaStr = idRota.toString();
            if (!sobrescreverEditados && (editados.has(idRotaStr) || excluidos.has(idRotaStr))) { preservados++; return; }
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
            if (sobrescreverEditados) {
                this.db.run('UPDATE clientes SET editado_em = NULL WHERE id_rota = ?', [idRotaStr]);
                this.db.run('DELETE FROM cliente_excluido WHERE id_rota = ?', [idRotaStr]);
            }
            clientesCount++;
        });

        return {
            roteiros: uniqueRoteiros.length,
            clientes: clientesCount,
            pulados,
            preservados,
            conflitosIdRota: [...idRotasConflitantes]
        };
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
            roteiro: this._roteiroChave(cliente.roteiro_id) || cliente.roteiro_nome,
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
        this.db.run('UPDATE clientes SET editado_em = ? WHERE id_cliente = ?', [new Date().toISOString(), id]);
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

    // --- Campanhas de WhatsApp ---
    _queryRows(sql, params = []) {
        const res = this.db.exec(sql, params);
        if (!res.length) return [];
        return res[0].values.map(values => Object.fromEntries(
            res[0].columns.map((column, index) => [column, values[index]])
        ));
    }

    _readWhatsappCampaignItem(row) {
        return {
            itemId: row.item_id,
            occurrenceId: row.occurrence_id,
            idRota: row.id_rota,
            cliente: row.cliente_snapshot,
            roteiro: row.roteiro_snapshot,
            coletaData: row.coleta_data,
            intercorrencia: row.intercorrencia_snapshot,
            message: row.message_snapshot,
            phones: JSON.parse(row.phones_snapshot),
            status: row.status,
            phoneSlot: row.phone_slot,
            phone: row.phone_snapshot,
            openedAt: row.opened_at,
            confirmedAt: row.confirmed_at
        };
    }

    _readWhatsappCampaign(row) {
        const campaign = {
            campaignId: row.campaign_id,
            messageTemplate: row.message_template,
            status: row.status,
            createdAt: row.created_at,
            items: this._queryRows(`
                SELECT * FROM whatsapp_campaign_items
                WHERE campaign_id = ? ORDER BY rowid
            `, [row.campaign_id]).map(item => this._readWhatsappCampaignItem(item))
        };
        if (row.completed_at) campaign.completedAt = row.completed_at;
        return campaign;
    }

    _requireWhatsappId(value, label) {
        const normalized = String(value ?? '').trim();
        if (!normalized) throw new Error(`${label} obrigatório`);
        return normalized;
    }

    _requireWhatsappTimestamp(value, label) {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized || !Number.isFinite(Date.parse(normalized))) {
            throw new Error(`${label} inválido`);
        }
        return new Date(normalized).toISOString();
    }

    _requireCivilDate(value) {
        const day = typeof value === 'string' ? value : '';
        const date = new Date(`${day}T12:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) ||
            date.toISOString().slice(0, 10) !== day) {
            throw new Error('Data de coleta inválida');
        }
        return day;
    }

    _normalizeWhatsappCampaignInput(input) {
        if (!input || typeof input !== 'object') throw new Error('Campanha inválida');
        const campaignId = this._requireWhatsappId(input.campaignId, 'ID da campanha');
        const messageTemplate = String(input.messageTemplate ?? '').trim();
        if (!messageTemplate) throw new Error('Modelo de mensagem obrigatório');
        const createdAt = this._requireWhatsappTimestamp(input.createdAt, 'Data de criação');
        if (!Array.isArray(input.items) || !input.items.length) {
            throw new Error('Campanha deve conter itens');
        }
        const items = input.items.map(source => {
            if (!source || typeof source !== 'object') throw new Error('Item de campanha inválido');
            if (!Array.isArray(source.phones)) throw new Error('Telefones do item devem ser um array');
            const phones = source.phones.map(phone => {
                if (!phone || !Number.isInteger(phone.slot) || phone.slot < 1 ||
                    !String(phone.digits ?? '').trim()) {
                    throw new Error('Telefone de campanha inválido');
                }
                return {
                    slot: phone.slot,
                    exibicao: String(phone.exibicao ?? ''),
                    digits: String(phone.digits).trim()
                };
            });
            return {
                itemId: this._requireWhatsappId(source.itemId, 'ID do item'),
                occurrenceId: this._requireWhatsappId(source.occurrenceId, 'ID da ocorrência'),
                idRota: this._requireWhatsappId(source.idRota, 'ID da rota'),
                cliente: String(source.cliente ?? ''),
                roteiro: String(source.roteiro ?? ''),
                coletaData: this._requireCivilDate(source.coletaData),
                intercorrencia: String(source.intercorrencia ?? ''),
                message: String(source.message ?? ''),
                phones
            };
        });
        if (new Set(items.map(item => item.itemId)).size !== items.length) {
            throw new Error('ID de item duplicado na campanha');
        }
        return { campaignId, messageTemplate, createdAt, items };
    }

    createWhatsappCampaign(input) {
        const campaign = this._normalizeWhatsappCampaignInput(input);
        return this._persistAtomic(() => {
            if (this._queryRows("SELECT campaign_id FROM whatsapp_campaigns WHERE status = 'active'").length) {
                throw new Error('Já existe uma campanha ativa');
            }
            if (this._queryRows('SELECT campaign_id FROM whatsapp_campaigns WHERE campaign_id = ?', [campaign.campaignId]).length) {
                throw new Error('ID de campanha já utilizado');
            }
            this.db.run(`
                INSERT INTO whatsapp_campaigns
                    (campaign_id, message_template, status, created_at)
                VALUES (?, ?, 'active', ?)
            `, [campaign.campaignId, campaign.messageTemplate, campaign.createdAt]);
            campaign.items.forEach(item => {
                this.db.run(`
                    INSERT INTO whatsapp_campaign_items
                        (item_id, campaign_id, occurrence_id, id_rota, cliente_snapshot,
                         roteiro_snapshot, coleta_data, intercorrencia_snapshot,
                         message_snapshot, phones_snapshot, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                `, [
                    item.itemId, campaign.campaignId, item.occurrenceId, item.idRota,
                    item.cliente, item.roteiro, item.coletaData, item.intercorrencia,
                    item.message, JSON.stringify(item.phones)
                ]);
            });
            return this._readWhatsappCampaign(this._queryRows(
                'SELECT * FROM whatsapp_campaigns WHERE campaign_id = ?', [campaign.campaignId]
            )[0]);
        });
    }

    getActiveWhatsappCampaign() {
        const rows = this._queryRows(
            "SELECT * FROM whatsapp_campaigns WHERE status = 'active' LIMIT 1"
        );
        return rows.length ? this._readWhatsappCampaign(rows[0]) : null;
    }

    transitionWhatsappCampaignItem(itemId, status, details = {}) {
        const normalizedId = this._requireWhatsappId(itemId, 'ID do item');
        const allowed = {
            pending: new Set(['opened', 'deferred']),
            deferred: new Set(['opened']),
            opened: new Set(['confirmed', 'deferred']),
            confirmed: new Set(['confirmed'])
        };
        if (!['opened', 'deferred', 'confirmed'].includes(status)) {
            throw new Error('Status de campanha inválido');
        }
        return this._persistAtomic(() => {
            const rows = this._queryRows(`
                SELECT i.* FROM whatsapp_campaign_items i
                JOIN whatsapp_campaigns c ON c.campaign_id = i.campaign_id
                WHERE i.item_id = ? AND c.status = 'active'
            `, [normalizedId]);
            if (!rows.length) throw new Error('Item de campanha ativa não encontrado');
            const current = rows[0];
            if (!allowed[current.status] || !allowed[current.status].has(status)) {
                throw new Error(`Transição de status inválida: ${current.status} -> ${status}`);
            }
            if (current.status === 'confirmed' && status === 'confirmed') {
                return this._readWhatsappCampaignItem(current);
            }
            if (status === 'opened') {
                const selectedPhone = JSON.parse(current.phones_snapshot).find(phone =>
                    phone.slot === details.phoneSlot && phone.digits === details.phone
                );
                if (!selectedPhone) throw new Error('Telefone de abertura não pertence ao item');
                const openedAt = this._requireWhatsappTimestamp(details.at, 'Data de abertura');
                this.db.run(`
                    UPDATE whatsapp_campaign_items
                    SET status = 'opened', phone_slot = ?, phone_snapshot = ?, opened_at = ?
                    WHERE item_id = ?
                `, [selectedPhone.slot, selectedPhone.digits, openedAt, normalizedId]);
            } else if (status === 'confirmed') {
                const confirmedAt = this._requireWhatsappTimestamp(details.at, 'Data de confirmação');
                this.db.run(`
                    UPDATE whatsapp_campaign_items
                    SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?)
                    WHERE item_id = ?
                `, [confirmedAt, normalizedId]);
            } else {
                this.db.run(
                    "UPDATE whatsapp_campaign_items SET status = 'deferred' WHERE item_id = ?",
                    [normalizedId]
                );
            }
            return this._readWhatsappCampaignItem(this._queryRows(
                'SELECT * FROM whatsapp_campaign_items WHERE item_id = ?', [normalizedId]
            )[0]);
        });
    }

    completeWhatsappCampaign(campaignId, completedAt) {
        const normalizedId = this._requireWhatsappId(campaignId, 'ID da campanha');
        const normalizedCompletedAt = this._requireWhatsappTimestamp(completedAt, 'Data de conclusão');
        this._persistAtomic(() => {
            const campaigns = this._queryRows(
                "SELECT campaign_id FROM whatsapp_campaigns WHERE campaign_id = ? AND status = 'active'",
                [normalizedId]
            );
            if (!campaigns.length) throw new Error('Campanha ativa não encontrada');
            const pending = this._queryRows(`
                SELECT item_id FROM whatsapp_campaign_items
                WHERE campaign_id = ? AND status = 'pending' LIMIT 1
            `, [normalizedId]);
            if (pending.length) throw new Error('Itens pending impedem concluir a campanha');
            this.db.run(`
                UPDATE whatsapp_campaigns
                SET status = 'completed', completed_at = ?
                WHERE campaign_id = ?
            `, [normalizedCompletedAt, normalizedId]);
        });
    }

    getConfirmedWhatsappOccurrenceIds() {
        return this._queryRows(`
            SELECT DISTINCT occurrence_id FROM whatsapp_campaign_items
            WHERE status = 'confirmed' ORDER BY occurrence_id
        `).map(row => row.occurrence_id);
    }

    getWhatsappCampaignHistory() {
        return this._queryRows(`
            SELECT * FROM whatsapp_campaigns
            WHERE status = 'completed' ORDER BY created_at DESC, campaign_id
        `).map(campaign => this._readWhatsappCampaign(campaign));
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
        return this._persistAtomic(() => this._insertColeta(coleta));
    }

    _validateColeta(coleta) {
        if (!String(coleta.id_rota ?? '').trim()) throw new Error('ID do ponto obrigatório');
        if (!Number.isSafeInteger(coleta.quantidade) || coleta.quantidade < 0) {
            throw new Error('Quantidade deve ser um inteiro não negativo');
        }
        const day = typeof coleta.data === 'string' ? coleta.data : '';
        const date = new Date(`${day}T12:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) ||
            date.toISOString().slice(0, 10) !== day) {
            throw new Error('Data de coleta inválida');
        }
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date()).map(part => [part.type, part.value]));
        if (day > `${parts.year}-${parts.month}-${parts.day}`) {
            throw new Error('Data de coleta futura não permitida');
        }
    }

    _insertColeta(coleta) {
        this._validateColeta(coleta);
        const syncId = coleta.sync_id || this._newChangeId();
        const context = this.getClienteByIdRota(String(coleta.id_rota));
        this.db.run(`
            INSERT INTO coletas
                (id_rota, data, quantidade, intercorrencia, sync_id, operation_id,
                 cliente_snapshot, roteiro_snapshot, context_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'event')
        `, [
            String(coleta.id_rota), coleta.data, coleta.quantidade,
            coleta.intercorrencia || '', syncId, coleta.operation_id || null,
            coleta.cliente ?? context?.cliente ?? '',
            coleta.roteiro ?? context?.roteiro_nome ?? ''
        ]);
        return this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    }

    saveColetaOperation({ operationId, data, roteiro, entries }) {
        if (!String(operationId || '').trim() || !Array.isArray(entries) || !entries.length) {
            throw new Error('Operação sem identidade ou registros');
        }
        const normalized = entries.map(entry => ({
            id_rota: String(entry.id_rota ?? '').trim(), data,
            quantidade: entry.quantidade, intercorrencia: entry.intercorrencia || '',
            cliente: entry.cliente ?? '', roteiro: roteiro || '',
            sync_id: entry.sync_id || `${operationId}:${entry.id_rota}`,
            operation_id: operationId
        })).sort((a, b) => a.id_rota.localeCompare(b.id_rota, 'pt-BR', { numeric: true }));
        normalized.forEach(entry => this._validateColeta(entry));
        if (new Set(normalized.map(entry => entry.id_rota)).size !== normalized.length ||
            new Set(normalized.map(entry => entry.sync_id)).size !== normalized.length) {
            throw new Error('Ponto ou identificador duplicado na operação');
        }
        const payload = JSON.stringify(normalized);
        const previous = this.db.exec(
            'SELECT payload FROM coleta_operations WHERE operation_id = ?', [operationId]
        );
        if (previous.length) {
            if (previous[0].values[0][0] !== payload) {
                throw new Error('Operação já salva com conteúdo diferente');
            }
        } else {
            this._persistAtomic(() => {
                normalized.forEach(entry => {
                    if (this.db.exec('SELECT id FROM coletas WHERE sync_id = ?', [entry.sync_id]).length) {
                        throw new Error('Conflito de identificador de coleta');
                    }
                    this._insertColeta(entry);
                });
                this.db.run(
                    'INSERT INTO coleta_operations (operation_id, payload) VALUES (?, ?)',
                    [operationId, payload]
                );
            });
        }
        const result = this.db.exec(
            'SELECT id, sync_id, id_rota FROM coletas WHERE operation_id = ? ORDER BY id',
            [operationId]
        );
        return result.length ? result[0].values.map(([id, sync_id, id_rota]) => ({ id, sync_id, id_rota })) : [];
    }

    getUltimaQuantidade(idRota) {
        const res = this.db.exec(
            "SELECT quantidade FROM coletas WHERE id_rota = ? ORDER BY data DESC, id DESC LIMIT 1",
            [String(idRota)]
        );
        if (!res.length || !res[0].values.length) return null;
        return res[0].values[0][0];
    }

    getColetasByDate(data) {
        const res = this.db.exec(`
            SELECT c.*, COALESCE(c.cliente_snapshot, cl.cliente, '') AS cliente
            FROM coletas c
            LEFT JOIN clientes cl ON c.id_rota = cl.id_rota
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
        this.markColetasSynced([{ id, sync_id: syncId }]);
    }

    markColetasSynced(coletas) {
        this._persistAtomic(() => {
            const syncedAt = new Date().toISOString();
            coletas.forEach(coleta => {
                const current = this.db.exec('SELECT sync_id FROM coletas WHERE id = ?', [coleta.id]);
                if (!current.length || current[0].values[0][0] !== coleta.sync_id) {
                    throw new Error('Identidade da coleta mudou durante o envio');
                }
                this.db.run('UPDATE coletas SET last_sync = ? WHERE id = ?', [syncedAt, coleta.id]);
            });
        });
    }

    ensureColetaSyncId(id) {
        const row = this.db.exec('SELECT sync_id FROM coletas WHERE id = ?', [id]);
        if (!row.length) throw new Error('Coleta não encontrada');
        const existing = row[0].values[0][0];
        if (existing) return existing;
        const syncId = this._newChangeId();
        this._persistAtomic(() => {
            this.db.run('UPDATE coletas SET sync_id = ? WHERE id = ?', [syncId, id]);
        });
        return syncId;
    }

    getUnsyncedColetas() {
        const res = this.db.exec(`
            SELECT c.id, c.id_rota, c.data, c.quantidade, c.intercorrencia,
                COALESCE(c.cliente_snapshot, cl.cliente, '') AS cliente,
                COALESCE(c.roteiro_snapshot, r.nome, '') AS roteiro, c.sync_id
            FROM coletas c
            LEFT JOIN clientes cl ON c.id_rota = cl.id_rota
            LEFT JOIN roteiros r ON cl.roteiro_id = r.id
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
// Usado pelo upload manual do CSV no Admin.
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

// UUID v4 com fallback para origens inseguras (http://IP-da-LAN): o
// crypto.randomUUID só existe em contexto seguro (HTTPS/localhost); sem o
// fallback, telas inteiras quebram com TypeError ao servir o app por IP.
export function newUuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
        const random = Math.floor(Math.random() * 16);
        const value = char === 'x' ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

const db = new AppDatabase();
export default db;
