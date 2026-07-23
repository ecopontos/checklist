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
            this.createTables();
        }
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
                cliente TEXT NOT NULL,
                logradouro TEXT,
                numero TEXT,
                cep TEXT,
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
        `);
        this.save();
    }

    save() {
        const data = this.db.export();
        const array = Array.from(data);
        localStorage.setItem('app3_db', JSON.stringify(array));
    }

    // --- Roteiros ---
    addRoteiro(nome) {
        this.db.run("INSERT OR IGNORE INTO roteiros (nome) VALUES (?)", [nome]);
        this.save();
    }

    getRoteiros() {
        const res = this.db.exec("SELECT * FROM roteiros ORDER BY nome");
        return res.length ? res[0].values.map(v => ({ id: v[0], nome: v[1] })) : [];
    }

    // --- Clientes ---
    upsertCliente(cliente) {
        this.db.run(`
            INSERT INTO clientes (id_rota, cliente, logradouro, numero, cep, roteiro_id, ordem, ativo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_rota) DO UPDATE SET
                cliente = excluded.cliente,
                logradouro = excluded.logradouro,
                numero = excluded.numero,
                cep = excluded.cep,
                roteiro_id = excluded.roteiro_id,
                ordem = excluded.ordem,
                ativo = excluded.ativo
        `, [
            cliente.idRota,
            cliente.Cliente,
            cliente.logradouro,
            this._normalizeNumero(cliente.Número),
            cliente.CEP,
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
        const results = Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: true
        });
        const data = results.data;

        const uniqueRoteiros = [...new Set(data.map(r => this._getCsvVal(r, 'Roteiro')).filter(Boolean))];
        uniqueRoteiros.forEach(name => this.addRoteiro(name));

        const roteiros = this.getRoteiros();
        const routeMap = {};
        roteiros.forEach(r => routeMap[r.nome] = r.id);

        let clientesCount = 0;
        data.forEach(row => {
            const idRota = this._getCsvVal(row, 'idRota') || this._getCsvVal(row, 'id Rota');
            const clienteNome = this._getCsvVal(row, 'Cliente');
            const roteiroName = this._getCsvVal(row, 'Roteiro');

            if (idRota && clienteNome) {
                this.upsertCliente({
                    idRota: idRota.toString(),
                    Cliente: clienteNome,
                    logradouro: this._getCsvVal(row, 'Logradouro') || this._getCsvVal(row, 'Rua') || '',
                    Número: this._getCsvVal(row, 'Número') || this._getCsvVal(row, 'Num') || this._getCsvVal(row, 'Nº') || '',
                    CEP: this._getCsvVal(row, 'CEP') || '',
                    roteiro_id: routeMap[roteiroName],
                    Ordem: this._getCsvVal(row, 'Ordem') || 0,
                    ativo: this._getCsvVal(row, 'Inativo') != 1
                });
                clientesCount++;
            }
        });

        return { roteiros: uniqueRoteiros.length, clientes: clientesCount };
    }

    _getCsvVal(row, name) {
        const key = Object.keys(row).find(k => k.toLowerCase().trim() === name.toLowerCase());
        return key ? row[key] : null;
    }

    // --- Coletas ---
    addColeta(coleta) {
        this.db.run(`
            INSERT INTO coletas (id_rota, data, quantidade, intercorrencia)
            VALUES (?, ?, ?, ?)
        `, [coleta.id_rota, coleta.data, coleta.quantidade, coleta.intercorrencia]);
        const id = this.db.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
        this.save();
        return id;
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
            SELECT c.id, c.id_rota, c.data, c.quantidade, c.intercorrencia, cl.cliente, r.nome as roteiro
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

const db = new AppDatabase();
export default db;
