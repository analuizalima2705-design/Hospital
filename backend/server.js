const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const persistentStorage = require("./persistent-storage");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");
const DB_FILE = path.join(ROOT_DIR, "backend", "db.json");

app.use(express.json());
app.use(cors());
app.use(express.static(FRONTEND_DIR));

function usesPersistentData(pathname) {
  return pathname === "/consulta" || pathname === "/medicacoes" ||
    pathname === "/dashboard-summary" ||
    pathname === "/estoque" || pathname.startsWith("/estoque/") ||
    pathname.startsWith("/consultas/");
}

app.use((req, res, next) => {
  if (!usesPersistentData(req.path)) return next();
  if (process.env.VERCEL && !persistentStorage.configured) {
    return res.status(503).json({ erro: "Banco persistente não configurado. Defina DB_HOST, DB_USER e DB_NAME no ambiente da Vercel." });
  }
  if (!persistentStorage.configured) return next();
  persistentStorage.ensureReady()
    .then(next)
    .catch(error => {
      console.error("Falha ao inicializar o banco persistente.", error);
      res.status(503).json({ erro: "Não foi possível conectar ao banco persistente." });
    });
});

function respondStorageError(res, error) {
  if (error.status) return res.status(error.status).json({ erro: error.message });
  console.error("Falha no banco persistente.", error);
  return res.status(500).json({ erro: "Falha ao salvar ou carregar os dados persistentes." });
}

function defaultDB() {
  return {
    usuarios: [
      { usuario: "triagem", senha: "123", tipo: "triagem" },
      { usuario: "medico", senha: "123", tipo: "medico" },
      { usuario: "atendimento", senha: "123", tipo: "atendimento" }
    ],
    pacientes: [],
    triagens: [],
    consultas: [],
    estoque: [],
    entradasEstoque: [],
    tv: { chamada: null, historico: [] }
  };
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB(), null, 2));
  }

  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      usuarios: Array.isArray(data.usuarios) ? data.usuarios : [],
      pacientes: Array.isArray(data.pacientes) ? data.pacientes : [],
      triagens: Array.isArray(data.triagens) ? data.triagens : [],
      consultas: Array.isArray(data.consultas) ? data.consultas : [],
      estoque: Array.isArray(data.estoque) ? data.estoque : [],
      entradasEstoque: Array.isArray(data.entradasEstoque) ? data.entradasEstoque : [],
      tv: data.tv || { chamada: null, historico: [] }
    };
  } catch (error) {
    return defaultDB();
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date).map(part => [part.type, part.value])
  );
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function nextSenha(pacientes, createdAt) {
  const today = localDateKey(createdAt);
  const latest = pacientes.reduce((highest, paciente) => {
    const senha = normalizeString(paciente.senha);
    if (localDateKey(paciente.createdAt) !== today || !/^\d+$/.test(senha)) return highest;
    return Math.max(highest, Number(senha));
  }, 0);
  return String(latest + 1).padStart(3, "0");
}

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.get("/adimin.html", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "adimin.html"));
});

app.post("/login", (req, res) => {
  const db = readDB();
  const usuario = normalizeString(req.body?.usuario || "");
  const senha = normalizeString(req.body?.senha || "");

  const user = db.usuarios.find(u =>
    normalizeString(u.usuario).toLowerCase() === usuario.toLowerCase() &&
    normalizeString(u.senha) === senha
  );

  if (!user) {
    return res.status(401).json({ erro: "Login inválido" });
  }

  res.json({ ...user, senha: undefined });
});

app.get("/dashboard-summary", async (req, res) => {
  const db = readDB();
  let consultasArmazenadas = db.consultas;
  if (persistentStorage.configured) {
    try {
      consultasArmazenadas = await persistentStorage.getPrescriptions();
    } catch (error) {
      return respondStorageError(res, error);
    }
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 6);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    return {
      date,
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      label: new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(date).replace(".", "")
    };
  });
  const dateKey = value => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const weeklyCounts = items => days.map(day => ({
    label: day.label,
    count: items.filter(item => dateKey(item.createdAt) === day.key).length
  }));
  const triagens = weeklyCounts(db.triagens);
  const consultas = weeklyCounts(consultasArmazenadas);
  const todayKey = dateKey(today);
  const riscos = db.triagens.reduce((totals, triagem) => {
    const risco = normalizeString(triagem.risco).toLowerCase();
    if (risco === "vermelho" || risco === "amarelo" || risco === "verde") {
      totals[risco] += 1;
    }
    return totals;
  }, { vermelho: 0, amarelo: 0, verde: 0 });

  res.json({
    stats: {
      usuarios: db.usuarios.length,
      pacientesFila: db.pacientes.filter(p =>
        ["aguardando_atendimento", "em_atendimento", "triagem", "aguardando_triagem", "em_triagem", "triado"].includes(p.status)
      ).length,
      triagensHoje: db.triagens.filter(item => dateKey(item.createdAt) === todayKey).length,
      consultas: consultasArmazenadas.length
    },
    semana: days.map((day, index) => ({
      label: day.label,
      triagens: triagens[index].count,
      consultas: consultas[index].count
    })),
    riscos
  });
});

