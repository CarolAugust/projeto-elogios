const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const path = require('path');
const os = require('os');
const moment = require('moment-timezone');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
const dotenv = require('dotenv');

// carrega .env.local se existir, senão .env
const envLocalPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
} else {
  dotenv.config();
}

const app = express();

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-avaliador-token'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('X-App-Build', 'elogios-2026-01-08-build1');
  next();
});

// 🔥 PROXY CORRETO
app.use(
  '/api',
  createProxyMiddleware({
    target: 'http://127.0.0.1:3000',
    changeOrigin: true,
    secure: false,
    proxyTimeout: 15000,
    timeout: 15000,
  })
);


/* ============================
   HELPERS
============================ */
// Captura IP da máquina
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (let name in interfaces) {
    for (let iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// Data/Hora São Paulo
function getDataAtual() {
  return moment().tz('America/Sao_Paulo').format('YYYY-MM-DD HH:mm:ss');
}

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizaCarreta(valor) {
  return String(valor || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// ===== VALIDAÇÃO KMM (carreta existe e está ativa) =====
async function existeCarretaAtivaNoKMM(carretaNorm) {
  const sql = `
    SELECT 1
    FROM veiculo.veiculo_modalidade vm
    WHERE lower(vm."MODALIDADE"::text) = 'frota'
      AND vm."DATA_CANCELAMENTO" IS NULL
      AND vm."PLACA" IS NOT NULL
      AND regexp_replace(upper(vm."PLACA"::text), '[^A-Z0-9]', '', 'g') = $1
    LIMIT 1
  `;

  const r = await poolKMM.query(sql, [carretaNorm]);
  return (r.rows || []).length > 0;
}

async function getMotoristaPorCarreta(carretaNorm) {
  const sql = `
    SELECT
      fd."NOME" AS motorista
    FROM veiculo.veiculo_motorista vm
    JOIN folha.funcionario_dados fd
      ON fd."COD_PESSOA" = vm."COD_PESSOA"
    WHERE fd."DATA_DEMISSAO" IS NULL
      AND regexp_replace(upper(vm."PLACA"::text), '[^A-Z0-9]', '', 'g') = $1
    ORDER BY vm."DATA_INICIO" DESC NULLS LAST
    LIMIT 1
  `;

  const r = await poolKMM.query(sql, [carretaNorm]);
  return r.rows?.[0]?.motorista || null;
}




/* ============================
   BANCO MySQL (dw-superbi)
============================ */
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: Number(process.env.MYSQL_PORT || 3306),
  ssl: false,
  timezone: process.env.MYSQL_TIMEZONE || '-03:00'
});

/* ============================
   BANCO PostgreSQL (KMM)
============================ */
const poolKMM = new Pool({
  host: process.env.KMM_HOST,
  port: Number(process.env.KMM_PORT || 5430),
  database: process.env.KMM_DATABASE,
  user: process.env.KMM_USER,
  password: process.env.KMM_PASSWORD,
  ssl: String(process.env.KMM_SSL || 'false') === 'true'
});

/* ============================
   GEO (cidade/estado)
============================ */
async function getCidadeEstado(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Projeto-Elogios/1.0' },
      timeout: 5000
    });

    const data = response.data;
    const cidade = data.address.city || data.address.town || data.address.village || '';
    const estado = data.address.state || '';
    return { cidade, estado };
  } catch (error) {
    console.error('❌ Erro ao buscar cidade/estado:', error.message);
    return { cidade: null, estado: null };
  }
}

/* ============================
   ARQUIVOS ESTÁTICOS + PÁGINAS
============================ */
app.use(express.static(path.join(__dirname, '..', 'public')));


app.use('/dashboard', express.static(path.join(__dirname, '..', 'public', 'dashboard')));

// se seu React usa rotas (React Router), precisa desse fallback:
app.get(/^\/dashboard(\/.*)?$/, (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});


///////////////////////////////////

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'elogionaestrada.html'));
});

app.get('/elogio-interno', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'elogio-interno.html'));
});


