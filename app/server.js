// ============================================================================
//  indicacao_pdvs_fv — API + frontend estático
//  Sistema em que o representante (desc_territorio de cddd.forca_vendas)
//  sugere PDVs para positivação e o VB (volume base) por SKU, com workflow
//  de aprovação pelo BI&A.
// ============================================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 10 }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 10,
      }
);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// Autenticação individual (trade_fv.usuario) — senha scrypt + sessão HMAC
// ----------------------------------------------------------------------------
const AUTH_SECRET = process.env.APP_AUTH_SECRET || 'trade-fv-mvp-secret';
const SENHA_PADRAO = process.env.APP_SENHA_PADRAO || 'easelabs@2026';
const SESSAO_HORAS = 12;
const ADMINS_SEED = ['paulo_lima', 'rubens_filho', 'natalia_miranda'];

const hashSenha = (senha) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `s2$${salt}$${hash}`;
};

const conferirSenha = (senha, guardado) => {
  const [, salt, hash] = String(guardado || '').split('$');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(senha, salt, 64).toString('hex');
  return calc.length === hash.length &&
    crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
};

const b64url = (s) => Buffer.from(s).toString('base64url');

const assinarSessao = (u) => {
  const payload = b64url(JSON.stringify({
    uid: Number(u.id),
    usuario: u.usuario,
    role: u.role,
    nome: u.nome,
    territorio: u.desc_territorio || null,
    exp: Date.now() + SESSAO_HORAS * 3600 * 1000,
  }));
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
};

const validarSessao = (token) => {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const esperado = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  if (sig.length !== esperado.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!dados.exp || Date.now() > dados.exp) return null;
    return dados;
  } catch { return null; }
};

const auth = (roles) => (req, res, next) => {
  const sessao = validarSessao(req.get('X-Auth-Token'));
  if (!sessao) return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
  if (roles && !roles.includes(sessao.role)) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  req.sessao = sessao;
  req.role = sessao.role;
  next();
};

const asyncRoute = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });

// ----------------------------------------------------------------------------
// Sincronização de usuários: admins fixos + representantes ativos
// (vw_representantes_ativos). Novo CT ativo => usuário com senha padrão;
// CT que saiu do território => usuário desativado.
// ----------------------------------------------------------------------------
const slugUsuario = (nome) => String(nome)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const sincronizarUsuarios = async () => {
  const resumo = { criados: [], reativados: [], desativados: [] };

  for (const adm of ADMINS_SEED) {
    const r = await pool.query(`
      INSERT INTO trade_fv.usuario (usuario, nome, role, senha_hash, senha_padrao)
      VALUES ($1, $2, 'admin', $3, TRUE)
      ON CONFLICT (usuario) DO NOTHING
      RETURNING usuario
    `, [adm, adm.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join(' '), hashSenha(SENHA_PADRAO)]);
    if (r.rows.length) resumo.criados.push(adm);
  }

  const { rows: reps } = await pool.query('SELECT * FROM trade_fv.vw_representantes_ativos');
  for (const rep of reps) {
    const usuario = slugUsuario(rep.nome_abreviado_ct);
    if (!usuario) continue;
    const r = await pool.query(`
      INSERT INTO trade_fv.usuario
        (usuario, nome, email, role, cod_ct, cod_territorio, desc_territorio, senha_hash, senha_padrao)
      VALUES ($1, $2, $3, 'rep', $4, $5, $6, $7, TRUE)
      ON CONFLICT (usuario) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        cod_ct = EXCLUDED.cod_ct,
        cod_territorio = EXCLUDED.cod_territorio,
        desc_territorio = EXCLUDED.desc_territorio,
        ativo = TRUE,
        updated_at = now()
      RETURNING usuario, (xmax = 0) AS inserido
    `, [usuario, rep.nome_abreviado_ct, rep.email_ct, rep.cod_ct, rep.cod_territorio,
        rep.desc_territorio, hashSenha(SENHA_PADRAO)]);
    if (r.rows[0]?.inserido) resumo.criados.push(usuario);
  }

  // desativa reps cujo CT não está mais ativo em nenhum território
  const { rows: desativados } = await pool.query(`
    UPDATE trade_fv.usuario u
    SET ativo = FALSE, updated_at = now()
    WHERE u.role = 'rep' AND u.ativo
      AND NOT EXISTS (
        SELECT 1 FROM trade_fv.vw_representantes_ativos v
        WHERE v.cod_ct = u.cod_ct AND v.cod_territorio = u.cod_territorio
      )
    RETURNING u.usuario
  `);
  resumo.desativados = desativados.map((d) => d.usuario);

  if (resumo.criados.length || resumo.desativados.length) {
    console.log('[sync usuários]', JSON.stringify(resumo));
  }
  return resumo;
};