app.get("/usuarios", (req, res) => {
  const db = readDB();
  res.json(db.usuarios.map(({ usuario, tipo }) => ({ usuario, tipo })));
});

app.post("/usuarios", (req, res) => {
  const db = readDB();
  const usuario = normalizeString(req.body?.usuario || "");
  const senha = normalizeString(req.body?.senha || "");
  const tipo = normalizeString(req.body?.tipo || "");

  if (!usuario || !senha || !tipo) {
    return res.status(400).json({ erro: "Usuário, senha e tipo são obrigatórios." });
  }

  const jaExiste = db.usuarios.some(u => normalizeString(u.usuario).toLowerCase() === usuario.toLowerCase());
  if (jaExiste) {
    return res.status(409).json({ erro: "Usuário já cadastrado." });
  }

  db.usuarios.push({ usuario, senha, tipo });
  writeDB(db);

  res.status(201).json({ usuario, tipo });
});

app.post("/atendimento", (req, res) => {
  const db = readDB();
  const nome = normalizeString(req.body?.nome || "");
  const cpf = normalizeString(req.body?.cpf || "");
  const tipo = normalizeString(req.body?.tipo || "Convenio");

  if (!nome || !cpf) {
    return res.status(400).json({ erro: "Nome e CPF são obrigatórios." });
  }
  if (!["Convenio", "Particular"].includes(tipo)) {
    return res.status(400).json({ erro: "Tipo de atendimento inválido." });
  }

  const createdAt = new Date().toISOString();
  const paciente = {
    id: Date.now(),
    nome,
    cpf,
    tipo,
    senha: nextSenha(db.pacientes, createdAt),
    status: "aguardando_atendimento",
    createdAt
  };

  db.pacientes.push(paciente);
  writeDB(db);

  res.status(201).json(paciente);
});

app.get("/atendimento/fila", (req, res) => {
  const db = readDB();
  const status = normalizeString(req.query.status || "todos");
  const busca = normalizeString(req.query.busca || "").toLocaleLowerCase("pt-BR");
  const buscaNumerica = busca.replace(/\D/g, "");
  const statusPermitidos = [
    "todos",
    "aguardando_atendimento",
    "em_atendimento",
    "triagem",
    "aguardando_triagem",
    "em_triagem",
    "triado"
  ];

  if (!statusPermitidos.includes(status)) {
    return res.status(400).json({ erro: "Filtro de status inválido." });
  }

  const pacientes = db.pacientes.filter(paciente => {
    const statusCorresponde = status === "todos" ||
      (status === "triagem" && ["triagem", "aguardando_triagem"].includes(paciente.status)) ||
      paciente.status === status;
    const nome = normalizeString(paciente.nome).toLocaleLowerCase("pt-BR");
    const cpf = normalizeString(paciente.cpf);
    const cpfNumerico = cpf.replace(/\D/g, "");
    const buscaCorresponde = !busca ||
      nome.includes(busca) ||
      cpf.toLocaleLowerCase("pt-BR").includes(busca) ||
      (buscaNumerica.length > 0 && cpfNumerico.includes(buscaNumerica));

    return statusCorresponde && buscaCorresponde;
  }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  res.json(pacientes);
});

app.put("/atendimento/:id/iniciar", (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);
  const paciente = db.pacientes.find(item => Number(item.id) === id);

  if (!paciente) {
    return res.status(404).json({ erro: "Paciente não encontrado." });
  }
  if (paciente.status !== "aguardando_atendimento") {
    return res.status(409).json({ erro: "Este paciente não está aguardando atendimento no guichê." });
  }

  const now = new Date().toISOString();
  paciente.status = "em_atendimento";
  paciente.atendimentoIniciadoAt = now;

  const chamada = {
    id: Date.now(),
    pacienteId: paciente.id,
    paciente: paciente.nome,
    senha: paciente.senha || null,
    localTipo: "GUICHÊ",
    localNumero: "01",
    createdAt: now
  };
  db.tv = db.tv || { chamada: null, historico: [] };
  db.tv.historico = [chamada, ...(Array.isArray(db.tv.historico) ? db.tv.historico : [])].slice(0, 5);
  db.tv.chamada = chamada;
  writeDB(db);

  res.json(paciente);
});

