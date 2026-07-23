/* ============================================================
   Ease Labs — Indicação de PDVs (Força de Vendas)
   ============================================================ */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    auth: null,         // { role: 'admin'|'rep', token }
    reps: [],
    rep: null,
    bia: false,         // admin ajustando VB diretamente como BI&A
    redes: [],          // redes da base de adequação (p/ cadastro manual)
    pdv: null,          // detalhe retornado por /api/pdv/:cnpj (ou montado manualmente)
    skuSelecionado: null, // ean
    vb: 1,
  };

  const SKUS = [
    { sku: 'Isolado 30 mL',       ean: '7896806601243' },
    { sku: 'Isolado 10 mL',       ean: '7896806601281' },
    { sku: 'Isolado 20 mg 30 mL', ean: '7896806601328' },
    { sku: 'Extrato',             ean: '7896806601250' },
  ];

  // cor de identidade de cada SKU (etapa de sugestão)
  const SKU_COLOR = {
    'Isolado 30 mL':       '#5661E8',
    'Isolado 10 mL':       '#94A8F7',
    'Isolado 20 mg 30 mL': '#C8A8F7',
    'Extrato':             '#6ECC64',
  };

  // nome canônico na base → nome de exibição
  const REDE_LABEL = {
    'ARAUJO':     'Araujo',
    'CLAMED':     'Clamed',
    'DPSP':       'DPSP',
    'DROGAL':     'Drogal',
    'INDIANA':    'Indiana',
    'PAGUEMENOS': 'Pague Menos',
    'PANVEL':     'Panvel',
    'RAIA':       'Raia Drogasil',
    'SAOJOAO':    'São João',
    'VENANCIO':   'Venâncio',
  };
  const redeLabel = (r) => REDE_LABEL[r] || titleCase(r || '');

  const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

  // ---------------------------------------------------------- helpers
  const fmtCNPJ = (v) => {
    const d = String(v).replace(/\D/g, '').padStart(14, '0');
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  };

  const fmtData = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  // Média mensal (Und/mês): 1 casa decimal, sem .0 desnecessário
  const fmtMedia = (v) => {
    if (v == null) return '—';
    const n = Math.round(Number(v) * 10) / 10;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };

  const iniciais = (nome) =>
    nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

  const titleCase = (s) =>
    String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

  // nome do "representante" para exibição (preserva o marcador BI&A)
  const repDisplay = (r) => (r === 'BI&A' ? 'BI&A' : titleCase(r));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const AJUSTE_BADGE = {
    'Positivar':   'badge-green',
    'Aumentar VB': 'badge-primary',
    'Manter':      'badge-gray',
    'Diminuir VB': 'badge-warning',
    'Inativar':    'badge-error',
  };
  const STATUS_SUG_BADGE = {
    'PENDENTE': 'badge-warning',
    'APROVADA': 'badge-green',
    'RECUSADA': 'badge-error',
  };
  const STATUS_SUG_LABEL = {
    'PENDENTE': 'Pendente BI&A',
    'APROVADA': 'Aprovada',
    'RECUSADA': 'Recusada',
  };

  const toast = (msg, isError = false) => {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = `toast${isError ? ' toast-error' : ''}`;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><span>${esc(msg)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5200);
  };

  const api = async (url, opts = {}) => {
    opts.headers = Object.assign({}, opts.headers, state.auth ? { 'X-Auth-Token': state.auth.token } : {});
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && state.auth) { logout(); throw new Error(body.error || 'Sessão expirada.'); }
    if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
    return body;
  };

  // ---------------------------------------------------------- navegação / rotas
  const ROTA = {
    'login': '/login',
    'admin': '/admin',
    'aprovacoes': '/admin/aprovacoes',
    'usuarios': '/admin/usuarios',
    'senha': '/senha',
    1: '/representante',
    2: '/sugerir',
    3: '/sugerir/validar',
    4: '/sugerir/vb',
    5: '/sugerir/enviada',
  };

  const goTo = (n, historico = 'push') => {
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    $(`#panel-${n}`).classList.add('active');

    if (historico && ROTA[n] && location.pathname !== ROTA[n]) {
      history[historico === 'replace' ? 'replaceState' : 'pushState']({ panel: n }, '', ROTA[n]);
    }
    if (n === 1) {
      $('#btnEtapa1VoltarAdmin').style.display = state.auth?.role === 'admin' ? '' : 'none';
    }
    if (n === 2) {
      $('#btnEtapa2Voltar').style.display = state.auth?.role === 'admin' ? '' : 'none';
    }

    const isEtapa = typeof n === 'number';
    $('#stepper').style.display = isEtapa ? '' : 'none';
    if (isEtapa) {
      const stepVisual = Math.min(n, 4);
      document.querySelectorAll('.step').forEach((s) => {
        const num = Number(s.dataset.step);
        s.classList.toggle('active', num === stepVisual);
        s.classList.toggle('done', num < stepVisual || n === 5);
        const dot = s.querySelector('.step-dot');
        if (num < stepVisual || n === 5) {
          dot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
        } else {
          dot.textContent = num;
        }
      });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // resolve um caminho de URL para um painel, aplicando as regras de acesso
  const irParaRota = (path, historico = 'replace') => {
    let alvo = Object.keys(ROTA).find((k) => ROTA[k] === path);
    alvo = alvo === undefined ? null : (/^\d+$/.test(alvo) ? Number(alvo) : alvo);

    const isAdmin = state.auth?.role === 'admin';
    const temCtx = state.rep || state.bia; // rep escolhido ou modo BI&A
    if (!state.auth) alvo = 'login';
    else if (alvo === null || alvo === 'login') alvo = isAdmin ? 'admin' : 2;
    else if ((alvo === 'admin' || alvo === 'aprovacoes' || alvo === 'usuarios') && !isAdmin) alvo = 2;
    else if (alvo === 1 && !isAdmin) alvo = 2; // rep já está no próprio território
    else if (typeof alvo === 'number' && alvo >= 3 && !state.pdv) alvo = temCtx ? 2 : (isAdmin ? 'admin' : 2);
    else if (alvo === 2 && !temCtx) alvo = isAdmin ? 'admin' : 2;

    if (alvo === 'aprovacoes') carregarAprovacoes();
    if (alvo === 'usuarios') carregarUsuarios();
    if (alvo === 3 && state.pdv) renderValidacao();
    if (alvo === 4 && state.pdv) renderSkus();
    goTo(alvo, ROTA[alvo] === path ? false : historico);
  };

  window.addEventListener('popstate', () => irParaRota(location.pathname, 'replace'));

  // ---------------------------------------------------------- auth
  const atualizarHeader = () => {
    const logado = !!state.auth;
    const wrap = $('#headerUser');
    wrap.classList.toggle('visible', logado);
    if (!logado) return;

    const isAdmin = state.auth.role === 'admin';
    $('#headerRole').style.display = isAdmin ? '' : 'none';
    $('#headerRole').textContent = 'Administrador';
    const nomeExibir = isAdmin ? (state.rep ? titleCase(state.rep) : state.auth.nome) : state.auth.nome;
    if (nomeExibir) {
      $('#headerUserNameWrap').style.display = '';
      $('#headerUserAvatar').style.display = '';
      $('#headerUserName').textContent = nomeExibir;
      $('#headerUserRole').textContent = isAdmin
        ? (state.rep ? 'Representante (simulação)' : 'BI&A')
        : 'Representante';
      $('#headerUserAvatar').textContent = iniciais(nomeExibir);
    } else {
      $('#headerUserNameWrap').style.display = 'none';
      $('#headerUserAvatar').style.display = 'none';
    }
    // "Trocar" só faz sentido para admin simulando representantes
    $('#btnTrocarRep').style.display = isAdmin && state.rep ? '' : 'none';
  };

  const entrar = async () => {
    const btn = $('#btnLogin');
    btn.disabled = true;
    $('#loginErro').style.display = 'none';
    try {
      const r = await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: $('#loginUser').value, senha: $('#loginPass').value }),
      });
      state.auth = r;
      localStorage.setItem('tfv_auth', JSON.stringify(r));
      $('#loginPass').value = '';
      iniciarSessao();
      if (r.senha_padrao) {
        toast('Você ainda usa a senha padrão inicial — recomendamos trocá-la em "Alterar senha".');
      }
    } catch (e) {
      $('#loginErro').textContent = e.message;
      $('#loginErro').style.display = '';
    } finally {
      btn.disabled = false;
    }
  };

  const logout = () => {
    state.auth = null;
    state.rep = null;
    state.bia = false;
    state.pdv = null;
    localStorage.removeItem('tfv_auth');
    $('#repSearch').value = '';
    $('#pdvSearch').value = '';
    $('#pdvResults').innerHTML = '';
    atualizarHeader();
    goTo('login');
    setTimeout(() => $('#loginUser').focus(), 300);
  };

  const iniciarSessao = () => {
    // RLS: o representante entra amarrado ao próprio território
    if (state.auth.role === 'rep') state.rep = state.auth.territorio;
    atualizarHeader();
    if (state.auth.role === 'admin') carregarReps();
    carregarRedes();
    irParaRota(location.pathname, 'replace');
  };

  // ---------------------------------------------------------- etapa 1: representante
  const renderReps = (filtro = '') => {
    const list = $('#repList');
    const f = filtro.trim().toLowerCase();
    const reps = state.reps.filter((r) => r.desc_territorio.toLowerCase().includes(f));
    if (!reps.length) {
      list.innerHTML = '<div class="search-empty">Nenhum representante encontrado.</div>';
      return;
    }
    list.innerHTML = reps.map((r, i) => `
      <button class="rep-card" data-rep="${esc(r.desc_territorio)}" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <div class="avatar">${esc(iniciais(r.desc_territorio))}</div>
        <div>
          <div class="rep-name">${esc(titleCase(r.desc_territorio))}</div>
        </div>
      </button>
    `).join('');
    list.querySelectorAll('.rep-card').forEach((btn) =>
      btn.addEventListener('click', () => selecionarRep(btn.dataset.rep)));
  };

  const selecionarRep = (rep) => {
    state.rep = rep;
    state.bia = false;
    atualizarHeader();
    $('#pdvSearch').value = '';
    $('#pdvResults').innerHTML = '';
    goTo(2);
    setTimeout(() => $('#pdvSearch').focus(), 350);
  };

  const carregarReps = async () => {
    try {
      state.reps = await api('/api/representantes');
      renderReps();
      $('#fRep').innerHTML = '<option value="">Todos</option>' +
        state.reps.map((r) => `<option value="${esc(r.desc_territorio)}">${esc(titleCase(r.desc_territorio))}</option>`).join('');
    } catch (e) {
      $('#repList').innerHTML = '<div class="search-empty">Não foi possível carregar os representantes. Recarregue a página.</div>';
    }
  };

  const carregarRedes = async () => {
    try {
      state.redes = await api('/api/redes');
      $('#mRede').innerHTML = '<option value="">Selecione a rede...</option>' +
        state.redes.map((r) => `<option value="${esc(r)}">${esc(redeLabel(r))}</option>`).join('');
    } catch (e) { /* select fica só com o placeholder */ }
  };

  // ---------------------------------------------------------- etapa 2: busca PDV
  let searchTimer = null;
  let searchSeq = 0;

  const buscarPdvs = async () => {
    const q = $('#pdvSearch').value.trim();
    const box = $('#pdvResults');
    if (q.length < 2) { box.innerHTML = ''; return; }
    const seq = ++searchSeq;
    box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    try {
      const rows = await api(`/api/pdvs?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      if (!rows.length) {
        box.innerHTML = '<div class="search-empty">Nenhum PDV encontrado nas redes monitoradas.<br>Revise o termo ou <strong>cadastre o PDV manualmente</strong> logo abaixo.</div>';
        return;
      }
      box.innerHTML = rows.map((p, i) => `
        <button class="pdv-result" data-cnpj="${esc(p.cnpj)}" style="animation-delay:${Math.min(i * 40, 400)}ms">
          <div class="pdv-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M14 9h1M14 13h1M10 21v-4h4v4"/></svg>
          </div>
          <div class="pdv-info">
            <div class="pdv-nome">${esc(redeLabel(p.rede))}</div>
            <div class="pdv-sub">${esc(titleCase(p.endereco || ''))} · ${esc(titleCase(p.cidade || ''))}/${esc(p.uf || '')}</div>
            <div class="pdv-cnpj">${fmtCNPJ(p.cnpj)}</div>
          </div>
          <div class="pdv-badges">
            ${p.categoria != null ? `<span class="badge badge-accent">Categoria ${esc(p.categoria)}</span>` : ''}
            <span class="badge ${p.situacao === 'ATIVA' ? 'badge-green' : 'badge-error'}">${esc(titleCase(p.situacao || '—'))}</span>
          </div>
        </button>
      `).join('');
      box.querySelectorAll('.pdv-result').forEach((btn) =>
        btn.addEventListener('click', () => abrirPdv(btn.dataset.cnpj)));
    } catch (e) {
      if (seq !== searchSeq) return;
      box.innerHTML = '<div class="search-empty">Erro ao buscar. Tente novamente.</div>';
    }
  };

  // ---------------------------------------------------------- etapa 3: validação
  const abrirPdv = async (cnpj) => {
    const card = $('#pdvValidacaoCard');
    goTo(3);
    card.innerHTML = '<div class="card-body"><div class="skeleton"></div></div>';
    try {
      state.pdv = await api(`/api/pdv/${cnpj}`);
      renderValidacao();
    } catch (e) {
      card.innerHTML = `<div class="card-body"><div class="alert alert-warning">${esc(e.message)}</div></div>`;
    }
  };

  // Mapa de localização do PDV (Leaflet + OpenStreetMap, gratuito, sem chave).
  // Sem coordenadas: omite o bloco inteiro, sem placeholder nem mensagem.
  let pdvMapInstance = null;

  const temCoordenadas = (pdv) =>
    pdv.latitude != null && pdv.longitude != null &&
    Number.isFinite(Number(pdv.latitude)) && Number.isFinite(Number(pdv.longitude));

  const renderMapaPdv = (pdv) => {
    if (!temCoordenadas(pdv)) return '';
    return `<div id="pdvMap" class="pdv-map"></div>`;
  };

  // chamado logo após o innerHTML entrar no DOM — inicializa o mapinha Leaflet
  const montarMapaPdv = (pdv) => {
    const el = document.getElementById('pdvMap');
    if (!el || typeof L === 'undefined') return;
    const lat = Number(pdv.latitude), lng = Number(pdv.longitude);
    if (pdvMapInstance) { pdvMapInstance.remove(); pdvMapInstance = null; }
    pdvMapInstance = L.map(el, {
      center: [lat, lng], zoom: 17, zoomControl: false,
      dragging: true, scrollWheelZoom: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(pdvMapInstance);
    L.marker([lat, lng]).addTo(pdvMapInstance);
    L.control.zoom({ position: 'bottomright' }).addTo(pdvMapInstance);
  };

  const renderValidacao = () => {
    const { pdv, adequacao } = state.pdv;
    const temAdequacao = adequacao.length > 0;
    const manual = !!state.pdv.manualRede;
    const rede = temAdequacao ? adequacao[0].rede : state.pdv.manualRede || null;
    const podeContinuar = temAdequacao || manual;

    $('#pdvValidacaoCard').innerHTML = `
      <div class="pdv-hero">
        <div class="pdv-hero-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M14 9h1M14 13h1M10 21v-4h4v4"/></svg>
        </div>
        <div>
          <h3>${esc(manual && !temAdequacao ? titleCase(pdv.nome) : (rede ? redeLabel(rede) : titleCase(pdv.nome)))}</h3>
          <div class="pdv-hero-cnpj">CNPJ ${fmtCNPJ(pdv.cnpj)}</div>
          <div class="pdv-hero-badges">
            ${pdv.situacao ? `<span class="badge ${pdv.situacao === 'ATIVA' ? 'badge-green' : 'badge-error'}">${esc(titleCase(pdv.situacao))}</span>` : ''}
            ${manual && !temAdequacao ? '<span class="badge badge-warning">Cadastro manual</span>' : ''}
            ${pdv.categoria != null ? `<span class="badge badge-accent">Categoria ${esc(pdv.categoria)}</span>` : ''}
            ${temAdequacao ? `<span class="badge ${adequacao[0].cobertura_fv === 'Sim' ? 'badge-green' : 'badge-gray'}">Cobertura FV: ${esc(adequacao[0].cobertura_fv || '—')}</span>` : ''}
          </div>
        </div>
      </div>
      ${renderMapaPdv(pdv)}
      <div class="pdv-detail-grid">
        <div class="pdv-field"><div class="pdv-field-label">Razão social</div><div class="pdv-field-value">${esc(titleCase(pdv.nome || '—'))}</div></div>
        <div class="pdv-field"><div class="pdv-field-label">Endereço</div><div class="pdv-field-value">${esc(titleCase(pdv.endereco || '—'))}</div></div>
        <div class="pdv-field"><div class="pdv-field-label">Bairro</div><div class="pdv-field-value">${esc(titleCase(pdv.bairro || '—'))}</div></div>
        <div class="pdv-field"><div class="pdv-field-label">Cidade / UF</div><div class="pdv-field-value">${esc(titleCase(pdv.cidade || '—'))} / ${esc(pdv.uf || '—')}</div></div>
        <div class="pdv-field"><div class="pdv-field-label">Categoria</div><div class="pdv-field-value">${pdv.categoria != null ? esc(pdv.categoria) : '—'}</div></div>
        <div class="pdv-field"><div class="pdv-field-label">Telefone</div><div class="pdv-field-value">${esc(pdv.telefone || '—')}</div></div>
      </div>
      ${!temAdequacao ? `
        <div style="padding: 0 24px 20px">
          <div class="alert alert-info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
            <span>Este PDV ainda <strong>não está na base de adequação de estoque</strong>, então não há dados de estoque/sell-out. Sua sugestão de VB será registrada mesmo assim.</span>
          </div>
        </div>` : ''}
      <div class="card-footer">
        <button class="btn btn-ghost" id="btnNaoEEsse">Não é esse, voltar</button>
        <button class="btn btn-primary btn-lg" id="btnConfirmarPdv" ${podeContinuar ? '' : 'disabled'}>
          Sim, é esse PDV
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    `;
    $('#btnNaoEEsse').addEventListener('click', () => goTo(2));
    const btnOk = $('#btnConfirmarPdv');
    if (btnOk) btnOk.addEventListener('click', () => { renderSkus(); goTo(4); });
    montarMapaPdv(pdv);
  };

  // ---------------------------------------------------------- etapa 4: SKUs + VB
  const linhaPorEan = (ean) =>
    state.pdv.adequacao.find((x) => x.ean === ean) || SKUS.find((s) => s.ean === ean);

  const renderSkus = () => {
    const { pdv, adequacao } = state.pdv;
    const semDados = adequacao.length === 0;
    state.skuSelecionado = null;
    state.vb = 1;
    $('#submitBar').style.display = 'none';

    const rede = adequacao[0]?.rede || state.pdv.manualRede;
    $('#pdvContextBar').innerHTML = `
      <div class="ctx-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14"/></svg>
      </div>
      <div>
        <div class="ctx-nome">${esc(semDados ? titleCase(pdv.nome) : (rede ? redeLabel(rede) : titleCase(pdv.nome)))}${state.bia ? ' <span class="badge badge-accent">Ajuste BI&A</span>' : ''}</div>
        <div class="ctx-sub">${fmtCNPJ(pdv.cnpj)} · ${esc(titleCase(pdv.cidade || ''))}/${esc(pdv.uf || '')}${pdv.categoria != null ? ` · Categoria ${esc(pdv.categoria)}` : ''}</div>
      </div>
    `;

    // sem adequação (cadastro manual): monta os 4 SKUs sem dados de estoque
    const linhas = semDados
      ? SKUS.map((s) => ({ ...s, estoque_atual: null, estoque_ideal: null, delta: null, ajuste: null }))
      : adequacao;

    const labelVb = state.bia ? 'VB (BI&A):' : 'Meu VB sugerido:';
    $('#skuGrid').innerHTML = linhas.map((a, i) => {
      const delta = a.delta == null ? null : Number(a.delta);
      return `
      <div class="sku-card" data-ean="${esc(a.ean)}" style="animation-delay:${i * 60}ms; --sku-color:${SKU_COLOR[a.sku] || 'var(--border-default)'}">
        <div class="sku-head">
          <div class="sku-title-wrap">
            <div class="radio-indicator"></div>
            <div><span class="sku-dot"></span><span class="sku-nome">${esc(a.sku)}</span></div>
          </div>
          <span class="badge ${AJUSTE_BADGE[a.ajuste] || 'badge-gray'}">Sugestão atual: ${esc(a.ajuste || '—')}</span>
        </div>
        <div class="sku-stats">
          <div class="sku-stat"><div class="sku-stat-label">Estoque atual</div><div class="sku-stat-value">${semDados ? '—' : (a.estoque_atual ?? 0)}</div></div>
          <div class="sku-stat"><div class="sku-stat-label">VB Sugerido Atual</div><div class="sku-stat-value">${a.estoque_ideal ?? '—'}</div></div>
          <div class="sku-stat"><div class="sku-stat-label">Delta</div><div class="sku-stat-value ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : ''}">${delta == null ? '—' : (delta > 0 ? '+' : '') + delta}</div></div>
          <div class="sku-stat"><div class="sku-stat-label">Und / mês</div><div class="sku-stat-value metric">${fmtMedia(a.media_mensal)}</div></div>
        </div>
        <div class="sku-vb-area">
          <div class="sku-vb-inner">
            <span class="vb-label">${labelVb}</span>
            <div class="vb-stepper">
              <button type="button" class="vb-minus" aria-label="Diminuir">−</button>
              <input type="number" class="vb-input" min="0" step="1" value="1">
              <button type="button" class="vb-plus" aria-label="Aumentar">+</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    document.querySelectorAll('.sku-card').forEach((card) => {
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('.sku-vb-area')) return; // não desselecionar mexendo no VB
        selecionarSku(card.dataset.ean);
      });
      card.querySelector('.vb-minus').addEventListener('click', () => ajustarVb(card, -1));
      card.querySelector('.vb-plus').addEventListener('click', () => ajustarVb(card, +1));
      card.querySelector('.vb-input').addEventListener('input', () => {
        const v = Math.max(0, Math.floor(Number(card.querySelector('.vb-input').value) || 0));
        state.vb = v;
        atualizarResumo();
      });
    });
  };

  const selecionarSku = (ean) => {
    state.skuSelecionado = ean;
    document.querySelectorAll('.sku-card').forEach((c) =>
      c.classList.toggle('selected', c.dataset.ean === ean));
    const card = document.querySelector(`.sku-card[data-ean="${ean}"]`);
    const a = linhaPorEan(ean);
    const padrao = a.estoque_ideal != null && a.estoque_ideal > 0 ? a.estoque_ideal : 1;
    card.querySelector('.vb-input').value = padrao;
    state.vb = Number(padrao);
    $('#btnEnviar').innerHTML = labelBotaoEnviar();
    $('#submitBar').style.display = '';
    atualizarResumo();
  };

  const ajustarVb = (card, dir) => {
    const input = card.querySelector('.vb-input');
    const v = Math.max(0, (Math.floor(Number(input.value)) || 0) + dir);
    input.value = v;
    state.vb = v;
    atualizarResumo();
  };

  const nomeExibicaoPdv = () => {
    const rede = state.pdv.adequacao[0]?.rede;
    return state.pdv.adequacao.length && rede ? redeLabel(rede) : titleCase(state.pdv.pdv.nome);
  };

  const labelBotaoEnviar = () => state.bia
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg> Salvar VB (BI&A)'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg> Enviar sugestão';

  const atualizarResumo = () => {
    if (!state.skuSelecionado) return;
    const a = linhaPorEan(state.skuSelecionado);
    const verbo = state.bia ? 'Definindo' : 'Sugerindo';
    $('#submitResumo').innerHTML =
      `${verbo} <strong>VB ${state.vb}</strong> de <strong>${esc(a.sku)}</strong> para <strong>${esc(nomeExibicaoPdv())}</strong>`;
  };

  const enviarSugestao = async () => {
    const btn = $('#btnEnviar');
    if (!state.skuSelecionado) return;
    btn.disabled = true;
    btn.textContent = state.bia ? 'Salvando...' : 'Enviando...';
    try {
      const a = linhaPorEan(state.skuSelecionado);
      const r = await api('/api/sugestoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cnpj: state.pdv.pdv.cnpj,
          ean: state.skuSelecionado,
          sugestao_vb: state.vb,
          representante: state.bia ? undefined : state.rep,
          rede: state.pdv.manualRede || undefined,
          modo: state.bia ? 'bia' : undefined,
        }),
      });
      if (state.bia) {
        $('#successTitle').textContent = 'VB atualizado!';
        $('#successMsg').innerHTML = 'O VB foi definido pelo <strong>BI&A</strong> e já entrou na sugestão oficial.';
        $('#successDetail').innerHTML = `
          <span><strong>${esc(nomeExibicaoPdv())}</strong> · ${fmtCNPJ(r.cnpj)}</span>
          <span>${esc(a.sku)} — Volume Base: <strong>${esc(r.sugestao_vb)}</strong></span>
          <span>Origem: <strong>BI&A</strong> · Status: <span class="badge badge-green">Aprovada</span></span>
        `;
      } else {
        $('#successTitle').textContent = 'Sugestão enviada!';
        $('#successMsg').innerHTML = 'Sua indicação foi registrada e está <strong>aguardando análise do BI&A</strong>.';
        $('#successDetail').innerHTML = `
          <span><strong>${esc(nomeExibicaoPdv())}</strong> · ${fmtCNPJ(r.cnpj)}</span>
          <span>${esc(a.sku)} — Volume Base sugerido: <strong>${esc(r.sugestao_vb)}</strong></span>
          <span>Representante: <strong>${esc(titleCase(r.representante))}</strong></span>
          <span>Status: <span class="badge badge-warning">Pendente BI&A</span></span>
        `;
      }
      goTo(5);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = labelBotaoEnviar();
    }
  };

  // ---------------------------------------------------------- admin: aprovações
  const carregarAprovacoes = async () => {
    const body = $('#aprovBody');
    body.innerHTML = '<tr><td colspan="11"><div class="skeleton" style="height:44px"></div></td></tr>';
    try {
      const rep = $('#fRep').value;
      const status = $('#fStatus').value;
      const qs = new URLSearchParams({ all: '1' });
      if (rep) qs.set('rep', rep);
      if (status) qs.set('status', status);
      const rows = await api(`/api/sugestoes?${qs}`);

      const pend = rows.filter((r) => r.status_aprovacao === 'PENDENTE').length;
      $('#aprovStats').innerHTML =
        `<span class="badge badge-gray">${rows.length} ${rows.length === 1 ? 'sugestão' : 'sugestões'}</span>` +
        (status === '' ? ` <span class="badge badge-warning">${pend} pendente${pend === 1 ? '' : 's'}</span>` : '');

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-500);padding:28px">Nenhuma sugestão com esses filtros.</td></tr>';
        return;
      }
      body.innerHTML = rows.map((r) => `
        <tr data-id="${r.id}">
          <td class="td-num">${fmtData(r.created_at)}</td>
          <td>${esc(repDisplay(r.representante))}</td>
          <td>${esc(r.rede ? redeLabel(r.rede) : titleCase(r.nome_pdv || ''))}<div class="decidido">${fmtCNPJ(r.cnpj)}</div></td>
          <td>${esc(r.rede ? redeLabel(r.rede) : '—')}</td>
          <td>${esc(r.sku)}</td>
          <td class="td-num">${r.estoque_atual ?? '—'}</td>
          <td class="td-num">${r.estoque_ideal ?? '—'}</td>
          <td class="td-num"><strong>${esc(r.sugestao_vb)}</strong></td>
          <td class="td-num">${fmtMedia(r.media_mensal)}</td>
          <td>
            <span class="badge ${STATUS_SUG_BADGE[r.status_aprovacao] || 'badge-gray'}">${esc(STATUS_SUG_LABEL[r.status_aprovacao] || r.status_aprovacao)}</span>
            ${r.decidido_em ? `<div class="decidido">${fmtData(r.decidido_em)}</div>` : ''}
          </td>
          <td>
            ${r.status_aprovacao === 'PENDENTE' ? `
              <div class="acao-wrap">
                <button class="btn-aprovar" title="Aprovar" data-acao="APROVADA">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
                </button>
                <button class="btn-recusar" title="Recusar" data-acao="RECUSADA">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>` : '—'}
          </td>
        </tr>
      `).join('');

      body.querySelectorAll('.btn-aprovar, .btn-recusar').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const tr = btn.closest('tr');
          const id = tr.dataset.id;
          const acao = btn.dataset.acao;
          btn.disabled = true;
          try {
            const r = await api(`/api/sugestoes/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ acao }),
            });
            toast(`Sugestão de ${repDisplay(r.representante)} (${r.sku}) ${acao === 'APROVADA' ? 'aprovada' : 'recusada'}.`);
            carregarAprovacoes();
          } catch (e) {
            toast(e.message, true);
            btn.disabled = false;
          }
        }));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--error);padding:28px">${esc(e.message)}</td></tr>`;
    }
  };

  // ---------------------------------------------------------- admin: usuários
  const carregarUsuarios = async () => {
    const body = $('#usuariosBody');
    body.innerHTML = '<tr><td colspan="8"><div class="skeleton" style="height:44px"></div></td></tr>';
    try {
      const rows = await api('/api/usuarios');
      const ativos = rows.filter((u) => u.ativo).length;
      $('#usuariosStats').innerHTML =
        `<span class="badge badge-gray">${rows.length} usuários</span> <span class="badge badge-green">${ativos} ativos</span>`;
      body.innerHTML = rows.map((u) => `
        <tr data-id="${u.id}">
          <td><strong>${esc(u.usuario)}</strong></td>
          <td>${esc(u.nome)}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-accent' : 'badge-primary'}">${u.role === 'admin' ? 'Admin' : 'Representante'}</span></td>
          <td>${esc(titleCase(u.desc_territorio || '—'))}</td>
          <td><span class="badge ${u.ativo ? 'badge-green' : 'badge-error'}">${u.ativo ? 'Ativo' : 'Desativado'}</span></td>
          <td>${u.senha_padrao ? '<span class="badge badge-warning">Padrão</span>' : '<span class="badge badge-gray">Própria</span>'}</td>
          <td class="td-num">${u.ultimo_login ? fmtData(u.ultimo_login) : '—'}</td>
          <td><button class="btn btn-sm btn-secondary btn-reset-senha">Redefinir senha</button></td>
        </tr>
      `).join('');
      body.querySelectorAll('.btn-reset-senha').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const tr = btn.closest('tr');
          btn.disabled = true;
          try {
            const r = await api(`/api/usuarios/${tr.dataset.id}/reset-senha`, { method: 'POST' });
            toast(`Senha de ${r.usuario} redefinida para a senha padrão.`);
            carregarUsuarios();
          } catch (e) {
            toast(e.message, true);
            btn.disabled = false;
          }
        }));
    } catch (e) {
      body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--error);padding:28px">${esc(e.message)}</td></tr>`;
    }
  };

  // ---------------------------------------------------------- alterar senha
  const salvarSenha = async () => {
    const atual = $('#senhaAtual').value;
    const nova = $('#senhaNova').value;
    const nova2 = $('#senhaNova2').value;
    const erro = $('#senhaErro');
    erro.style.display = 'none';
    if (nova.length < 8) {
      erro.textContent = 'A nova senha precisa ter pelo menos 8 caracteres.';
      erro.style.display = ''; return;
    }
    if (nova !== nova2) {
      erro.textContent = 'A confirmação não confere com a nova senha.';
      erro.style.display = ''; return;
    }
    const btn = $('#btnSalvarSenha');
    btn.disabled = true;
    try {
      await api('/api/senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha_atual: atual, senha_nova: nova }),
      });
      state.auth.senha_padrao = false;
      localStorage.setItem('tfv_auth', JSON.stringify(state.auth));
      $('#senhaAtual').value = $('#senhaNova').value = $('#senhaNova2').value = '';
      toast('Senha alterada com sucesso!');
      goTo(state.auth.role === 'admin' ? 'admin' : 2);
    } catch (e) {
      erro.textContent = e.message;
      erro.style.display = '';
    } finally {
      btn.disabled = false;
    }
  };

  // ---------------------------------------------------------- eventos globais
  $('#btnLogin').addEventListener('click', entrar);
  $('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
  $('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass').focus(); });
  $('#btnSair').addEventListener('click', logout);

  $('#btnAdminComoRep').addEventListener('click', () => { state.rep = null; state.bia = false; goTo(1); });
  $('#btnAdminBia').addEventListener('click', () => {
    state.bia = true;
    state.rep = null;
    state.pdv = null;
    atualizarHeader();
    $('#pdvSearch').value = '';
    $('#pdvResults').innerHTML = '';
    goTo(2);
    setTimeout(() => $('#pdvSearch').focus(), 350);
  });
  $('#btnAdminAprovacoes').addEventListener('click', () => { goTo('aprovacoes'); carregarAprovacoes(); });
  $('#btnAdminUsuarios').addEventListener('click', () => { goTo('usuarios'); carregarUsuarios(); });
  $('#btnVoltarAdmin').addEventListener('click', () => goTo('admin'));
  $('#btnUsuariosVoltar').addEventListener('click', () => goTo('admin'));
  $('#btnEtapa1VoltarAdmin').addEventListener('click', () => goTo('admin'));
  $('#btnEtapa2Voltar').addEventListener('click', () => {
    if (state.bia) { state.bia = false; atualizarHeader(); goTo('admin'); }
    else { state.rep = null; atualizarHeader(); goTo(1); }
  });
  $('#btnAlterarSenha').addEventListener('click', () => goTo('senha'));
  $('#btnSenhaVoltar').addEventListener('click', () => goTo(state.auth?.role === 'admin' ? 'admin' : 2));
  $('#btnSalvarSenha').addEventListener('click', salvarSenha);
  $('#btnSyncUsuarios').addEventListener('click', async () => {
    const btn = $('#btnSyncUsuarios');
    btn.disabled = true;
    try {
      const r = await api('/api/usuarios/sync', { method: 'POST' });
      toast(`Sincronização concluída: ${r.criados.length} criado(s), ${r.desativados.length} desativado(s).`);
      carregarUsuarios();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  });
  $('#fRep').addEventListener('change', carregarAprovacoes);
  $('#fStatus').addEventListener('change', carregarAprovacoes);

  $('#repSearch').addEventListener('input', (e) => renderReps(e.target.value));

  $('#pdvSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(buscarPdvs, 150);
  });

  $('#btnTrocarRep').addEventListener('click', () => {
    state.rep = null;
    atualizarHeader();
    $('#repSearch').value = '';
    renderReps();
    goTo(state.auth?.role === 'admin' ? 'admin' : 1);
  });

  $('#btnVoltarBusca').addEventListener('click', () => goTo(2));
  $('#btnVoltarValidacao').addEventListener('click', () => { renderValidacao(); goTo(3); });
  $('#btnEnviar').addEventListener('click', enviarSugestao);

  $('#btnOutroSku').addEventListener('click', async () => {
    // recarrega as sugestões para refletir a que acabou de ser enviada
    const manualRede = state.pdv.manualRede;
    try {
      const detalhe = await api(`/api/pdv/${state.pdv.pdv.cnpj}`);
      detalhe.manualRede = detalhe.adequacao.length ? null : manualRede;
      state.pdv = detalhe;
    } catch (e) {
      // PDV manual (fora da dim_pdv): atualiza só as sugestões
      try { state.pdv.sugestoes = await api(`/api/sugestoes?cnpj=${state.pdv.pdv.cnpj}`); } catch (e2) {}
    }
    renderSkus();
    goTo(4);
  });
  $('#btnNovoPdv').addEventListener('click', () => {
    $('#pdvSearch').value = '';
    $('#pdvResults').innerHTML = '';
    $('#manualPdv').classList.remove('open');
    goTo(2);
    setTimeout(() => $('#pdvSearch').focus(), 350);
  });

  // -------------------------------------------------------- cadastro manual
  $('#manualTrigger').addEventListener('click', () => {
    const wrap = $('#manualPdv');
    wrap.classList.toggle('open');
    if (wrap.classList.contains('open')) setTimeout(() => $('#mCnpj').focus(), 300);
  });

  $('#mCnpj').addEventListener('input', (e) => {
    // máscara 00.000.000/0000-00
    const d = e.target.value.replace(/\D/g, '').slice(0, 14);
    let out = d;
    if (d.length > 2) out = `${d.slice(0, 2)}.${d.slice(2)}`;
    if (d.length > 5) out = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
    if (d.length > 8) out = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    if (d.length > 12) out = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
    e.target.value = out;
    $('#mCnpjErro').style.display = 'none';
    e.target.classList.remove('input-error');
  });

  const continuarManual = async () => {
    const cnpj = $('#mCnpj').value.replace(/\D/g, '');
    const nome = $('#mNome').value.trim();
    const rede = $('#mRede').value;
    const cidade = $('#mCidade').value.trim();
    const uf = $('#mUf').value;

    if (cnpj.length !== 14) {
      $('#mCnpjErro').textContent = 'Informe um CNPJ completo (14 dígitos).';
      $('#mCnpjErro').style.display = '';
      $('#mCnpj').classList.add('input-error');
      $('#mCnpj').focus();
      return;
    }
    if (!nome) { toast('Informe o nome do PDV.', true); $('#mNome').focus(); return; }
    if (!rede) { toast('Selecione a rede do PDV.', true); $('#mRede').focus(); return; }

    const btn = $('#btnManualContinuar');
    btn.disabled = true;

    // se o CNPJ já existir na base, usa os dados oficiais
    let detalhe = null;
    try { detalhe = await api(`/api/pdv/${cnpj}`); } catch (e) { /* 404 => segue manual */ }

    if (detalhe) {
      state.pdv = detalhe;
      state.pdv.manualRede = detalhe.adequacao.length ? null : rede;
      if (detalhe.adequacao.length) toast('Boa notícia: este CNPJ já está na base — carregamos os dados oficiais.');
    } else {
      let sugestoes = [];
      try { sugestoes = await api(`/api/sugestoes?cnpj=${cnpj}`); } catch (e) {}
      state.pdv = {
        pdv: { cnpj, nome, endereco: null, bairro: null, cidade: cidade || null, uf: uf || null, regiao: null, telefone: null, situacao: null, categoria: null, categoria_periodo: null, latitude: null, longitude: null },
        territorios: [],
        adequacao: [],
        sugestoes,
        manualRede: rede,
      };
    }
    btn.disabled = false;
    renderValidacao();
    goTo(3);
  };
  $('#btnManualContinuar').addEventListener('click', continuarManual);

  $('#mUf').innerHTML = '<option value="">—</option>' + UFS.map((u) => `<option>${u}</option>`).join('');

  // ---------------------------------------------------------- init
  try {
    const saved = JSON.parse(localStorage.getItem('tfv_auth') || 'null');
    if (saved?.token && saved?.role) state.auth = saved;
  } catch (e) { /* login limpo */ }

  if (state.auth) iniciarSessao();
  else { goTo('login', 'replace'); setTimeout(() => $('#loginUser').focus(), 300); }
})();
