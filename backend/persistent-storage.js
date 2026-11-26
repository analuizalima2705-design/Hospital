const mysql = require("mysql");
const legacyData = require("./db.json");

const configured = Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
const pool = configured ? mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 2),
  waitForConnections: true,
  queueLimit: 10,
  timezone: "Z",
  supportBigNumbers: true,
  bigNumberStrings: true,
  ssl: process.env.DB_SSL === "true"
    ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
    : undefined
}) : null;

let readyPromise;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS storage_migrations (
    migration_key VARCHAR(100) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS inventory (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    categoria VARCHAR(120) NOT NULL DEFAULT '',
    unidade VARCHAR(60) NOT NULL DEFAULT '',
    quantidade INT UNSIGNED NOT NULL,
    UNIQUE KEY uq_inventory_nome (nome)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS prescriptions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    triage_id BIGINT UNSIGNED NULL,
    paciente VARCHAR(255) NOT NULL,
    diagnostico TEXT NOT NULL,
    medicacao VARCHAR(255) NOT NULL,
    quantidade INT UNSIGNED NULL,
    medico VARCHAR(120) NULL,
    observacao TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    dispensado TINYINT(1) NOT NULL DEFAULT 0,
    dispensado_at DATETIME(3) NULL,
    UNIQUE KEY uq_prescription_triage (triage_id),
    KEY idx_prescriptions_created (created_at, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS inventory_movements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(10) NOT NULL,
    medicamento_id BIGINT UNSIGNED NULL,
    nome VARCHAR(255) NOT NULL,
    quantidade INT UNSIGNED NOT NULL,
    paciente VARCHAR(255) NULL,
    medico VARCHAR(120) NULL,
    consulta_id BIGINT UNSIGNED NULL,
    observacao TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_movement_prescription (consulta_id, tipo),
    KEY idx_movements_created (created_at, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function query(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (error, result) => error ? reject(error) : resolve(result));
  });
}

function acquireConnection() {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => error ? reject(error) : resolve(connection));
  });
}

function beginTransaction(connection) {
  return new Promise((resolve, reject) => {
    connection.beginTransaction(error => error ? reject(error) : resolve());
  });
}

function commit(connection) {
  return new Promise((resolve, reject) => {
    connection.commit(error => error ? reject(error) : resolve());
  });
}

function rollback(connection) {
  return new Promise(resolve => connection.rollback(() => resolve()));
}

async function transaction(operation) {
  const connection = await acquireConnection();
  try {
    await beginTransaction(connection);
    const result = await operation(connection);
    await commit(connection);
    return result;
  } catch (error) {
    await rollback(connection);
    if (error.code === "ER_DUP_ENTRY") {
      throw new StorageError(409, "Esta operação já foi registrada.");
    }
    throw error;
  } finally {
    connection.release();
  }
}

function mysqlDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new StorageError(400, "A data do registro é inválida.");
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredId(value) {
  const id = String(value ?? "");
  if (!/^\d+$/.test(id) || BigInt(id) <= 0n) {
    throw new StorageError(400, "Identificador inválido.");
  }
  return id;
}

function legacyId(value, fallback) {
  const id = String(value ?? "");
  return /^\d+$/.test(id) && BigInt(id) > 0n ? id : String(fallback);
}

function getLegacyData() {
  const data = legacyData;
  return {
    estoque: Array.isArray(data.estoque) ? data.estoque : [],
    entradasEstoque: Array.isArray(data.entradasEstoque) ? data.entradasEstoque : [],
    consultas: Array.isArray(data.consultas) ? data.consultas : []
  };
}