app.post('/api/login', asyncRoute(async (req, res) => {
  const usuario = String(req.body?.usuario || '').toLowerCase().trim();
  const senha = String(req.body?.senha || '');
  if (!usuario || !senha) return res.status(400).json({ error: 'Informe usuário e senha.' });

  const { rows } = await pool.query(
    'SELECT * FROM trade_fv.usuario WHERE usuario = $1 LIMIT 1', [usuario]);
  const u = rows[0];
  if (!u || !conferirSenha(senha, u.senha_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  if (!u.ativo) {
    return res.status(403).json({ error: 'Usuário desativado. Fale com o BI&A.' });
  }
  await pool.query('UPDATE trade_fv.usuario SET ultimo_login = now() WHERE id = $1', [u.id]);
  res.json({
    token: assinarSessao(u),
    role: u.role,
    nome: u.nome,
    usuario: u.usuario,
    territorio: u.desc_territorio || null,
    senha_padrao: u.senha_padrao,
  });
}));

// troca da própria senha
app.post('/api/senha', auth(), asyncRoute(async (req, res) => {
  const { senha_atual, senha_nova } = req.body || {};
  if (!senha_nova || String(senha_nova).length < 8) {
    return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  }
  const { rows } = await pool.query('SELECT * FROM trade_fv.usuario WHERE id = $1', [req.sessao.uid]);
  const u = rows[0];
  if (!u || !conferirSenha(String(senha_atual || ''), u.senha_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }
  await pool.query(`
    UPDATE trade_fv.usuario
    SET senha_hash = $1, senha_padrao = FALSE, updated_at = now()
    WHERE id = $2
  `, [hashSenha(String(senha_nova)), u.id]);
  res.json({ ok: true });
}));

// administração de usuários
app.get('/api/usuarios', auth(['admin']), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id, usuario, nome, email, role, desc_territorio, ativo, senha_padrao, ultimo_login
    FROM trade_fv.usuario
    ORDER BY role, usuario
  `);
  res.json(rows);
}));

app.post('/api/usuarios/:id/reset-senha', auth(['admin']), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`
    UPDATE trade_fv.usuario
    SET senha_hash = $1, senha_padrao = TRUE, updated_at = now()
    WHERE id = $2
    RETURNING usuario
  `, [hashSenha(SENHA_PADRAO), Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json({ ok: true, usuario: rows[0].usuario });
}));

app.post('/api/usuarios/sync', auth(['admin']), asyncRoute(async (_req, res) => {
  res.json(await sincronizarUsuarios());
}));

// ----------------------------------------------------------------------------
// Categoria do PDV (CAT_UN): tdd.dim_pdv (CNPJ→COD_PDV) ⋈ tdd.fato_tdd
// COD_GRUPO = 3, período mais recente (MAX do anomes após o "_", ex. SEM01_202601)
// ----------------------------------------------------------------------------
const SQL_CATEGORIA_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT t."CAT_UN" AS categoria, t."COD_PERIODO" AS categoria_periodo
    FROM tdd.fato_tdd t
    WHERE t."COD_PDV" = p."COD_PDV" AND t."COD_GRUPO" = 3
    ORDER BY split_part(t."COD_PERIODO", '_', 2) DESC
    LIMIT 1
  ) cat ON TRUE`;

// ----------------------------------------------------------------------------
// GET /api/representantes — territórios válidos (admin: simulação do fluxo)
// ----------------------------------------------------------------------------
app.get('/api/representantes', auth(['admin']), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT fv.desc_territorio,
           COUNT(DISTINCT p."CNPJ_PDV") AS qtd_pdvs
    FROM cddd.forca_vendas fv
    LEFT JOIN tdd.dim_pdv p ON p."UTC_PDV" = fv.cod_utc
    WHERE fv.desc_territorio IS NOT NULL
      AND fv.desc_territorio <> 'SEM REP'
    GROUP BY fv.desc_territorio
    ORDER BY fv.desc_territorio
  `);
  res.json(rows);
}));

// ----------------------------------------------------------------------------
// GET /api/redes — redes presentes na base de adequação (p/ cadastro manual)
// ----------------------------------------------------------------------------
app.get('/api/redes', auth(), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT provedor_pdv AS rede
    FROM trade_fv.fato_adequacao_estoque
    WHERE provedor_pdv IS NOT NULL
    ORDER BY 1
  `);
  res.json(rows.map((r) => r.rede));
}));

// ----------------------------------------------------------------------------
// GET /api/pdvs?q=...
// Busca PDVs em tdd.dim_pdv por CNPJ (dígitos) ou nome/cidade/bairro/endereço.
// Apenas PDVs presentes na base de adequação (só esses têm sugestão de VB).
// Traz a rede oficial (ex.: Drogaria Catarinense → CLAMED) e a categoria.
// ----------------------------------------------------------------------------
// apelidos de rede digitáveis → nome canônico na base
const normalizarRedesNaBusca = (q) => q
  .replace(/pague\s*menos/gi, 'PAGUEMENOS')
  .replace(/raia\s*drogasil|drogasil/gi, 'RAIA')
  .replace(/s[aã]o\s*jo[aã]o/gi, 'SAOJOAO')
  .replace(/ven[aâ]ncio/gi, 'VENANCIO');

app.get('/api/pdvs', auth(), asyncRoute(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const digits = q.replace(/\D/g, '');
  const params = [];
  const where = [];
  let ordemRede = '';

  if (digits.length >= 4 && digits.length === q.replace(/[.\-\/\s]/g, '').length) {
    // busca por CNPJ: compara os dígitos (bigint perde zeros à esquerda)
    params.push(`%${digits}%`);
    where.push(`p."CNPJ_PDV"::text LIKE $${params.length}`);
  } else {
    // busca textual: cada palavra deve casar com nome, cidade, bairro, endereço ou REDE
    const qNorm = normalizarRedesNaBusca(q);
    const tokens = qNorm.split(/\s+/).filter(Boolean).slice(0, 6);
    for (const token of tokens) {
      params.push(`%${token}%`);
      where.push(`(p."DESC_PDV" ILIKE $${params.length} OR p."CIDADE_PDV" ILIKE $${params.length}
                   OR p."BAIRRO_PDV" ILIKE $${params.length} OR p."ENDERECO_PDV" ILIKE $${params.length}
                   OR f.provedor_pdv ILIKE $${params.length})`);
    }
    // quem digitou o nome de uma rede vê os PDVs dessa rede primeiro
    params.push(tokens);
    ordemRede = `(f.provedor_pdv ILIKE ANY($${params.length}::text[])) DESC,`;
  }

  const { rows } = await pool.query(`
    SELECT p."CNPJ_PDV"      AS cnpj,
           p."DESC_PDV"      AS nome,
           p."ENDERECO_PDV"  AS endereco,
           p."BAIRRO_PDV"    AS bairro,
           p."CIDADE_PDV"    AS cidade,
           p."UF_PDV"        AS uf,
           p."DESC_SITUACAO" AS situacao,
           f.provedor_pdv    AS rede,
           cat.categoria
    FROM tdd.dim_pdv p
    JOIN LATERAL (
      SELECT provedor_pdv FROM trade_fv.fato_adequacao_estoque f
      WHERE f.cnpj_pdv = p."CNPJ_PDV" LIMIT 1
    ) f ON TRUE
    ${SQL_CATEGORIA_LATERAL}
    WHERE ${where.join(' AND ')}
    ORDER BY ${ordemRede} (p."DESC_SITUACAO" = 'ATIVA') DESC, p."DESC_PDV"
    LIMIT 15
  `, params);
  res.json(rows);
}));

