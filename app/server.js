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
const ExcelJS = require('exceljs');

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
const ADMINS_SEED = ['paulo_lima', 'rubens_filho', 'natalia_miranda', 'fernando_franco'];

// GRs (Gerentes Regionais): cddd.dim_gr não tem coluna de e-mail, então — ao
// contrário dos reps (sincronizados via vw_representantes_ativos) — são
// cadastrados aqui manualmente. cod_gr vem de cddd.dim_gr; usuario/nome são
// derivados do próprio e-mail (mesmo padrão dos admins: fernando.franco@... →
// usuario "fernando_franco", nome "Fernando Franco").
const GRS_SEED = [
  { cod_gr: 9015, email: 'ivan.junior@easelabs.com.br' },
  { cod_gr: 9020, email: 'juliana.goularte@easelabs.com.br' },
  { cod_gr: 9018, email: 'gabriel.bastos@easelabs.com.br' },
];

const identidadeDoEmail = (email) => {
  const local = String(email).split('@')[0];
  const usuario = local.toLowerCase().replace(/[^a-z0-9.]+/g, '').replace(/\./g, '_');
  const nome = local.split('.').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
  return { usuario, nome };
};

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
    cod_gr: u.cod_gr || null,
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

  for (const gr of GRS_SEED) {
    const { usuario, nome } = identidadeDoEmail(gr.email);
    const r = await pool.query(`
      INSERT INTO trade_fv.usuario (usuario, nome, email, role, cod_gr, senha_hash, senha_padrao)
      VALUES ($1, $2, $3, 'gr', $4, $5, TRUE)
      ON CONFLICT (usuario) DO NOTHING
      RETURNING usuario
    `, [usuario, nome, gr.email, gr.cod_gr, hashSenha(SENHA_PADRAO)]);
    if (r.rows.length) resumo.criados.push(usuario);
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

// Territórios (desc_territorio) atualmente sob um GR — via trade_fv.vw_gr_territorios
// (janela ativa da SCD cddd.scd_gr_territorio). Usado para escopar tudo que um
// GR pode ver/filtrar: nunca confiar em filtros vindos do cliente para isso.
const territoriosDoGr = async (codGr) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT desc_territorio FROM trade_fv.vw_gr_territorios
    WHERE cod_gr = $1 AND desc_territorio IS NOT NULL
  `, [codGr]);
  return rows.map((r) => r.desc_territorio);
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
    cod_gr: u.cod_gr || null,
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
    SELECT id, usuario, nome, email, role, cod_gr, desc_territorio, ativo, senha_padrao, ultimo_login
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
// GET /api/representantes — territórios válidos
//   admin: todos (simulação do fluxo) | gr: só a própria equipe (filtro da tela
//   "Indicações da equipe")
// ----------------------------------------------------------------------------
app.get('/api/representantes', auth(['admin', 'gr']), asyncRoute(async (req, res) => {
  const isGr = req.role === 'gr';
  const team = isGr ? await territoriosDoGr(req.sessao.cod_gr) : null;
  const { rows } = await pool.query(`
    SELECT fv.desc_territorio,
           COUNT(DISTINCT p."CNPJ_PDV") AS qtd_pdvs
    FROM cddd.forca_vendas fv
    LEFT JOIN tdd.dim_pdv p ON p."UTC_PDV" = fv.cod_utc
    WHERE fv.desc_territorio IS NOT NULL
      AND fv.desc_territorio <> 'SEM REP'
      ${isGr ? 'AND fv.desc_territorio = ANY($1::text[])' : ''}
    GROUP BY fv.desc_territorio
    ORDER BY fv.desc_territorio
  `, isGr ? [team] : []);
  res.json(rows);
}));

// ----------------------------------------------------------------------------
// GET /api/dashboard — indicadores da home do administrador
// ----------------------------------------------------------------------------
app.get('/api/dashboard', auth(['admin']), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM trade_fv.sugestao_fv
        WHERE status_aprovacao = 'PENDENTE')                       AS pendentes,
      (SELECT COUNT(*) FROM trade_fv.sugestao_fv
        WHERE status_aprovacao = 'APROVADA'
          AND decidido_em >= date_trunc('month', now()))           AS aprovadas_mes,
      (SELECT COUNT(*) FROM trade_fv.usuario
        WHERE role = 'rep' AND ativo)                              AS reps_ativos,
      (SELECT COUNT(*) FROM trade_fv.fato_adequacao_estoque)       AS pdvs_mapeados
  `);
  res.json(rows[0]);
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
// remove acentos do termo digitado (a base está sem acentos)
const semAcento = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

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
  let ordemRelevancia = '';

  if (digits.length >= 4 && digits.length === q.replace(/[.\-\/\s]/g, '').length) {
    // busca por CNPJ: compara os dígitos (bigint perde zeros à esquerda)
    params.push(`%${digits}%`);
    where.push(`p."CNPJ_PDV"::text LIKE $${params.length}`);
  } else {
    // A base está sem acentos (só ~2 linhas em 28 mil têm), então normalizar o
    // termo digitado resolve: "Goiânia" casa com "GOIANIA", "São Paulo" com "SAO PAULO".
    const qNorm = semAcento(normalizarRedesNaBusca(q)).trim();
    const tokens = qNorm.split(/\s+/).filter(Boolean).slice(0, 6);

    for (const token of tokens) {
      params.push(`%${token}%`);
      where.push(`(p."DESC_PDV" ILIKE $${params.length} OR p."CIDADE_PDV" ILIKE $${params.length}
                   OR p."BAIRRO_PDV" ILIKE $${params.length} OR p."ENDERECO_PDV" ILIKE $${params.length}
                   OR f.provedor_pdv ILIKE $${params.length})`);
    }

    params.push(qNorm);
    const iFrase = params.length;          // termo inteiro, p/ casar cidade/bairro exatos
    params.push(tokens);
    const iTokens = params.length;         // palavras soltas, p/ casar a rede

    // Relevância: cidade exata primeiro (é como o rep pensa: "quero em Goiânia"),
    // depois bairro, depois a rede digitada. Sem isso, buscar uma cidade grande
    // devolvia 15 PDVs quaisquer entre centenas.
    ordemRelevancia = `
      (p."CIDADE_PDV" ILIKE $${iFrase}) DESC,
      (p."CIDADE_PDV" ILIKE ANY($${iTokens}::text[])) DESC,
      (p."BAIRRO_PDV" ILIKE $${iFrase}) DESC,
      (f.provedor_pdv ILIKE ANY($${iTokens}::text[])) DESC,`;
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
    ORDER BY ${ordemRelevancia} (p."DESC_SITUACAO" = 'ATIVA') DESC,
             p."CIDADE_PDV", p."BAIRRO_PDV", p."ENDERECO_PDV"
    LIMIT 25
  `, params);

  res.json(rows);
}));

// ----------------------------------------------------------------------------
// GET /api/pdv/:cnpj — detalhe qualitativo + categoria + adequação + sugestões
// ----------------------------------------------------------------------------
app.get('/api/pdv/:cnpj', auth(), asyncRoute(async (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, '');
  if (!cnpj) return res.status(400).json({ error: 'CNPJ inválido' });

  const isGr = req.role === 'gr';
  const grTag = isGr ? `${req.sessao.nome} (GR)` : null;
  const teamTerritorios = isGr ? await territoriosDoGr(req.sessao.cod_gr) : [];

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
    // sugestões existentes: admin vê tudo; GR vê as da própria equipe (+ as que
    // ele mesmo enviou); rep não vê histórico (nem o próprio)
    req.role === 'admin' ? pool.query(`
      SELECT "EAN" AS ean, "SKU" AS sku, "Sugestao VB" AS sugestao_vb,
             "Representante" AS representante, status_aprovacao,
             created_at, decidido_em
      FROM trade_fv.sugestao_fv
      WHERE "CNPJ" = $1
      ORDER BY created_at DESC
    `, [cnpj]) : isGr ? pool.query(`
      SELECT "EAN" AS ean, "SKU" AS sku, "Sugestao VB" AS sugestao_vb,
             "Representante" AS representante, status_aprovacao,
             created_at, decidido_em
      FROM trade_fv.sugestao_fv
      WHERE "CNPJ" = $1 AND ("Representante" = ANY($2::text[]) OR "Representante" = $3)
      ORDER BY created_at DESC
    `, [cnpj, teamTerritorios, grTag]) : { rows: [] },
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

// ============================================================================
//  RECOMENDAÇÃO DE VB POR IA
//
//  Desenho: o modelo NÃO faz aritmética de regra. O código calcula a faixa
//  tecnicamente coerente (a partir do "Estoque Ideal" do BI, que já aplica a
//  regra oficial) e a situação do estoque já comparada; o modelo escolhe dentro
//  da faixa e escreve a justificativa. O número volta "clampado" na faixa.
//  Motivo: modelos pequenos erram a aplicação da regra (testado: qwen2.5:3b
//  sugeria VB 1 para um PDV com média de 12,7 un/mês). Assim o pior caso da IA
//  é uma justificativa fraca, nunca um número perigoso.
//
//  Provedor: fala o dialeto OpenAI (/v1/chat/completions), que o Ollama expõe.
//  Para trocar por uma API paga, basta apontar IA_URL/IA_MODELO/IA_API_KEY.
// ============================================================================
const IA_URL = process.env.IA_URL || 'http://localhost:11434/v1/chat/completions';
const IA_MODELO = process.env.IA_MODELO || 'qwen2.5:3b';
const IA_API_KEY = process.env.IA_API_KEY || '';
const IA_TIMEOUT_MS = Number(process.env.IA_TIMEOUT_MS || 90000);

const IA_SISTEMA = `Você é um analista de trade marketing que revisa as sugestões de Volume Base (VB) feitas por um representante de vendas para um ponto de venda (PDV).

IDIOMA: escreva em português do Brasil correto e acentuado. Nunca use palavras em espanhol
(é "média mensal", nunca "media mensual"). Nunca escreva palavras em CAIXA ALTA.

TOM: objetivo, diplomático e profissional. Fale como um colega experiente comentando o
trabalho do outro. Trate o representante por "você".

REGRA ABSOLUTA SOBRE OS DADOS: todas as comparações já vêm prontas no campo "Leitura".
Apenas transcreva-as em linguagem natural. Nunca recalcule, nunca invente números, nunca
cite um número que não esteja nos dados fornecidos.

VOCABULÁRIO PERMITIDO (não use nenhum outro termo técnico):
VB, Categoria, média mensal, unidades por mês, estoque atual, PDV, rede, ruptura,
alto potencial, baixo potencial, positivar, sugestão do BI.
Não fale de margem, giro, markup, ROI, curva ABC, supply chain, lead time ou afins.

ESTILO: prosa natural e corrida. Não copie a Leitura com parênteses, ponto-e-vírgula ou
caixa alta — traduza para frases normais.

FORMATO DA RESPOSTA — JSON válido, sem texto em volta:
{
  "contexto": "<1 ou 2 frases: comece por 'Este PDV da rede <REDE>' e diga se é de Categoria Alta ou Categoria Baixa>",
  "comentarios": [
    {"sku": "<nome exato do SKU>", "texto": "<1 ou 2 frases sobre o VB que você, representante, propôs para este SKU>"}
  ]
}

EXEMPLO do estilo esperado (não copie os números, são de outro PDV):
{
  "contexto": "Este PDV da rede Pague Menos é de Categoria Alta, com cobertura de força de vendas e vendas recentes.",
  "comentarios": [
    {"sku": "Isolado 30 mL", "texto": "O VB 6 que você sugeriu está em linha com a média de 5,3 unidades por mês e coincide com a sugestão do BI. Proposta coerente."},
    {"sku": "Extrato", "texto": "O VB 2 que você sugeriu é menor que a média de 8,0 unidades dispensadas por mês neste PDV, o que traz risco de ruptura antes da próxima visita."}
  ]
}

Faça um comentário para CADA SKU listado, na mesma ordem, usando o nome exato do SKU.
Comece cada comentário com "O VB <número> que você sugeriu".
Cada comentário deve ter no máximo 220 caracteres.
Quando a Leitura apontar que o VB proposto é menor que a média mensal, diga com clareza que
há risco de ruptura antes da próxima visita. Quando for maior, diga que sobra estoque parado
no PDV. Quando estiver em linha, confirme que a proposta está coerente.`;

// nome de exibição das redes (espelha o REDE_LABEL do front)
const REDE_LABEL_SRV = {
  ARAUJO: 'Araujo', CLAMED: 'Clamed', DPSP: 'DPSP', DROGAL: 'Drogal',
  INDIANA: 'Indiana', PAGUEMENOS: 'Pague Menos', PANVEL: 'Panvel',
  RAIA: 'Raia Drogasil', SAOJOAO: 'São João', VENANCIO: 'Venâncio',
};

// Todas as comparações são feitas aqui, em código — o modelo só transcreve.
const lerProposta = (vb, media, ideal) => {
  const m = Number(media) || 0;
  const i = Number(ideal) || 0;
  const partes = [];
  let alerta = null;

  if (m === 0) {
    partes.push('nao ha dispensacao registrada deste produto no periodo');
  } else if (vb < Math.floor(m)) {
    partes.push(`o VB proposto (${vb}) e MENOR que a media mensal (${m.toFixed(1)} un/mes)`);
    alerta = 'abaixo';
  } else if (vb > Math.ceil(m) + 1) {
    partes.push(`o VB proposto (${vb}) e MAIOR que a media mensal (${m.toFixed(1)} un/mes)`);
    alerta = 'acima';
  } else {
    partes.push(`o VB proposto (${vb}) esta EM LINHA com a media mensal (${m.toFixed(1)} un/mes)`);
  }

  if (vb === i) partes.push(`e IGUAL a sugestao do BI (${i})`);
  else if (vb < i) partes.push(`e ABAIXO da sugestao do BI (${i})`);
  else partes.push(`e ACIMA da sugestao do BI (${i})`);

  return { leitura: partes.join('; ') + '.', alerta };
};

// Texto determinístico usado quando a IA não está disponível ou responde fora do
// formato — o representante nunca fica sem a leitura, só sem a redação da IA.
const revisaoFallback = (pdv, itens) => ({
  contexto: `Este PDV da rede ${pdv.rede} é de Categoria ${pdv.categoria ?? '—'}`
    + `${pdv.altoPotencial ? ' (alto potencial)' : ' (baixo potencial)'}`
    + `${pdv.cobertura === 'Sim' ? ', com cobertura de força de vendas' : ', sem cobertura de força de vendas'}.`,
  comentarios: itens.map((it) => ({
    sku: it.sku,
    texto: it.leitura.charAt(0).toUpperCase() + it.leitura.slice(1),
  })),
});

app.post('/api/revisao', auth(), asyncRoute(async (req, res) => {
  const cnpj = String(req.body?.cnpj || '').replace(/\D/g, '');
  const propostas = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (!cnpj || !propostas.length) {
    return res.status(400).json({ error: 'Informe o CNPJ e ao menos um SKU.' });
  }

  const eans = propostas.map((i) => String(i.ean));
  const { rows } = await pool.query(`
    SELECT u."EAN" AS ean, u."SKU" AS sku, u."Rede" AS rede, u."CAT" AS categoria,
           u."Cobertura FV" AS cobertura, u."Ultima Venda (dias)" AS ultima_venda,
           u."Estoque Atual" AS estoque_atual, u."Estoque Ideal" AS estoque_ideal,
           u."Média Mensal" AS media_mensal, u."Ajuste" AS ajuste,
           p."CIDADE_PDV" AS cidade, p."UF_PDV" AS uf
    FROM trade_fv.fato_adequacao_estoque_unpivot u
    LEFT JOIN tdd.dim_pdv p ON p."CNPJ_PDV" = u."CNPJ"
    WHERE u."CNPJ" = $1 AND u."EAN" = ANY($2::text[])
  `, [cnpj, eans]);

  if (!rows.length) {
    return res.status(404).json({ error: 'Sem dados de adequação para este PDV.' });
  }

  const base = rows[0];
  // POTENCIAL conforme a regra 4.2: INDIANA -> CAT <= 7; demais -> CAT <= 4
  const cat = Number(base.categoria);
  const altoPotencial = Number.isFinite(cat) &&
    (base.rede === 'INDIANA' ? cat <= 7 : cat <= 4);
  const redeNome = REDE_LABEL_SRV[base.rede] || base.rede;
  const pdv = {
    rede: redeNome, categoria: base.categoria, cobertura: base.cobertura,
    cidade: base.cidade, uf: base.uf, altoPotencial,
  };

  // monta os itens na ordem em que o representante propôs
  const itens = propostas.map((p) => {
    const d = rows.find((r) => r.ean === String(p.ean));
    if (!d) return null;
    const vb = Math.max(0, Math.round(Number(p.vb)) || 0);
    const { leitura, alerta } = lerProposta(vb, d.media_mensal, d.estoque_ideal);
    return {
      ean: d.ean, sku: d.sku, vb, alerta, leitura,
      estoque_atual: Number(d.estoque_atual) || 0,
      media_mensal: Number(d.media_mensal) || 0,
      vb_bi: Number(d.estoque_ideal) || 0,
    };
  }).filter(Boolean);

  if (!itens.length) return res.status(404).json({ error: 'SKUs não encontrados na base.' });

  const ultima = Number(base.ultima_venda) >= 2000
    ? 'o PDV nunca registrou venda'
    : `${base.ultima_venda} dias desde a ultima venda`;

  const contextoUsuario = [
    `REDE (use exatamente este nome no contexto): ${redeNome}`,
    `Cidade: ${base.cidade || '-'}/${base.uf || '-'}`,
    `Categoria do PDV: ${base.categoria ?? 'nao informada'} — trate como ${altoPotencial ? 'Categoria ALTA (alto potencial)' : 'Categoria BAIXA (baixo potencial)'}`,
    `Cobertura de forca de vendas: ${base.cobertura || '-'} | ${ultima}`,
    '',
    'SKUs propostos pelo representante:',
    ...itens.map((it, n) => [
      `${n + 1}) ${it.sku}`,
      `   VB proposto: ${it.vb} | estoque atual: ${it.estoque_atual} | media mensal: ${it.media_mensal.toFixed(1)} un/mes | sugestao do BI: ${it.vb_bi}`,
      `   Leitura: ${it.leitura}`,
    ].join('\n')),
  ].join('\n');

  const fallback = revisaoFallback(pdv, itens);

  try {
    const resp = await fetch(IA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(IA_TIMEOUT_MS),
      headers: Object.assign({ 'Content-Type': 'application/json' },
        IA_API_KEY ? { Authorization: `Bearer ${IA_API_KEY}` } : {}),
      body: JSON.stringify({
        model: IA_MODELO,
        temperature: 0.15,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: IA_SISTEMA },
          { role: 'user', content: contextoUsuario },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`modelo respondeu ${resp.status}`);

    const bruto = (await resp.json()).choices?.[0]?.message?.content ?? '';
    let parsed = null;
    try { parsed = JSON.parse(bruto); }
    catch {
      const m = bruto.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* segue nulo */ } }
    }
    if (!parsed?.contexto || !Array.isArray(parsed.comentarios)) {
      throw new Error('resposta fora do formato');
    }

    // casa cada comentário com o SKU correspondente; o que faltar usa o fallback
    const comentarios = itens.map((it, n) => {
      const achado = parsed.comentarios.find(
        (c) => String(c.sku || '').trim().toLowerCase() === it.sku.toLowerCase()
      ) || parsed.comentarios[n];
      const texto = achado?.texto ? String(achado.texto).slice(0, 300) : fallback.comentarios[n].texto;
      return { ean: it.ean, sku: it.sku, vb: it.vb, alerta: it.alerta, texto };
    });

    res.json({
      contexto: String(parsed.contexto).slice(0, 400),
      comentarios,
      modelo: IA_MODELO,
      origem: 'ia',
    });
  } catch (err) {
    console.error('[IA revisão]', err.message);
    // degrada para a leitura determinística — o fluxo nunca trava por causa da IA
    res.json({
      contexto: fallback.contexto,
      comentarios: itens.map((it, n) => ({
        ean: it.ean, sku: it.sku, vb: it.vb, alerta: it.alerta,
        texto: fallback.comentarios[n].texto,
      })),
      modelo: IA_MODELO,
      origem: 'fallback',
      aviso: 'O assistente de IA não respondeu; abaixo está a leitura automática dos números.',
    });
  }
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
  // RLS: rep sempre registra no próprio território; GR registra com identidade
  // própria (não pode se passar por um rep do time); admin informa qual simula.
  const representante = modoBia
    ? 'BI&A'
    : req.role === 'rep' ? req.sessao.territorio
    : req.role === 'gr' ? `${req.sessao.nome} (GR)`
    : (req.body?.representante || '').trim();

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

  // Sugerir exatamente o VB que o BI já sugere não é uma sugestão. O front
  // barra antes de enviar; aqui é a garantia no servidor.
  const idealAtual = snap.rows[0]?.['Estoque Ideal'];
  if (!modoBia && idealAtual != null && Number(idealAtual) === vb) {
    return res.status(409).json({
      error: `O VB ${vb} que você sugeriu para ${SKU_POR_EAN[ean]} já é o VB sugerido atualmente neste PDV. Ajuste o valor e tente novamente.`,
    });
  }

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
// Filtros de GET /api/sugestoes e GET /api/sugestoes/exportar — MESMA regra de
// RLS e de filtros nos dois lugares (nunca duplicar/deixar divergir a lógica).
//   admin: ?rep= | ?cnpj= | ?all=1[&rep=&status=&data_de=&data_ate=]
//   gr:    [&rep=&cnpj=&status=&data_de=&data_ate=] — sempre escopado à equipe
//   rep:   sempre as próprias (sem filtros livres)
// ----------------------------------------------------------------------------
const montarFiltroSugestoes = async (req) => {
  const isAdmin = req.role === 'admin';
  const isGr = req.role === 'gr';

  const teamTerritorios = isGr ? await territoriosDoGr(req.sessao.cod_gr) : [];
  const grTag = isGr ? `${req.sessao.nome} (GR)` : null;
  const repFiltroGr = isGr ? (req.query.rep || '').trim() : '';

  const rep = isAdmin ? (req.query.rep || '').trim() : (isGr ? '' : (req.sessao.territorio || ''));
  const cnpj = (isAdmin || isGr) ? (req.query.cnpj || '').replace(/\D/g, '') : '';
  const all = isAdmin && req.query.all === '1';
  const status = (isAdmin || isGr) ? (req.query.status || '').trim().toUpperCase() : '';
  const dataRe = /^\d{4}-\d{2}-\d{2}$/;
  const dataDe = (isAdmin || isGr) && dataRe.test(req.query.data_de || '') ? req.query.data_de : '';
  const dataAte = (isAdmin || isGr) && dataRe.test(req.query.data_ate || '') ? req.query.data_ate : '';

  const semFiltro = !all && !rep && !cnpj && !isGr;

  const where = [];
  const params = [];
  if (rep) { params.push(rep); where.push(`s."Representante" = $${params.length}`); }
  if (isGr) {
    if (repFiltroGr && teamTerritorios.includes(repFiltroGr)) {
      params.push(repFiltroGr); where.push(`s."Representante" = $${params.length}`);
    } else {
      params.push([...teamTerritorios, grTag]);
      where.push(`s."Representante" = ANY($${params.length}::text[])`);
    }
  }
  if (cnpj) { params.push(cnpj); where.push(`s."CNPJ" = $${params.length}`); }
  if (['PENDENTE', 'APROVADA', 'RECUSADA'].includes(status)) {
    params.push(status); where.push(`s.status_aprovacao = $${params.length}`);
  }
  // O banco roda em UTC, mas a tela mostra/pensa a data em horário de Brasília
  // (fmtData usa o fuso do navegador). Sem isso, uma sugestão enviada de
  // madrugada (ex.: 23h de Brasília = já é o dia seguinte em UTC) passava no
  // filtro de um dia que a tela nunca mostrou para aquela linha.
  if (dataDe) { params.push(dataDe); where.push(`s.created_at >= ($${params.length}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`); }
  if (dataAte) { params.push(dataAte); where.push(`s.created_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`); }

  return { where, params, semFiltro };
};

const SQL_SUGESTOES_SELECT = `
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
         ON uni."CNPJ" = s."CNPJ" AND uni."EAN" = s."EAN"`;

app.get('/api/sugestoes', auth(), asyncRoute(async (req, res) => {
  const { where, params, semFiltro } = await montarFiltroSugestoes(req);
  if (semFiltro) return res.json([]);

  const { rows } = await pool.query(`
    ${SQL_SUGESTOES_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.created_at DESC
    LIMIT 500
  `, params);
  res.json(rows);
}));

// ----------------------------------------------------------------------------
// GET /api/sugestoes/exportar — .xlsx formatado, respeitando os MESMOS filtros
// de GET /api/sugestoes (rep=/cnpj=/status=/data_de=/data_ate=[&all=1, admin]).
// ----------------------------------------------------------------------------
const STATUS_LABEL_SRV = { PENDENTE: 'Em análise', APROVADA: 'Atendido', RECUSADA: 'Inviável' };
const STATUS_FILL_SRV = { PENDENTE: 'FFFFF3CD', APROVADA: 'FFD4F4DD', RECUSADA: 'FFFDE0E0' };

const formatarCnpjSrv = (c) => {
  const d = String(c || '').padStart(14, '0');
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : c;
};

app.get('/api/sugestoes/exportar', auth(['admin', 'gr']), asyncRoute(async (req, res) => {
  const { where, params, semFiltro } = await montarFiltroSugestoes(req);
  if (semFiltro) return res.status(400).json({ error: 'Informe ao menos um filtro para exportar.' });

  const { rows } = await pool.query(`
    ${SQL_SUGESTOES_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.created_at DESC
    LIMIT 5000
  `, params);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ease Labs — Indicação de PDVs';
  wb.created = new Date();
  const ws = wb.addWorksheet('Indicações', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { header: 'Enviada', key: 'enviada', width: 16 },
    { header: 'Representante', key: 'rep', width: 26 },
    { header: 'PDV', key: 'pdv', width: 32 },
    { header: 'CNPJ', key: 'cnpj', width: 20 },
    { header: 'Cidade', key: 'cidade', width: 22 },
    { header: 'UF', key: 'uf', width: 6 },
    { header: 'Rede', key: 'rede', width: 16 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'Estoque Atual', key: 'estoque', width: 14 },
    { header: 'VB Sugerido BI', key: 'vb_bi', width: 15 },
    { header: 'VB Sugerido REP', key: 'vb_rep', width: 16 },
    { header: 'Und/mês', key: 'media', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
  ];

  rows.forEach((r) => {
    ws.addRow({
      enviada: r.created_at ? new Date(r.created_at) : null,
      rep: r.representante,
      pdv: r.nome_pdv || '',
      cnpj: formatarCnpjSrv(r.cnpj),
      cidade: r.cidade || '',
      uf: r.uf || '',
      rede: REDE_LABEL_SRV[r.rede] || r.rede || '',
      sku: r.sku,
      estoque: r.estoque_atual != null ? Number(r.estoque_atual) : null,
      vb_bi: r.estoque_ideal != null ? Number(r.estoque_ideal) : null,
      vb_rep: Number(r.sugestao_vb),
      media: r.media_mensal != null ? Number(r.media_mensal) : null,
      status: STATUS_LABEL_SRV[r.status_aprovacao] || r.status_aprovacao,
    });
  });

  ws.getColumn('enviada').numFmt = 'dd/mm/yyyy hh:mm';
  ['estoque', 'vb_bi', 'vb_rep'].forEach((k) => { ws.getColumn(k).numFmt = '0'; });
  ws.getColumn('media').numFmt = '0.0';

  // cabeçalho: fundo roxo da marca (--primary-600), texto branco, negrito
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5558D4' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // zebra striping + status colorido (mesma paleta dos badges da tela)
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    const zebra = i % 2 === 1 ? 'FFF7F8FA' : 'FFFFFFFF';
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } };
      cell.alignment = { vertical: 'middle' };
    });
    const statusCell = row.getCell('status');
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL_SRV[r.status_aprovacao] || zebra } };
    statusCell.font = { bold: true };
    statusCell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  ws.autoFilter = { from: 'A1', to: 'M1' };

  const nomeArquivo = `indicacoes_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  await wb.xlsx.write(res);
  res.end();
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

  // registra QUEM decidiu (mesmo formato do modo BI&A no POST): "BI&A (Nome)"
  const decididoPor = `BI&A (${req.sessao.nome || req.sessao.usuario})`;
  const { rows } = await pool.query(`
    UPDATE trade_fv.sugestao_fv
    SET status_aprovacao = $1,
        decidido_por = $2,
        decidido_em = now(),
        updated_at = now()
    WHERE id = $3 AND status_aprovacao = 'PENDENTE'
    RETURNING id, "CNPJ" AS cnpj, "SKU" AS sku, "Sugestao VB" AS sugestao_vb,
              "Representante" AS representante, status_aprovacao, decidido_em
  `, [acao, decididoPor, id]);

  if (!rows.length) {
    return res.status(404).json({ error: 'Sugestão não encontrada ou já decidida.' });
  }
  res.json(rows[0]);
}));