async function migrateLegacyData() {
  const data = getLegacyData();
  await transaction(async connection => {
    const migration = await query(connection,
      "INSERT IGNORE INTO storage_migrations (migration_key) VALUES (?)",
      ["json-data-to-mysql-v1"]);
    if (migration.affectedRows === 0) return;

    for (const [index, item] of data.estoque.entries()) {
      const quantity = Number(item.quantidade);
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new Error(`Quantidade inválida no estoque legado (registro ${index + 1}).`);
      }
      if (!String(item.nome || "").trim()) {
        throw new Error(`Nome ausente no estoque legado (registro ${index + 1}).`);
      }
      await query(connection,
        "INSERT IGNORE INTO inventory (id, nome, categoria, unidade, quantidade) VALUES (?, ?, ?, ?, ?)",
        [
          legacyId(item.id, Date.now() + index),
          String(item.nome || "Medicamento"),
          String(item.categoria || ""),
          String(item.unidade || ""),
          quantity
        ]);
    }

    for (const [index, item] of data.consultas.entries()) {
      const quantity = Number(item.quantidade);
      const validQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : null;
      const triageId = /^\d+$/.test(String(item.triagemId || "")) ? String(item.triagemId) : null;
      await query(connection,
        `INSERT IGNORE INTO prescriptions
          (id, triage_id, paciente, diagnostico, medicacao, quantidade, medico, observacao, created_at, dispensado, dispensado_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          legacyId(item.id, Date.now() + index),
          triageId,
          String(item.paciente || "Paciente sem nome"),
          String(item.diagnostico || ""),
          String(item.medicacao || ""),
          validQuantity,
          item.medico ? String(item.medico) : null,
          String(item.obs || ""),
          mysqlDate(item.createdAt),
          item.dispensado ? 1 : 0,
          item.dispensadoAt ? mysqlDate(item.dispensadoAt) : null
        ]);
    }

    for (const [index, item] of data.entradasEstoque.entries()) {
      const quantity = Number(item.quantidade);
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error(`Quantidade inválida no histórico legado (registro ${index + 1}).`);
      }
      if (item.tipo && !["entrada", "saida"].includes(item.tipo)) {
        throw new Error(`Tipo de movimentação inválido no histórico legado (registro ${index + 1}).`);
      }
      const type = item.tipo === "saida" ? "saida" : "entrada";
      await query(connection,
        `INSERT IGNORE INTO inventory_movements
          (id, tipo, medicamento_id, nome, quantidade, paciente, medico, consulta_id, observacao, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          legacyId(item.id, Date.now() + index),
          type,
          item.medicamentoId ? legacyId(item.medicamentoId, Date.now() + index) : null,
          String(item.nome || "Medicamento"),
          quantity,
          item.paciente ? String(item.paciente) : null,
          item.medico ? String(item.medico) : null,
          item.consultaId ? legacyId(item.consultaId, Date.now() + index) : null,
          String(item.observacao || ""),
          mysqlDate(item.createdAt)
        ]);
    }
  });
}

async function initialize() {
  for (const statement of schemaStatements) await query(pool, statement);
  await migrateLegacyData();
}