// ----------------------------------------------------------------------------
// GET /api/pdv/:cnpj — detalhe qualitativo + categoria + adequação + sugestões
// ----------------------------------------------------------------------------
app.get('/api/pdv/:cnpj', auth(), asyncRoute(async (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, '');
  if (!cnpj) return res.status(400).json({ error: 'CNPJ inválido' });

  const [pdv, adequacao, sugestoes, territorio] = await Promise.all([
    pool.query(`
      SELECT p."CNPJ_PDV" AS cnpj, p."DESC_PDV" AS nome, p."ENDERECO_PDV" AS endereco,
             p."BAIRRO_PDV" AS bairro, p."CIDADE_PDV" AS cidade, p."UF_PDV" AS uf,
             p."REGIAO_PDV" AS regiao, p."TELEFONE" AS telefone,
             p."DESC_SITUACAO" AS situacao,
             p."GOOGLE_LATITUDE" AS latitude, p."GOOGLE_LONGITUDE" AS longitude,
             cat.categoria, cat.categoria_periodo
      FROM tdd.dim_pdv p
      ${SQL_CATEGORIA_LATERAL}
      WHERE p."CNPJ_PDV" = $1 LIMIT 1
    `, [cnpj]),
    pool.query(`
      SELECT "CNPJ" AS cnpj, "Rede" AS rede, "CAT" AS cat,
             "Ultima Venda (dias)" AS ultima_venda_dias, "SKU" AS sku,
             "Cobertura FV" AS cobertura_fv, "Status" AS status,
             "Estoque Atual" AS estoque_atual, "Estoque Ideal" AS estoque_ideal,
             "EAN" AS ean, "Delta" AS delta, "Ajuste" AS ajuste,
             "Média Mensal" AS media_mensal
      FROM trade_fv.fato_adequacao_estoque_unpivot
      WHERE "CNPJ" = $1
      ORDER BY CASE "SKU"
        WHEN 'Isolado 30 mL' THEN 1 WHEN 'Isolado 10 mL' THEN 2
        WHEN 'Isolado 20 mg 30 mL' THEN 3 WHEN 'Extrato' THEN 4 END
    `, [cnpj]),
    // sugestões existentes: exclusivas ao admin/BI&A (o rep não vê histórico)
    req.role === 'admin' ? pool.query(`
      SELECT "EAN" AS ean, "SKU" AS sku, "Sugestao VB" AS sugestao_vb,
             "Representante" AS representante, status_aprovacao,
             created_at, decidido_em
      FROM trade_fv.sugestao_fv
      WHERE "CNPJ" = $1
      ORDER BY created_at DESC
    `, [cnpj]) : { rows: [] },
    pool.query(`
      SELECT DISTINCT fv.desc_territorio
      FROM tdd.dim_pdv p
      JOIN cddd.forca_vendas fv ON fv.cod_utc = p."UTC_PDV"
      WHERE p."CNPJ_PDV" = $1
    `, [cnpj]),
  ]);

  if (!pdv.rows.length) return res.status(404).json({ error: 'PDV não encontrado' });

  res.json({
    pdv: pdv.rows[0],
    territorios: territorio.rows.map((r) => r.desc_territorio),
    adequacao: adequacao.rows,
    sugestoes: sugestoes.rows,
  });
}));