/* ======================================================
   ✅ ELOGIO PÚBLICO 
====================================================== */
app.post('/elogio', async (req, res) => {
  const token = String(req.get('x-avaliador-token') || '').trim().toLowerCase();

  if (!token) {
    return res.status(400).json({ status: 'erro', mensagem: 'Token do avaliador não informado.' });
  }

  let {
    nome, nome_motorista, carreta, telefone, elogio,
    latitude, longitude, maps_link, user_agent
  } = req.body || {};

  // Validações básicas
 // antes: if (!nome || !nome_motorista || !carreta || !telefone || !elogio) ...

  if (!nome || !carreta || !telefone || !elogio) {
    return res.status(400).json({ status: 'erro', mensagem: 'Campos obrigatórios não preenchidos.' });
  }

  // se não veio nome_motorista, tenta obter pela carreta
  if (!nome_motorista) {
    nome_motorista = await getMotoristaPorCarreta(normalizaCarreta(carreta));
  }

  try {
    // 1) Valida carreta no KMM
    const okKmm = await existeCarretaAtivaNoKMM(normalizaCarreta(carreta));
    if (!okKmm) {
      return res.status(404).json({ status: 'erro', mensagem: 'Carreta não encontrada ou inativa.' });
    }

    // 2) Bloqueio 7 dias
    const limite = moment().tz('America/Sao_Paulo').subtract(7, 'days').format('YYYY-MM-DD HH:mm:ss');
    const [existe] = await pool.query(
      'SELECT 1 FROM elogios_motoristas WHERE carreta = ? AND token_avaliador = ? AND data_hora >= ? LIMIT 1',
      [normalizaCarreta(carreta), token, limite]
    );

    if (existe.length > 0) {
      return res.status(409).json({ status: 'bloqueado', mensagem: 'Você já elogiou esta carreta nos últimos 7 dias.' });
    }

    // 3) Cidade/Estado
    let { cidade, estado } = (latitude && longitude) ? await getCidadeEstado(latitude, longitude) : { cidade: null, estado: null };

    // 4) INSERT (Seguindo a ordem exata da imagem da sua tabela)
    // Deixamos data_hora e data_registro para o banco preencher (DEFAULT)
    const sql = `
      INSERT INTO elogios_motoristas 
      (nome, nome_motorista, carreta, telefone, elogio, tipo, pontos, latitude, longitude, maps_link, user_agent, cidade, estado, token_avaliador) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.query(sql, [
      nome, nome_motorista, normalizaCarreta(carreta), telefone, elogio,
      'Externo', 1, // tipo e pontos
      latitude || null, longitude || null, maps_link || null, user_agent || null,
      cidade, estado, token
    ]);

    return res.json({ status: 'sucesso', mensagem: 'Elogio salvo com sucesso!' });
  } catch (err) {
    console.error('❌ Erro no elogio:', err);
    return res.status(500).json({ status: 'erro', mensagem: 'Erro interno: ' + (err.sqlMessage || err.message) });
  }
});

/* ======================================================
   ✅ OCORRÊNCIA (CORRIGIDO)
====================================================== */
app.post('/ocorrencia', async (req, res) => {
  let { nome, carreta, telefone, tipo_ocorrencia, descricao, latitude, longitude, maps_link, user_agent } = req.body || {};

  if (!nome || !carreta || !telefone || !tipo_ocorrencia || !descricao) {
    return res.status(400).json({ status: 'erro', mensagem: 'Campos obrigatórios não preenchidos.' });
  }

  try {
    const okKmm = await existeCarretaAtivaNoKMM(normalizaCarreta(carreta));
    if (!okKmm) {
      return res.status(404).json({ status: 'erro', mensagem: 'Placa não encontrada no KMM.' });
    }

    let { cidade, estado } = (latitude && longitude) ? await getCidadeEstado(latitude, longitude) : { cidade: null, estado: null };

    // INSERT ajustado para a imagem "ocorrencias_motoristas"
    const sql = `
      INSERT INTO ocorrencias_motoristas 
      (nome, carreta, telefone, tipo_ocorrencia, descricao, latitude, longitude, maps_link, user_agent, cidade, estado) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.query(sql, [
      nome, normalizaCarreta(carreta), telefone, tipo_ocorrencia, descricao,
      latitude || null, longitude || null, maps_link || null, user_agent || null, 
      cidade, estado
    ]);

    return res.json({ status: 'sucesso', mensagem: 'Ocorrência salva!' });
  } catch (err) {
    console.error('❌ Erro na ocorrência:', err);
    return res.status(500).json({ status: 'erro', mensagem: 'Erro ao salvar: ' + (err.sqlMessage || err.message) });
  }
});