app.put("/atendimento/:id/finalizar", (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);
  const paciente = db.pacientes.find(item => Number(item.id) === id);

  if (!paciente) {
    return res.status(404).json({ erro: "Paciente não encontrado." });
  }
  if (paciente.status !== "em_atendimento") {
    return res.status(409).json({ erro: "Inicie o atendimento antes de finalizá-lo." });
  }

  paciente.status = "aguardando_triagem";
  paciente.atendimentoFinalizadoAt = new Date().toISOString();
  writeDB(db);

  res.json(paciente);
});

app.get("/pacientes-triagem", (req, res) => {
  const db = readDB();
  const lista = db.pacientes.filter(p => p.status === "triagem" || p.status === "aguardando_triagem");
  res.json(lista);
});

app.put("/chamar-triagem/:id", (req, res) => {
  const db = readDB();
  const id = Number(req.params.id);
  const paciente = db.pacientes.find(p => Number(p.id) === id);

  if (!paciente) {
    return res.status(404).json({ erro: "Paciente não encontrado." });
  }
  if (!["triagem", "aguardando_triagem"].includes(paciente.status)) {
    return res.status(409).json({ erro: "Este paciente não está aguardando triagem." });
  }

  paciente.status = "em_triagem";

  const chamada = {
    id: Date.now(),
    pacienteId: paciente.id,
    paciente: paciente.nome,
    senha: paciente.senha || null,
    localTipo: "GUICHÊ",
    localNumero: "01",
    createdAt: new Date().toISOString()
  };

  db.tv = db.tv || { chamada: null, historico: [] };
  db.tv.historico = [chamada, ...(db.tv.historico || [])].slice(0, 5);
  db.tv.chamada = chamada;
  writeDB(db);

  res.json(paciente);
});

app.get("/tv/chamada", (req, res) => {
  const db = readDB();
  const publicCall = chamada => chamada ? {
    id: chamada.id,
    senha: chamada.senha || null,
    localTipo: chamada.localTipo || "Guichê",
    localNumero: chamada.localNumero || "--",
    createdAt: chamada.createdAt || null
  } : null;

  res.json({
    chamada: publicCall(db.tv?.chamada),
    historico: (Array.isArray(db.tv?.historico) ? db.tv.historico : []).map(publicCall)
  });
});

app.post("/tv/equipe", (req, res) => {
  const db = readDB();
  const usuario = normalizeString(req.body?.usuario || "").toLowerCase();
  const senha = normalizeString(req.body?.senha || "");
  const equipe = db.usuarios.find(item =>
    normalizeString(item.usuario).toLowerCase() === usuario &&
    normalizeString(item.senha) === senha &&
    ["triagem", "medico", "atendimento"].includes(item.tipo)
  );

  if (!equipe) {
    return res.status(401).json({ erro: "Acesso restrito à equipe. Confira usuário e senha." });
  }

  const dadosPaciente = chamada => {
    if (!chamada) return null;
    const paciente = db.pacientes.find(item =>
      chamada.pacienteId != null && Number(item.id) === Number(chamada.pacienteId)
    );
    const triagens = paciente
      ? db.triagens
        .filter(item => Number(item.pacienteId) === Number(paciente.id))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      : [];

    return {
      id: chamada.id,
      paciente: paciente?.nome || chamada.paciente || "Paciente",
      senha: chamada.senha || paciente?.senha || null,
      localTipo: chamada.localTipo || "Guichê",
      localNumero: chamada.localNumero || "--",
      createdAt: chamada.createdAt || null,
      dadosPaciente: paciente ? {
        cpf: paciente.cpf || "",
        tipo: paciente.tipo || "Não informado"
      } : null,
      triagens: triagens.map(item => ({
        sintoma: item.sintoma || item.sintomas || "",
        risco: item.risco || "",
        temperatura: item.temperatura ?? item.temp ?? null,
        alergia: item.alergia || "",
        observacao: item.observacao || "",
        createdAt: item.createdAt || null
      }))
    };
  };

  res.json({
    chamada: dadosPaciente(db.tv?.chamada),
    historico: (Array.isArray(db.tv?.historico) ? db.tv.historico : [])
      .slice(0, 5)
      .map(dadosPaciente)
  });
});