const SKU_POR_EAN = {
  '7896806601243': 'Isolado 30 mL',
  '7896806601281': 'Isolado 10 mL',
  '7896806601328': 'Isolado 20 mg 30 mL',
  '7896806601250': 'Extrato',
};

// ----------------------------------------------------------------------------
// POST /api/sugestoes — { cnpj, ean, sugestao_vb, representante, rede? }
// Snapshot da unpivot + INSERT. Bloqueia se já houver sugestão PENDENTE do
// mesmo representante para o mesmo CNPJ x SKU (aguardar decisão do BI&A).
// ----------------------------------------------------------------------------
app.post('/api/sugestoes', auth(), asyncRoute(async (req, res) => {
  const { cnpj, ean, sugestao_vb, rede } = req.body || {};
  const cnpjNum = String(cnpj || '').replace(/\D/g, '');
  const vb = Number(sugestao_vb);

  // Modo BI&A (admin): a alteração de VB entra já APROVADA na sugestão oficial.
  const modoBia = req.role === 'admin' && req.body?.modo === 'bia';
  // RLS: rep sempre registra no próprio território; admin informa qual simula
  const representante = modoBia
    ? 'BI&A'
    : (req.role === 'rep' ? req.sessao.territorio : (req.body?.representante || '').trim());

  if (!cnpjNum || !SKU_POR_EAN[ean] || !representante || !Number.isInteger(vb) || vb < 0) {
    return res.status(400).json({ error: 'Dados inválidos: informe CNPJ, EAN, representante e um VB inteiro ≥ 0.' });
  }

  // bloqueio de duplicidade só para a força de vendas (o BI&A pode sobrescrever)
  if (!modoBia) {
    const pendente = await pool.query(`
      SELECT id FROM trade_fv.sugestao_fv
      WHERE "CNPJ" = $1 AND "EAN" = $2 AND "Representante" = $3
        AND status_aprovacao = 'PENDENTE'
      LIMIT 1
    `, [cnpjNum, ean, representante]);
    if (pendente.rows.length) {
      return res.status(409).json({
        error: `Você já tem uma sugestão pendente para este PDV × ${SKU_POR_EAN[ean]}. Aguarde a aprovação ou recusa do BI&A antes de enviar outra.`,
      });
    }
  }

  const snap = await pool.query(`
    SELECT * FROM trade_fv.fato_adequacao_estoque_unpivot
    WHERE "CNPJ" = $1 AND "EAN" = $2 LIMIT 1
  `, [cnpjNum, ean]);

  const s = snap.rows[0] || {
    'CNPJ': cnpjNum,
    'Rede': rede ? String(rede).toUpperCase() : null,
    'CAT': null,
    'Ultima Venda (dias)': null,
    'SKU': SKU_POR_EAN[ean],
    'Cobertura FV': null,
    'Status': null,
    'Estoque Atual': null,
    'Estoque Ideal': null,
    'EAN': ean,
    'Delta': null,
    'Ajuste': null,
  };

  const statusInsert = modoBia ? 'APROVADA' : 'PENDENTE';
  const decididoPor = modoBia ? `BI&A (${req.sessao.nome || req.sessao.usuario})` : null;

  try {
    const { rows } = await pool.query(`
      INSERT INTO trade_fv.sugestao_fv
        ("CNPJ","Rede","CAT","Ultima Venda (dias)","SKU","Cobertura FV","Status",
         "Estoque Atual","Estoque Ideal","EAN","Delta","Ajuste","Sugestao VB","Representante",
         status_aprovacao, decidido_por, decidido_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
              $15, $16, CASE WHEN $15 = 'PENDENTE' THEN NULL ELSE now() END)
      RETURNING id, "CNPJ" AS cnpj, "SKU" AS sku, "EAN" AS ean,
                "Sugestao VB" AS sugestao_vb, "Representante" AS representante,
                status_aprovacao, created_at
    `, [
      s['CNPJ'], s['Rede'], s['CAT'], s['Ultima Venda (dias)'], s['SKU'],
      s['Cobertura FV'], s['Status'], s['Estoque Atual'], s['Estoque Ideal'],
      s['EAN'], s['Delta'], s['Ajuste'], vb, representante,
      statusInsert, decididoPor,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Você já tem uma sugestão pendente para este PDV × SKU. Aguarde a decisão do BI&A.',
      });
    }
    throw err;
  }
}));

