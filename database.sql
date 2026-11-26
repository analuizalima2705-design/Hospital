-- Configure DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in the deployment
-- environment. For managed databases that require TLS, also set DB_SSL=true.

CREATE TABLE IF NOT EXISTS storage_migrations (
  migration_key VARCHAR(100) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inventory (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  categoria VARCHAR(120) NOT NULL DEFAULT '',
  unidade VARCHAR(60) NOT NULL DEFAULT '',
  quantidade INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_inventory_nome (nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prescriptions (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