/* ======================================================
   ✅ MOTORISTAS ATIVOS (KMM) - AUTOCOMPLETE
====================================================== */
app.get('/motoristas-ativos', async (req, res) => {
  try {
    const query = `
      SELECT 
        fd."MATRICULA" AS matricula, 
        fd."NOME" AS nome_motorista
      FROM folha.funcionario_dados fd
      WHERE fd."DATA_ADMISSAO" IS NOT NULL
        AND fd."DATA_DEMISSAO" IS NULL
        AND fd."CARGO" ILIKE ANY (ARRAY[
            'MOTORISTA',
            'MOTORISTA CARRETEIRO',
            'MOTORISTA CARRETEIRO III',
            'MOTORISTA CHECK LIST',
            'MOTORISTA DE BITREM',
            'MOTORISTA DE MANUTENCAO',
            'MOTORISTA ENTREGADOR',
            'MOTORISTA INSTRUTOR',
            'MOTORISTA MANOBRA',
            'MOTORISTA TOCO',
            'MOTORISTA TRAINEE',
            'MOTORISTA TRUCK'
        ])
      ORDER BY fd."NOME"
    `;

    const result = await poolKMM.query(query);
    return res.json(result.rows);
  } catch (error) {
    console.error('❌ Erro ao buscar motoristas ativos do KMM:', error.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Erro ao buscar motoristas' });
  }
});



/* ======================================================
   ✅ CARRETAS ATIVAS (KMM) - AUTOCOMPLETE
   Regra: modalidade = 'frota' AND data_cancelamento IS NULL
   Uso: /carretas-ativas?q=ABC&limit=20
====================================================== */

// Se você souber o nome exato da coluna no futuro, coloque aqui e pronto.
// Ex: const VM_CARRETA_COL_OVERRIDE = 'PLACA_CARRETA';
const VM_CARRETA_COL_OVERRIDE = null;

const PLACA_RE = /^([A-Z]{3}[0-9]{4}|[A-Z]{3}[0-9][A-Z0-9][0-9]{2})$/;

function parecePlaca(v) {
  const norm = normalizaCarreta(v);
  return PLACA_RE.test(norm);
}

let vmBaseColsCache = null;
let vmCarretaColCache = null;

async function resolveVmBaseCols() {
  if (vmBaseColsCache) return vmBaseColsCache;

  const fallback = {
    modalidade: 'modalidade',
    data_cancelamento: 'data_cancelamento',
  };

  try {
    const meta = await poolKMM.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      `,
      ['veiculo', 'veiculo_motorista']
    );

    const cols = meta.rows.map(r => r.column_name);
    const lower = cols.map(c => c.toLowerCase());

    const pick = (candidates) => {
      for (const cand of candidates) {
        const idx = lower.indexOf(cand.toLowerCase());
        if (idx >= 0) return cols[idx];
      }
      return null;
    };

    const colModalidade = pick(['modalidade', 'Modalidade']);
    const colCancel = pick(['data_cancelamento', 'DATA_CANCELAMENTO', 'Data_Cancelamento']);

    vmBaseColsCache = {
      modalidade: colModalidade || fallback.modalidade,
      data_cancelamento: colCancel || fallback.data_cancelamento
    };

    console.log('✅ Base cols veiculo.veiculo_motorista:', vmBaseColsCache);
    return vmBaseColsCache;
  } catch (e) {
    console.warn('⚠ resolveVmBaseCols falhou (fallback):', e.message);
    vmBaseColsCache = fallback;
    return vmBaseColsCache;
  }
}

async function resolveCarretaCol() {
  if (VM_CARRETA_COL_OVERRIDE) return VM_CARRETA_COL_OVERRIDE;
  if (vmCarretaColCache) return vmCarretaColCache;

  const { modalidade, data_cancelamento } = await resolveVmBaseCols();

  const meta = await poolKMM.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    `,
    ['veiculo', 'veiculo_motorista']
  );

  const cols = meta.rows.map(r => r.column_name)
    // só deixa nomes seguros de identifier
    .filter(c => /^[A-Za-z0-9_]+$/.test(c));

  // rank por “probabilidade”
  const scored = cols.map(c => {
    const n = c.toLowerCase();
    let score = 0;
    if (n.includes('carreta')) score += 50;
    if (n.includes('placa')) score += 30;
    if (n.includes('veiculo')) score += 10;
    if (n === modalidade.toLowerCase()) score = -999;
    if (n === data_cancelamento.toLowerCase()) score = -999;
    return { col: c, score };
  }).sort((a, b) => b.score - a.score);

  // testa as top colunas e escolhe a primeira que tem cara de placa
  for (const { col } of scored.slice(0, 25)) {
    const normSql = `regexp_replace(upper(vm."${col}"::text), '[^A-Z0-9]', '', 'g')`;

    const testSql = `
      SELECT ${normSql} AS v
      FROM veiculo.veiculo_motorista vm
      WHERE lower(vm."${modalidade}"::text) = 'frota'
        AND vm."${data_cancelamento}" IS NULL
        AND vm."${col}" IS NOT NULL
      LIMIT 50
    `;

    try {
      const r = await poolKMM.query(testSql);
      const values = (r.rows || []).map(x => x.v).filter(Boolean);

      if (values.some(v => parecePlaca(v))) {
        vmCarretaColCache = col;
        console.log('✅ Coluna de carreta detectada automaticamente:', col);
        return col;
      }
    } catch (e) {
      // ignora e tenta a próxima
    }
  }

  // se não achou, não chuta (pra não ficar 500 “misterioso”)
  throw new Error(
    'Não consegui detectar automaticamente a coluna de placa da carreta em veiculo.veiculo_motorista. ' +
    'Defina VM_CARRETA_COL_OVERRIDE com o nome correto.'
  );
}

app.get('/carretas-ativas', async (req, res) => {
  try {
    const q = normalizaCarreta(req.query.q || '');
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

    const placaNormSql = `regexp_replace(upper(vm."PLACA"::text), '[^A-Z0-9]', '', 'g')`;
    const whereBusca = q ? `AND ${placaNormSql} LIKE $1` : '';
    const params = q ? [`${q}%`, limit] : [limit];

    const sql = `
      SELECT DISTINCT ${placaNormSql} AS carreta
      FROM veiculo.veiculo_modalidade vm
      WHERE lower(vm."MODALIDADE"::text) = 'frota'
        AND vm."DATA_CANCELAMENTO" IS NULL
        AND vm."PLACA" IS NOT NULL
        ${whereBusca}
      ORDER BY carreta
      LIMIT $${q ? 2 : 1}
    `;

    const result = await poolKMM.query(sql, params);
    return res.json((result.rows || []).map(r => ({ carreta: r.carreta })));
  } catch (error) {
    console.error('❌ Erro ao buscar carretas ativas (KMM):', error.message);
    return res.status(500).json({ status: 'erro', mensagem: error.message });
  }
});


/* ======================================================
   ✅ ELOGIO INTERNO (CORRIGIDO)
   Agora envia 'tipo' e 'pontos' para o banco
====================================================== */
app.post('/elogio-interno', async (req, res) => {
  try {
    const token = String(req.get('x-avaliador-token') || '').trim().toLowerCase();
    console.log('HEADER /elogio-interno x-avaliador-token =>', token);

    if (!token) {
      return res.status(400).json({ status: 'erro', mensagem: 'Token do avaliador não informado.' });
    }

    let { matricula, elogio, autor, telefone, latitude, longitude, maps_link } = req.body || {};

    console.log('📥 /elogio-interno body (raw):', req.body);

    if (!matricula || !elogio || !autor || !telefone) {
      return res.status(400).json({ status: 'erro', mensagem: 'Todos os campos são obrigatórios.' });
    }

    matricula = onlyDigits(matricula);
    if (!matricula) {
      return res.status(400).json({ status: 'erro', mensagem: 'Matrícula inválida.' });
    }

    const tel = onlyDigits(telefone);
    if (!/^\d{10,11}$/.test(tel)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Telefone inválido. Use apenas números com DDD (10 ou 11 dígitos).'
      });
    }

   // BLOQUEIO 7 DIAS (matricula + token)
      const limite = moment().tz('America/Sao_Paulo').subtract(7, 'days').format('YYYY-MM-DD HH:mm:ss');

      const verificaSql = `
        SELECT 1
        FROM elogios_internos
        WHERE matricula = ?
          AND token_avaliador = ?
          AND data_hora >= ?
        LIMIT 1
      `;

      const [existe] = await pool.query(verificaSql, [matricula, token, limite]);

      if (existe.length > 0) {
        return res.status(409).json({
          status: 'bloqueado',
          mensagem: 'Você já enviou um elogio para este motorista nos últimos 7 dias.'
        });
      }

    // busca nome do motorista no KMM (fallback)
    let motorista = 'Desconhecido';
    try {
      const kmm = await poolKMM.query(
        `SELECT "NOME" FROM folha.funcionario_dados WHERE "MATRICULA" = $1 LIMIT 1`,
        [matricula]
      );
      motorista = kmm.rows?.[0]?.NOME || motorista;
    } catch (e) {
      console.warn('⚠ KMM indisponível na busca de matrícula:', e.message);
    }

    // cidade/estado via geocoding (se tiver lat/lon)
    let cidade = null, estado = null;
    if (latitude && longitude) {
      const local = await getCidadeEstado(latitude, longitude);
      cidade = local.cidade;
      estado = local.estado;
    }

    // === DEFININDO VALORES PADRÃO QUE FALTAVAM ===
    const tipo = 'Interno'; // Define fixo como Interno
    const pontos = 2;       // Define quantos pontos vale (ex: 1)

    // === SQL ATUALIZADO COM AS NOVAS COLUNAS ===
    const sql = `
      INSERT INTO elogios_internos
      (matricula, elogio, motorista, telefone, latitude, longitude, maps_link, cidade, estado, data_hora, token_avaliador, tipo, pontos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      matricula,
      String(elogio || '').trim(),
      motorista,
      tel,
      latitude || null,
      longitude || null,
      maps_link || null,
      cidade,
      estado,
      getDataAtual(),
      token,
      tipo,   // <--- Adicionado
      pontos  // <--- Adicionado
    ];

    const [result] = await pool.query(sql, params);

    console.log('✅ /elogio-interno inserido:', { insertId: result?.insertId, params });

    return res.json({
      status: 'sucesso',
      mensagem: 'Elogio interno salvo com sucesso!',
      id: result?.insertId || null
    });
  } catch (err) {
    console.error('❌ /elogio-interno erro:', err.sqlMessage || err.message, { body: req.body });
    return res.status(500).json({ status: 'erro', mensagem: 'Erro ao salvar elogio interno.' });
  }
});

/* ============================
   HTTP/HTTPS (LOCAL/PROD)
============================ */
const PORT = Number(process.env.PORT || 443);
const HOST = process.env.HOST || "0.0.0.0";
const USE_HTTPS = String(process.env.USE_HTTPS || "true") === "true";

if (USE_HTTPS) {
  // server.js está em /src, então volta pra raiz com ".."
  const keyPath = path.join(__dirname, "..", process.env.SSL_KEY_PATH || "certs/origin-key.pem");
  const certPath = path.join(__dirname, "..", process.env.SSL_CERT_PATH || "certs/origin-cert.pem");

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error("❌ Certificados SSL não encontrados.");
    process.exit(1);
  }

  const sslOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };

  https.createServer(sslOptions, app).listen(PORT, HOST, () => {
    console.log(`✅ HTTPS rodando em https://${HOST}:${PORT}`);
  });
} else {
  app.listen(PORT, HOST, () => {
    console.log(`✅ HTTP rodando em http://${HOST}:${PORT}`);
  });
}