// ----------------------------------------------------------------------------
// GET /api/sugestoes — ?rep= | ?cnpj= | (admin) ?all=1[&rep=&status=]
// ----------------------------------------------------------------------------
app.get('/api/sugestoes', auth(), asyncRoute(async (req, res) => {
  // histórico de sugestões é exclusivo ao admin/BI&A
  if (req.role !== 'admin') return res.json([]);

  const rep = (req.query.rep || '').trim();
  const cnpj = (req.query.cnpj || '').replace(/\D/g, '');
  const all = req.query.all === '1';
  const status = (req.query.status || '').trim().toUpperCase();
  if (!all && !rep && !cnpj) return res.json([]);

  const where = [];
  const params = [];
  if (rep) { params.push(rep); where.push(`s."Representante" = $${params.length}`); }
  if (cnpj) { params.push(cnpj); where.push(`s."CNPJ" = $${params.length}`); }
  if (['PENDENTE', 'APROVADA', 'RECUSADA'].includes(status)) {
    params.push(status); where.push(`s.status_aprovacao = $${params.length}`);
  }

  const { rows } = await pool.query(`
    SELECT s.id, s."CNPJ" AS cnpj, p."DESC_PDV" AS nome_pdv, p."CIDADE_PDV" AS cidade,
           p."UF_PDV" AS uf, s."Rede" AS rede, s."SKU" AS sku, s."EAN" AS ean,
           s."Ajuste" AS ajuste, s."Estoque Atual" AS estoque_atual,
           s."Estoque Ideal" AS estoque_ideal, s."Sugestao VB" AS sugestao_vb,
           uni."Média Mensal" AS media_mensal,
           s."Representante" AS representante, s.status_aprovacao,
           s.created_at, s.decidido_por, s.decidido_em
    FROM trade_fv.sugestao_fv s
    LEFT JOIN tdd.dim_pdv p ON p."CNPJ_PDV" = s."CNPJ"
    LEFT JOIN trade_fv.fato_adequacao_estoque_unpivot uni
           ON uni."CNPJ" = s."CNPJ" AND uni."EAN" = s."EAN"
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.created_at DESC
    LIMIT 500
  `, params);
  res.json(rows);
}));