app.post("/triagem", (req, res) => {
  const db = readDB();
  const pacienteId = Number(req.body?.pacienteId || 0);
  const nome = normalizeString(req.body?.nome || "");
  const sintoma = normalizeString(req.body?.sintoma || req.body?.sintomas || "");
  const temperatura = Number(req.body?.temperatura ?? req.body?.temp ?? 0);
  const alergia = normalizeString(req.body?.alergia || "");
  const observacao = normalizeString(req.body?.observacao || "");

  let risco = normalizeString(req.body?.risco || "");

  const paciente = db.pacientes.find(p => Number(p.id) === pacienteId);
  if (!paciente) {
    return res.status(404).json({ erro: "Paciente selecionado não encontrado." });
  }
  if (!nome || !sintoma) {
    return res.status(400).json({ erro: "Nome do paciente e sintomas são obrigatórios." });
  }
  if (!Number.isFinite(temperatura) || temperatura < 30 || temperatura > 45) {
    return res.status(400).json({ erro: "Informe uma temperatura válida entre 30 e 45 graus." });
  }

  if (temperatura >= 39) {
    risco = "vermelho";
  } else if (temperatura >= 38) {
    risco = "amarelo";
  } else if (!risco) {
    risco = "verde";
  }

  const triagem = {
    id: Date.now(),
    pacienteId,
    nome,
    sintoma,
    temperatura,
    alergia,
    observacao,
    risco,
    status: "aguardando_medico",
    createdAt: new Date().toISOString()
  };

  paciente.status = "triado";

  db.triagens.push(triagem);
  writeDB(db);

  res.status(201).json(triagem);
});

app.get("/triagens", (req, res) => {
  const db = readDB();
  res.json(db.triagens);
});

app.get("/lista-medicacoes", (req, res) => {
  res.json([
    "Dipirona",
    "Paracetamol",
    "Ibuprofeno",
    "Amoxicilina",
    "Azitromicina",
    "Loratadina",
    "Omeprazol",
    "Buscopan",
    "Dramin",
    "Soro fisiológico"
  ]);
});

app.post("/consulta", async (req, res) => {
  const db = readDB();
  const triagemId = Number(req.body?.triagemId || 0);
  const quantidade = Number(req.body?.quantidade ?? 1);
  const consulta = {
    id: Date.now(),
    triagemId: triagemId || null,
    paciente: normalizeString(req.body?.paciente || ""),
    diagnostico: normalizeString(req.body?.diagnostico || ""),
    medicacao: normalizeString(req.body?.medicacao || ""),
    quantidade,
    medico: normalizeString(req.body?.medico || ""),
    obs: normalizeString(req.body?.obs || ""),
    createdAt: new Date().toISOString()
  };

  if (!consulta.paciente || !consulta.medicacao || !consulta.medico ||
      !Number.isInteger(quantidade) || quantidade < 1) {
    return res.status(400).json({ erro: "Paciente, medicação, médico e quantidade inteira maior que zero são obrigatórios." });
  }

  const triagem = triagemId
    ? db.triagens.find(item => Number(item.id) === triagemId)
    : null;
  if (triagemId && !triagem) {
    return res.status(404).json({ erro: "Triagem selecionada não encontrada." });
  }
  if (triagem && triagem.status === "atendida") {
    return res.status(409).json({ erro: "Esta triagem já foi atendida." });
  }
  if (triagem) {
    triagem.status = "atendida";
    const paciente = db.pacientes.find(item => Number(item.id) === Number(triagem.pacienteId));
    if (paciente) paciente.status = "consultado";
  }

  if (persistentStorage.configured) {
    try {
      const saved = await persistentStorage.createPrescriptionAndDispense(consulta);
      if (triagem) writeDB(db);
      return res.status(201).json(saved);
    } catch (error) {
      return respondStorageError(res, error);
    }
  }

  const medicamento = db.estoque.find(item =>
    normalizeString(item.nome).toLocaleLowerCase("pt-BR") ===
    consulta.medicacao.toLocaleLowerCase("pt-BR")
  );
  if (!medicamento) {
    return res.status(404).json({ erro: `O medicamento "${consulta.medicacao}" não está cadastrado no estoque.` });
  }
  const saldo = Number(medicamento.quantidade);
  if (!Number.isInteger(saldo) || saldo < quantidade) {
    return res.status(409).json({
      erro: `Estoque insuficiente para ${medicamento.nome}. Disponível: ${Number.isInteger(saldo) ? saldo : 0}; solicitado: ${quantidade}.`
    });
  }

  const dispensadoAt = new Date().toISOString();
  medicamento.quantidade = saldo - quantidade;
  consulta.dispensado = true;
  consulta.dispensadoAt = dispensadoAt;
  db.entradasEstoque.push({
    id: Date.now(),
    tipo: "saida",
    medicamentoId: medicamento.id,
    nome: medicamento.nome,
    quantidade,
    paciente: consulta.paciente,
    medico: consulta.medico,
    consultaId: consulta.id,
    observacao: "Dispensação de prescrição médica",
    createdAt: dispensadoAt
  });
  db.consultas.push(consulta);
  writeDB(db);

  res.status(201).json(consulta);
});