// ----------------------------------------------------------------------------
// Health check — usado pelo target group do ALB (AWS). Sem auth de propósito
// (o ALB não manda X-Auth-Token). Confere conexão real com o banco, não só
// "o processo Node está de pé" — um app sem banco não serve pra nada.
// ----------------------------------------------------------------------------
app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
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
  // Aquece o modelo: a 1ª chamada carrega os pesos na memória e leva ~70s;
  // depois de quente responde em ~2s. Falha aqui é irrelevante (o endpoint
  // degrada sozinho se a IA não estiver disponível).
  fetch(IA_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: Object.assign({ 'Content-Type': 'application/json' },
      IA_API_KEY ? { Authorization: `Bearer ${IA_API_KEY}` } : {}),
    body: JSON.stringify({ model: IA_MODELO, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  }).then(() => console.log(`IA pronta (${IA_MODELO})`))
    .catch((e) => console.log(`IA indisponível no boot (${e.message}) — o app segue sem recomendação`));

  // novos representantes ativos ganham usuário/senha padrão automaticamente
  sincronizarUsuarios().catch((e) => console.error('sync usuários falhou:', e.message));
  setInterval(() => sincronizarUsuarios().catch((e) => console.error('sync usuários falhou:', e.message)),
    6 * 3600 * 1000);
});