// ----------------------------------------------------------------------------
// PATCH /api/sugestoes/:id — { acao: 'APROVADA' | 'RECUSADA' } (admin/BI&A)
// ----------------------------------------------------------------------------
app.patch('/api/sugestoes/:id', auth(['admin']), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const acao = String(req.body?.acao || '').toUpperCase();
  if (!Number.isInteger(id) || !['APROVADA', 'RECUSADA'].includes(acao)) {
    return res.status(400).json({ error: 'Ação inválida. Use APROVADA ou RECUSADA.' });
  }

  const { rows } = await pool.query(`
    UPDATE trade_fv.sugestao_fv
    SET status_aprovacao = $1,
        decidido_por = 'BI&A (admin)',
        decidido_em = now(),
        updated_at = now()
    WHERE id = $2 AND status_aprovacao = 'PENDENTE'
    RETURNING id, "CNPJ" AS cnpj, "SKU" AS sku, "Sugestao VB" AS sugestao_vb,
              "Representante" AS representante, status_aprovacao, decidido_em
  `, [acao, id]);

  if (!rows.length) {
    return res.status(404).json({ error: 'Sugestão não encontrada ou já decidida.' });
  }
  res.json(rows[0]);
}));

// ----------------------------------------------------------------------------
// SPA: caminhos de página servem o index.html (roteamento no cliente)
// ----------------------------------------------------------------------------
const ROTAS_SPA = [
  '/login', '/admin', '/admin/aprovacoes', '/representante',
  '/sugerir', '/sugerir/validar', '/sugerir/vb', '/sugerir/enviada',
  '/minhas-sugestoes',
];
app.get(ROTAS_SPA, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`indicacao_pdvs_fv rodando em http://localhost:${PORT}`);
  // novos representantes ativos ganham usuário/senha padrão automaticamente
  sincronizarUsuarios().catch((e) => console.error('sync usuários falhou:', e.message));
  setInterval(() => sincronizarUsuarios().catch((e) => console.error('sync usuários falhou:', e.message)),
    6 * 3600 * 1000);
});