app.get("/medicacoes", async (req, res) => {
  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.getPrescriptions());
    } catch (error) {
      return respondStorageError(res, error);
    }
  }
  const db = readDB();
  res.json(db.consultas);
});

app.post("/consultas/:id/dispensar", async (req, res) => {
  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.dispensePrescription(req.params.id));
    } catch (error) {
      return respondStorageError(res, error);
    }
  }
  const db = readDB();
  const consulta = db.consultas.find(item => String(item.id) === req.params.id);
  if (!consulta) {
    return res.status(404).json({ erro: "Prescrição não encontrada." });
  }
  if (consulta.dispensado) {
    return res.status(409).json({ erro: "Esta prescrição já foi dispensada." });
  }
  const quantidade = Number(consulta.quantidade);
  if (!Number.isInteger(quantidade) || quantidade < 1) {
    return res.status(400).json({ erro: "A prescrição não possui uma quantidade válida para dispensação." });
  }
  const medicamento = db.estoque.find(item =>
    normalizeString(item.nome).toLocaleLowerCase("pt-BR") ===
    normalizeString(consulta.medicacao).toLocaleLowerCase("pt-BR")
  );
  if (!medicamento) {
    return res.status(404).json({ erro: `O medicamento "${consulta.medicacao}" não está cadastrado no estoque.` });
  }
  const saldo = Number(medicamento.quantidade);
  if (!Number.isInteger(saldo) || saldo < quantidade) {
    return res.status(409).json({
      erro: `Estoque insuficiente para ${medicamento.nome}. Disponível: ${Number.isInteger(saldo) ? saldo : 0}; solicitado: ${quantidade}.`
    });
  }

  const createdAt = new Date().toISOString();
  medicamento.quantidade = saldo - quantidade;
  consulta.dispensado = true;
  consulta.dispensadoAt = createdAt;
  db.entradasEstoque.push({
    id: Date.now(),
    tipo: "saida",
    medicamentoId: medicamento.id,
    nome: medicamento.nome,
    quantidade,
    paciente: consulta.paciente,
    medico: consulta.medico,
    consultaId: consulta.id,
    observacao: "Dispensação de prescrição médica",
    createdAt
  });
  writeDB(db);
  res.json({ consulta, medicamento });
});

app.get("/estoque", async (req, res) => {
  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.getInventory());
    } catch (error) {
      return respondStorageError(res, error);
    }
  }
  const db = readDB();
  res.json(db.estoque);
});

app.get("/estoque/movimentacoes", async (req, res) => {
  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.getMovements());
    } catch (error) {
      return respondStorageError(res, error);
    }
  }
  const db = readDB();
  res.json(db.entradasEstoque.slice().reverse());
});

app.get("/estoque/entradas", async (req, res) => {
  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.getMovements({ entriesOnly: true, limit: 10 }));
    } catch (error) {
      return respondStorageError(res, error);
    }
  }
  const db = readDB();
  res.json(db.entradasEstoque.slice(-10).reverse());
});