function ensureReady() {
  if (!configured) return Promise.resolve();
  if (!readyPromise) {
    readyPromise = initialize().catch(error => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

function inventoryRow(row) {
  return {
    id: String(row.id),
    nome: row.nome,
    categoria: row.categoria || "",
    unidade: row.unidade || "",
    quantidade: Number(row.quantidade)
  };
}

function prescriptionRow(row) {
  return {
    id: String(row.id),
    triagemId: row.triage_id == null ? undefined : String(row.triage_id),
    paciente: row.paciente,
    diagnostico: row.diagnostico || "",
    medicacao: row.medicacao,
    quantidade: row.quantidade == null ? undefined : Number(row.quantidade),
    medico: row.medico || undefined,
    obs: row.observacao || "",
    createdAt: isoDate(row.created_at),
    dispensado: Boolean(row.dispensado),
    dispensadoAt: isoDate(row.dispensado_at)
  };
}

function movementRow(row) {
  return {
    id: String(row.id),
    tipo: row.tipo,
    medicamentoId: row.medicamento_id == null ? null : String(row.medicamento_id),
    nome: row.nome,
    quantidade: Number(row.quantidade),
    paciente: row.paciente || undefined,
    medico: row.medico || undefined,
    consultaId: row.consulta_id == null ? undefined : String(row.consulta_id),
    observacao: row.observacao || "",
    createdAt: isoDate(row.created_at)
  };
}

async function getInventory() {
  await ensureReady();
  const rows = await query(pool, "SELECT id, nome, categoria, unidade, quantidade FROM inventory ORDER BY nome");
  return rows.map(inventoryRow);
}

async function getPrescriptions() {
  await ensureReady();
  const rows = await query(pool, "SELECT * FROM prescriptions ORDER BY created_at, id");
  return rows.map(prescriptionRow);
}

async function getMovements({ entriesOnly = false, limit } = {}) {
  await ensureReady();
  const conditions = entriesOnly ? "WHERE tipo = 'entrada' " : "";
  const limitClause = Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : "";
  const rows = await query(pool,
    `SELECT * FROM inventory_movements ${conditions}ORDER BY created_at DESC, id DESC ${limitClause}`);
  return rows.map(movementRow);
}

async function createInventory(item) {
  await ensureReady();
  try {
    return await transaction(async connection => {
      const result = await query(connection,
        "INSERT INTO inventory (nome, categoria, unidade, quantidade) VALUES (?, ?, ?, ?)",
        [item.nome, item.categoria, item.unidade, item.quantidade]);
      await query(connection,
        `INSERT INTO inventory_movements
          (tipo, medicamento_id, nome, quantidade, observacao, created_at)
         VALUES ('entrada', ?, ?, ?, 'Cadastro inicial', UTC_TIMESTAMP(3))`,
        [result.insertId, item.nome, item.quantidade]);
      return inventoryRow((await query(connection, "SELECT * FROM inventory WHERE id = ?", [result.insertId]))[0]);
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw new StorageError(409, "Este medicamento já está cadastrado. Use a opção de reposição.");
    throw error;
  }
}

async function addInventory(itemId, quantity, observation) {
  await ensureReady();
  return transaction(async connection => {
    const rows = await query(connection, "SELECT * FROM inventory WHERE id = ? FOR UPDATE", [requiredId(itemId)]);
    if (!rows.length) throw new StorageError(404, "Medicamento não encontrado.");
    const item = inventoryRow(rows[0]);
    const updated = item.quantidade + quantity;
    await query(connection, "UPDATE inventory SET quantidade = ? WHERE id = ?", [updated, item.id]);
    await query(connection,
      `INSERT INTO inventory_movements
        (tipo, medicamento_id, nome, quantidade, observacao, created_at)
       VALUES ('entrada', ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [item.id, item.nome, quantity, observation]);
    return { ...item, quantidade: updated };
  });
}

async function adjustInventory(itemId, adjustment) {
  await ensureReady();
  return transaction(async connection => {
    const rows = await query(connection, "SELECT * FROM inventory WHERE id = ? FOR UPDATE", [requiredId(itemId)]);
    if (!rows.length) throw new StorageError(404, "Medicamento não encontrado.");
    const item = inventoryRow(rows[0]);
    if (item.quantidade + adjustment < 0) {
      throw new StorageError(400, "O ajuste não pode deixar o estoque negativo.");
    }
    const updated = item.quantidade + adjustment;
    await query(connection, "UPDATE inventory SET quantidade = ? WHERE id = ?", [updated, item.id]);
    await query(connection,
      `INSERT INTO inventory_movements
        (tipo, medicamento_id, nome, quantidade, observacao, created_at)
       VALUES (?, ?, ?, ?, 'Ajuste manual', UTC_TIMESTAMP(3))`,
      [adjustment > 0 ? "entrada" : "saida", item.id, item.nome, Math.abs(adjustment)]);
    return { ...item, quantidade: updated };
  });
}

async function deleteInventory(itemId) {
  await ensureReady();
  const result = await query(pool, "DELETE FROM inventory WHERE id = ?", [requiredId(itemId)]);
  if (!result.affectedRows) throw new StorageError(404, "Medicamento não encontrado.");
}

async function createPrescription(consultation) {
  await ensureReady();
  const result = await query(pool,
    `INSERT INTO prescriptions
      (triage_id, paciente, diagnostico, medicacao, quantidade, medico, observacao, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      consultation.triagemId ? requiredId(consultation.triagemId) : null,
      consultation.paciente,
      consultation.diagnostico,
      consultation.medicacao,
      consultation.quantidade,
      consultation.medico,
      consultation.obs
    ]);
  return (await query(pool, "SELECT * FROM prescriptions WHERE id = ?", [result.insertId]))
    .map(prescriptionRow)[0];
}

async function createPrescriptionAndDispense(consultation) {
  await ensureReady();
  const quantity = Number(consultation.quantidade);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new StorageError(400, "A quantidade prescrita deve ser um inteiro maior que zero.");
  }

  return transaction(async connection => {
    const inventoryRows = await query(connection,
      "SELECT * FROM inventory WHERE LOWER(TRIM(nome)) = LOWER(TRIM(?)) LIMIT 1 FOR UPDATE",
      [consultation.medicacao]);
    if (!inventoryRows.length) {
      throw new StorageError(404, `O medicamento "${consultation.medicacao}" não está cadastrado no estoque.`);
    }

    const item = inventoryRow(inventoryRows[0]);
    if (item.quantidade < quantity) {
      throw new StorageError(409,
        `Estoque insuficiente para ${item.nome}. Disponível: ${item.quantidade}; solicitado: ${quantity}.`);
    }

    const createdAt = new Date();
    const createdAtSql = mysqlDate(createdAt);
    const result = await query(connection,
      `INSERT INTO prescriptions
        (triage_id, paciente, diagnostico, medicacao, quantidade, medico, observacao, created_at, dispensado, dispensado_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        consultation.triagemId ? requiredId(consultation.triagemId) : null,
        consultation.paciente,
        consultation.diagnostico,
        consultation.medicacao,
        quantity,
        consultation.medico,
        consultation.obs,
        createdAtSql,
        createdAtSql
      ]);
    const prescriptionId = String(result.insertId);
    const remaining = item.quantidade - quantity;
    await query(connection, "UPDATE inventory SET quantidade = ? WHERE id = ?", [remaining, item.id]);
    await query(connection,
      `INSERT INTO inventory_movements
        (tipo, medicamento_id, nome, quantidade, paciente, medico, consulta_id, observacao, created_at)
       VALUES ('saida', ?, ?, ?, ?, ?, ?, 'Dispensação de prescrição médica', ?)`,
      [item.id, item.nome, quantity, consultation.paciente, consultation.medico, prescriptionId, createdAtSql]);

    const rows = await query(connection, "SELECT * FROM prescriptions WHERE id = ?", [prescriptionId]);
    return prescriptionRow(rows[0]);
  });
}

async function dispensePrescription(prescriptionId) {
  await ensureReady();
  return transaction(async connection => {
    const prescriptionRows = await query(connection,
      "SELECT * FROM prescriptions WHERE id = ? FOR UPDATE",
      [requiredId(prescriptionId)]);
    if (!prescriptionRows.length) throw new StorageError(404, "Prescrição não encontrada.");
    const prescription = prescriptionRow(prescriptionRows[0]);
    if (prescription.dispensado) throw new StorageError(409, "Esta prescrição já foi dispensada.");
    if (!Number.isInteger(prescription.quantidade) || prescription.quantidade < 1) {
      throw new StorageError(400, "A prescrição não possui uma quantidade válida para dispensação.");
    }

    const inventoryRows = await query(connection,
      "SELECT * FROM inventory WHERE LOWER(TRIM(nome)) = LOWER(TRIM(?)) LIMIT 1 FOR UPDATE",
      [prescription.medicacao]);
    if (!inventoryRows.length) {
      throw new StorageError(404, `O medicamento "${prescription.medicacao}" não está cadastrado no estoque.`);
    }
    const item = inventoryRow(inventoryRows[0]);
    if (item.quantidade < prescription.quantidade) {
      throw new StorageError(409,
        `Estoque insuficiente para ${item.nome}. Disponível: ${item.quantidade}; solicitado: ${prescription.quantidade}.`);
    }

    const createdAt = new Date();
    const createdAtSql = mysqlDate(createdAt);
    await query(connection, "UPDATE inventory SET quantidade = ? WHERE id = ?",
      [item.quantidade - prescription.quantidade, item.id]);
    await query(connection,
      "UPDATE prescriptions SET dispensado = 1, dispensado_at = ? WHERE id = ? AND dispensado = 0",
      [createdAtSql, prescription.id]);
    await query(connection,
      `INSERT INTO inventory_movements
        (tipo, medicamento_id, nome, quantidade, paciente, medico, consulta_id, observacao, created_at)
       VALUES ('saida', ?, ?, ?, ?, ?, ?, 'Dispensação de prescrição médica', ?)`,
      [item.id, item.nome, prescription.quantidade, prescription.paciente, prescription.medico, prescription.id, createdAtSql]);

    return {
      consulta: { ...prescription, dispensado: true, dispensadoAt: createdAt.toISOString() },
      medicamento: { ...item, quantidade: item.quantidade - prescription.quantidade }
    };
  });
}

module.exports = {
  configured,
  ensureReady,
  getInventory,
  getPrescriptions,
  getMovements,
  createInventory,
  addInventory,
  adjustInventory,
  deleteInventory,
  createPrescription,
  createPrescriptionAndDispense,
  dispensePrescription,
  StorageError
};