app.post("/estoque", async (req, res) => {
  const nome = normalizeString(req.body?.nome);
  const categoria = normalizeString(req.body?.categoria);
  const unidade = normalizeString(req.body?.unidade);
  const quantidade = Number(req.body?.quantidade);

  if (!nome || !categoria || !unidade || !Number.isInteger(quantidade) || quantidade < 1) {
    return res.status(400).json({ erro: "Informe medicamento, categoria, unidade e uma quantidade inteira maior que zero." });
  }

  if (persistentStorage.configured) {
    try {
      return res.status(201).json(await persistentStorage.createInventory({ nome, categoria, unidade, quantidade }));
    } catch (error) {
      return respondStorageError(res, error);
    }
  }

  const db = readDB();
  if (db.estoque.some(item => normalizeString(item.nome).toLowerCase() === nome.toLowerCase())) {
    return res.status(409).json({ erro: "Este medicamento já está cadastrado. Use a opção de reposição." });
  }

  const medicamento = { id: Date.now(), nome, categoria, unidade, quantidade };
  db.estoque.push(medicamento);
  db.entradasEstoque.push({
    id: Date.now(),
    tipo: "entrada",
    medicamentoId: medicamento.id,
    nome,
    quantidade,
    observacao: "Cadastro inicial",
    createdAt: new Date().toISOString()
  });
  writeDB(db);
  res.status(201).json(medicamento);
});

app.post("/estoque/:id/entradas", async (req, res) => {
  const quantidade = Number(req.body?.quantidade);
  const observacao = normalizeString(req.body?.observacao);

  if (!Number.isInteger(quantidade) || quantidade < 1) {
    return res.status(400).json({ erro: "A quantidade deve ser um número inteiro maior que zero." });
  }

  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.addInventory(req.params.id, quantidade, observacao));
    } catch (error) {
      return respondStorageError(res, error);
    }
  }

  const db = readDB();
  const medicamento = db.estoque.find(item => Number(item.id) === Number(req.params.id));
  if (!medicamento) {
    return res.status(404).json({ erro: "Medicamento não encontrado." });
  }

  medicamento.quantidade += quantidade;
  db.entradasEstoque.push({
    id: Date.now(),
    tipo: "entrada",
    medicamentoId: medicamento.id,
    nome: medicamento.nome,
    quantidade,
    observacao,
    createdAt: new Date().toISOString()
  });
  writeDB(db);
  res.json(medicamento);
});

app.patch("/estoque/:id", async (req, res) => {
  const ajuste = Number(req.body?.ajuste);

  if (!Number.isInteger(ajuste) || ajuste === 0) {
    return res.status(400).json({ erro: "Informe um ajuste inteiro diferente de zero que não deixe o estoque negativo." });
  }

  if (persistentStorage.configured) {
    try {
      return res.json(await persistentStorage.adjustInventory(req.params.id, ajuste));
    } catch (error) {
      return respondStorageError(res, error);
    }
  }

  const db = readDB();
  const medicamento = db.estoque.find(item => Number(item.id) === Number(req.params.id));
  if (!medicamento) {
    return res.status(404).json({ erro: "Medicamento não encontrado." });
  }
  if (medicamento.quantidade + ajuste < 0) {
    return res.status(400).json({ erro: "Informe um ajuste inteiro diferente de zero que não deixe o estoque negativo." });
  }

  medicamento.quantidade += ajuste;
  db.entradasEstoque.push({
    id: Date.now(),
    tipo: ajuste > 0 ? "entrada" : "saida",
    medicamentoId: medicamento.id,
    nome: medicamento.nome,
    quantidade: Math.abs(ajuste),
    observacao: "Ajuste manual",
    createdAt: new Date().toISOString()
  });
  writeDB(db);
  res.json(medicamento);
});

app.delete("/estoque/:id", async (req, res) => {
  if (persistentStorage.configured) {
    try {
      await persistentStorage.deleteInventory(req.params.id);
      return res.status(204).send();
    } catch (error) {
      return respondStorageError(res, error);
    }
  }

  const db = readDB();
  const index = db.estoque.findIndex(item => Number(item.id) === Number(req.params.id));
  if (index === -1) {
    return res.status(404).json({ erro: "Medicamento não encontrado." });
  }
  db.estoque.splice(index, 1);
  writeDB(db);
  res.status(204).send();
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🏥 Hospital Pro rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
