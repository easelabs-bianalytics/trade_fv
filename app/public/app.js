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
    selecionados: {},   // SKUs marcados na etapa 4: { ean: vb }
    painelAtual: null,  // painel ativo (para marcar o item do nav)
    pendentes: 0,       // badge de sugestões pendentes (admin)
  };

  // rotas que ganham container largo (tabelas)
  const ROTAS_LARGAS = ['aprovacoes', 'usuarios', 'sugestoes'];

  // título da aba por página
  const TITULO_PAGINA = {
    'login': 'Entrar', 'admin': 'Painel', 'aprovacoes': 'Aprovações',
    'usuarios': 'Usuários', 'sugestoes': 'Minhas sugestões', 'senha': 'Alterar senha',
    1: 'Escolher representante', 2: 'Buscar PDV', 3: 'Validar PDV',
    4: 'Sugerir VB', 5: 'Sugestão enviada',
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

  // Identidade visual de cada rede. `cor` é a cor predominante da própria logo
  // (extraída por scripts/normalizar_logos.py); `textoEscuro` marca as cores
  // claras demais para texto branco — nesses casos o texto vira grafite.
  // As logos ficam em public/redes/<codigo em minúsculas>.png, já normalizadas
  // pelo script para todas ocuparem a mesma proporção do quadrado.
  const REDE_MARCA = {
    'ARAUJO':     { cor: '#07419F' },
    'CLAMED':     { cor: '#054E31' },
    'DPSP':       { cor: '#2E3344' },
    'DROGAL':     { cor: '#FEE24B', textoEscuro: true },
    'INDIANA':    { cor: '#072AC6' },
    'PAGUEMENOS': { cor: '#0200BE' },
    'PANVEL':     { cor: '#002A89' },
    'RAIA':       { cor: '#E01E3B' },
    'SAOJOAO':    { cor: '#3A1267' },
    'VENANCIO':   { cor: '#D8163C' },
  };
  const redeLogo = (rede) => (REDE_MARCA[rede] ? `/redes/${rede.toLowerCase()}.png` : null);

  const ICONE_PDV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M14 9h1M14 13h1M10 21v-4h4v4"/></svg>';

  // Marca do PDV: logo da rede quando conhecida, senão o ícone genérico de prédio
  const marcaPdv = (rede, classe) => {
    const logo = redeLogo(rede);
    return logo
      ? `<div class="${classe} tem-logo"><img src="${logo}" alt="${esc(redeLabel(rede))}" loading="lazy"></div>`
      : `<div class="${classe}">${ICONE_PDV}</div>`;
  };

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

  const toast = (msg, isError = false, duracao = 5200) => {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = `toast${isError ? ' toast-error' : ''}`;
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><span>${esc(msg)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duracao);
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
    'sugestoes': '/minhas-sugestoes',
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
    state.painelAtual = n;
    $('#page').classList.toggle('page-wide', ROTAS_LARGAS.includes(n));
    $('#appFooter').style.display = n === 'login' ? 'none' : '';
    document.title = `${TITULO_PAGINA[n] || 'Indicação de PDVs'} · Ease Labs`;
    marcarNavAtivo();
    fecharDropdowns();
    if (n !== 'senha') ocultarSenhas();
    if (n === 'admin') carregarDashboard();

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
    else if (alvo === 'sugestoes' && isAdmin) alvo = 'aprovacoes'; // admin usa Aprovações
    else if (alvo === 1 && !isAdmin) alvo = 2; // rep já está no próprio território
    else if (typeof alvo === 'number' && alvo >= 3 && !state.pdv) alvo = temCtx ? 2 : (isAdmin ? 'admin' : 2);
    else if (alvo === 2 && !temCtx) alvo = isAdmin ? 'admin' : 2;

    if (alvo === 'aprovacoes') carregarAprovacoes();
    if (alvo === 'usuarios') carregarUsuarios();
    if (alvo === 'sugestoes') carregarMinhasSugestoes();
    // o painel precisa estar visível ANTES de montar o mapa (Leaflet mede o container)
    goTo(alvo, ROTA[alvo] === path ? false : historico);
    if (alvo === 3 && state.pdv) renderValidacao();
    if (alvo === 4 && state.pdv) renderSkus();
  };

  window.addEventListener('popstate', () => irParaRota(location.pathname, 'replace'));

  // ---------------------------------------------------------- atalhos de fluxo
  const irSugerirComoRep = () => {
    state.bia = false;
    $('#pdvSearch').value = '';
    $('#pdvResults').innerHTML = '';
    goTo(2);
    setTimeout(() => $('#pdvSearch').focus(), 350);
  };

  const entrarModoBia = () => {
    state.bia = true;
    state.rep = null;
    state.pdv = null;
    atualizarHeader();
    $('#pdvSearch').value = '';
    $('#pdvResults').innerHTML = '';
    goTo(2);
    setTimeout(() => $('#pdvSearch').focus(), 350);
  };

  // ---------------------------------------------------------- app shell (topbar)
  // Itens de navegação por papel. `match` diz quais painéis acendem o item.
  const navItems = () => {
    if (!state.auth) return [];
    if (state.auth.role !== 'admin') {
      return [
        { id: 'nova', label: 'Nova sugestão', match: [2, 3, 4, 5], onClick: () => irSugerirComoRep() },
        { id: 'minhas', label: 'Minhas sugestões', match: ['sugestoes'], onClick: () => { goTo('sugestoes'); carregarMinhasSugestoes(); } },
      ];
    }
    return [
      { id: 'painel', label: 'Painel', match: ['admin'], onClick: () => goTo('admin') },
      {
        id: 'sugerir', label: 'Sugerir VB', match: [1, 2, 3, 4, 5],
        menu: [
          { label: 'Como representante', sub: 'Percorre o fluxo de um território', onClick: () => { state.rep = null; state.bia = false; atualizarHeader(); goTo(1); } },
          { label: 'Ajustar como BI&A', sub: 'Define o VB direto, já aprovado', onClick: () => entrarModoBia() },
        ],
      },
      { id: 'aprovacoes', label: 'Aprovações', match: ['aprovacoes'], badge: () => state.pendentes, onClick: () => { goTo('aprovacoes'); carregarAprovacoes(); } },
      { id: 'usuarios', label: 'Usuários', match: ['usuarios'], onClick: () => { goTo('usuarios'); carregarUsuarios(); } },
    ];
  };

  const renderNav = () => {
    const nav = $('#topnav');
    const itens = navItems();
    nav.innerHTML = itens.map((it) => {
      const badge = it.badge && it.badge() ? `<span class="topnav-badge">${it.badge()}</span>` : '';
      const chev = it.menu
        ? '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
        : '';
      const botao = `<button class="topnav-item" data-nav="${it.id}">${esc(it.label)}${badge}${chev}</button>`;
      return it.menu
        ? `<div class="topnav-group" data-group="${it.id}">${botao}
             <div class="dropdown-menu">
               ${it.menu.map((m, i) => `<button class="dropdown-item" data-menu="${it.id}" data-idx="${i}">
                  <span><strong style="font-weight:600">${esc(m.label)}</strong><span class="di-sub">${esc(m.sub || '')}</span></span>
                </button>`).join('')}
             </div>
           </div>`
        : botao;
    }).join('');

    nav.querySelectorAll('.topnav-item').forEach((btn) => {
      const it = itens.find((x) => x.id === btn.dataset.nav);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (it.menu) {
          const grupo = btn.closest('.topnav-group');
          const abrindo = !grupo.classList.contains('open');
          fecharDropdowns();
          grupo.classList.toggle('open', abrindo);
        } else {
          fecharDropdowns();
          it.onClick();
        }
      });
    });
    nav.querySelectorAll('.dropdown-item[data-menu]').forEach((btn) => {
      const it = itens.find((x) => x.id === btn.dataset.menu);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fecharDropdowns();
        it.menu[Number(btn.dataset.idx)].onClick();
      });
    });
    marcarNavAtivo();
  };

  const marcarNavAtivo = () => {
    const atual = state.painelAtual;
    navItems().forEach((it) => {
      const btn = $(`#topnav .topnav-item[data-nav="${it.id}"]`);
      if (btn) btn.classList.toggle('active', it.match.includes(atual));
    });
  };

  const fecharDropdowns = () => {
    document.querySelectorAll('.topnav-group.open, .topbar-user.open')
      .forEach((el) => el.classList.remove('open'));
    $('#userTrigger').setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('click', fecharDropdowns);

  // ---------------------------------------------------------- auth
  const atualizarHeader = () => {
    const logado = !!state.auth;
    $('#topbar').style.display = logado ? '' : 'none';
    if (!logado) return;

    const isAdmin = state.auth.role === 'admin';
    const nomeExibir = isAdmin && state.rep ? titleCase(state.rep) : state.auth.nome;
    const papel = isAdmin ? (state.rep ? 'Representante (simulação)' : 'BI&A') : 'Representante';

    $('#headerUserName').textContent = nomeExibir;
    $('#headerUserRole').textContent = papel;
    $('#headerUserAvatar').textContent = iniciais(nomeExibir || '?');
    $('#menuUserName').textContent = state.auth.nome;
    $('#menuUserSub').textContent = `${state.auth.usuario} · ${isAdmin ? 'Administrador' : 'Representante'}`;
    // "Trocar representante" só faz sentido para admin simulando
    $('#btnTrocarRep').style.display = isAdmin && state.rep ? '' : 'none';
    renderNav();
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
        toast('Você ainda está usando a senha padrão. Para criar a sua, clique no seu nome no canto superior direito da tela e escolha "Alterar senha".', false, 11000);
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
          ${marcaPdv(p.rede, 'pdv-icon')}
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

    // No tablet o mapa ocupa a largura toda no meio de uma página que rola.
    // Com arraste de 1 dedo ligado, o mapa "engole" o gesto e o representante
    // fica preso nele. Então: 1 dedo rola a página, 2 dedos movem o mapa.
    const toque = window.matchMedia('(pointer: coarse)').matches;
    pdvMapInstance = L.map(el, {
      center: [lat, lng], zoom: 17, zoomControl: false,
      dragging: !toque, scrollWheelZoom: false,
    });
    if (toque) {
      el.classList.add('mapa-toque');
      el.addEventListener('touchstart', (ev) => {
        if (ev.touches.length >= 2) pdvMapInstance.dragging.enable();
      }, { passive: true });
      el.addEventListener('touchend', () => {
        if (pdvMapInstance) pdvMapInstance.dragging.disable();
      }, { passive: true });
    }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(pdvMapInstance);
    L.marker([lat, lng]).addTo(pdvMapInstance);
    L.control.zoom({ position: 'bottomright' }).addTo(pdvMapInstance);

    // Se o painel ainda estava oculto (ou animando) quando o mapa nasceu, o Leaflet
    // mediu 0x0 e os tiles não carregam — daí o quadrado cinza. Remedimos depois
    // que o painel aparece e ao fim da animação de entrada.
    const remedir = () => {
      if (!pdvMapInstance) return;
      pdvMapInstance.invalidateSize();
      pdvMapInstance.setView([lat, lng], 17);
    };
    requestAnimationFrame(remedir);
    setTimeout(remedir, 260);
  };

  const renderValidacao = () => {
    const { pdv, adequacao } = state.pdv;
    const temAdequacao = adequacao.length > 0;
    const manual = !!state.pdv.manualRede;
    const rede = temAdequacao ? adequacao[0].rede : state.pdv.manualRede || null;
    const podeContinuar = temAdequacao || manual;

    $('#pdvValidacaoCard').innerHTML = `
      <div class="pdv-hero">
        ${marcaPdv(rede, 'pdv-hero-icon')}
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
    state.selecionados = {};    // a seleção é por PDV
    $('#submitBar').style.display = 'none';

    const rede = adequacao[0]?.rede || state.pdv.manualRede;
    // a barra assume a cor da marca da rede (fallback: navy do design system);
    // em cores claras (ex.: amarelo da Drogal) o texto vira grafite
    const marca = REDE_MARCA[rede];
    const barra = $('#pdvContextBar');
    barra.style.setProperty('--rede-cor', marca ? marca.cor : 'var(--bg-sidebar)');
    barra.style.setProperty('--rede-texto', marca?.textoEscuro ? 'var(--gray-900)' : '#fff');
    barra.classList.toggle('texto-escuro', !!marca?.textoEscuro);
    $('#pdvContextBar').innerHTML = `
      ${marcaPdv(rede, 'ctx-icon')}
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
            <div class="vb-dica" aria-live="polite"></div>
          </div>
          ${semDados ? '' : `<div class="ia-box" data-ia="${esc(a.ean)}"></div>`}
        </div>
      </div>`;
    }).join('');

    document.querySelectorAll('.sku-card').forEach((card) => {
      const ean = card.dataset.ean;
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('.sku-vb-area')) return; // mexer no VB não desmarca
        alternarSku(ean);
      });
      card.querySelector('.vb-minus').addEventListener('click', () => ajustarVb(card, -1));
      card.querySelector('.vb-plus').addEventListener('click', () => ajustarVb(card, +1));
      card.querySelector('.vb-input').addEventListener('input', () => {
        const v = Math.max(0, Math.floor(Number(card.querySelector('.vb-input').value) || 0));
        state.selecionados[ean] = v;
        atualizarDica(card);
        atualizarResumo();
      });
    });
    atualizarResumo();
  };

  // ── Dica condicional do VB ─────────────────────────────────────────────
  // Aparece só quando a proposta destoa em 2+ unidades da média mensal.
  const ICONE_DICA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/></svg>';

  const textoDica = (vb, media) => {
    const m = Number(media);
    if (!Number.isFinite(m)) return null;
    if (vb - m >= 2) return 'uma sugestão muito maior que as unidades dispensadas por mês pode resultar em produto parado na prateleira.';
    if (m - vb >= 2) return 'uma sugestão muito menor que as unidades dispensadas por mês pode resultar em falta de estoque no PDV.';
    return null;
  };

  // VB idêntico ao que o BI já sugere não é uma sugestão — é bloqueado no envio
  const vbIgualAoBi = (ean, vb) => {
    const a = linhaPorEan(ean);
    const ideal = a?.estoque_ideal;
    return ideal != null && Number(ideal) === Number(vb);
  };

  const atualizarDica = (card) => {
    const alvo = card.querySelector('.vb-dica');
    if (!alvo) return;
    const ean = card.dataset.ean;
    const a = linhaPorEan(ean);
    const vb = Math.max(0, Math.floor(Number(card.querySelector('.vb-input').value)) || 0);

    const texto = textoDica(vb, a?.media_mensal);
    if (!texto) { alvo.classList.remove('visivel'); return; }
    alvo.innerHTML = `${ICONE_DICA}<span><strong>Dica:</strong> ${esc(texto)}</span>`;
    alvo.classList.add('visivel');
  };

  // ── Seleção múltipla de SKUs ───────────────────────────────────────────
  const alternarSku = (ean) => {
    const card = document.querySelector(`.sku-card[data-ean="${ean}"]`);
    if (!card) return;
    if (ean in state.selecionados) {
      delete state.selecionados[ean];
      card.classList.remove('selected');
    } else {
      const a = linhaPorEan(ean);
      const padrao = a.estoque_ideal != null && a.estoque_ideal > 0 ? Number(a.estoque_ideal) : 1;
      state.selecionados[ean] = padrao;
      card.querySelector('.vb-input').value = padrao;
      card.classList.add('selected');
      atualizarDica(card);
    }
    atualizarResumo();
  };

  const ajustarVb = (card, dir) => {
    const ean = card.dataset.ean;
    const input = card.querySelector('.vb-input');
    const v = Math.max(0, (Math.floor(Number(input.value)) || 0) + dir);
    input.value = v;
    state.selecionados[ean] = v;
    atualizarDica(card);
    atualizarResumo();
  };

  const nomeExibicaoPdv = () => {
    const rede = state.pdv.adequacao[0]?.rede;
    return state.pdv.adequacao.length && rede ? redeLabel(rede) : titleCase(state.pdv.pdv.nome);
  };

  const atualizarResumo = () => {
    const eans = Object.keys(state.selecionados);
    const bar = $('#submitBar');
    if (!eans.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const nomes = eans.map((e) => linhaPorEan(e).sku);
    const verbo = state.bia ? 'Definindo' : 'Sugerindo';
    $('#submitResumo').innerHTML = eans.length === 1
      ? `${verbo} <strong>VB ${state.selecionados[eans[0]]}</strong> de <strong>${esc(nomes[0])}</strong> para <strong>${esc(nomeExibicaoPdv())}</strong>`
      : `${verbo} VB para <strong>${eans.length} SKUs</strong> em <strong>${esc(nomeExibicaoPdv())}</strong>: ${esc(nomes.join(', '))}`;
    $('#btnEnviarTexto').textContent = state.bia
      ? (eans.length === 1 ? 'Salvar VB (BI&A)' : `Salvar ${eans.length} VBs (BI&A)`)
      : (eans.length === 1 ? 'Enviar sugestão' : `Enviar ${eans.length} sugestões`);
  };

  // ── Revisão da IA (aparece ao clicar em Enviar) ────────────────────────
  const ICONE_IA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.7 1.8L21.5 18l-1.8.7L19 20.5l-.7-1.8L16.5 18l1.8-.7L19 15z"/></svg>';

  const ALERTA_BADGE = {
    abaixo: { classe: 'badge-warning', texto: 'Risco de ruptura' },
    acima:  { classe: 'badge-gray',    texto: 'Estoque sobrando' },
  };

  const abrirRevisao = async () => {
    const eans = Object.keys(state.selecionados);
    if (!eans.length) return;
    const modal = $('#modalRevisao');
    const alvo = $('#revisaoConteudo');
    $('#revisaoModelo').textContent = '';
    $('#btnConfirmarEnvio').disabled = true;
    modal.style.display = '';
    requestAnimationFrame(() => modal.classList.add('aberto'));

    alvo.innerHTML = `<div class="ia-carregando">${ICONE_IA}<span>Analisando as suas sugestões…</span></div>`;

    // PDVs fora da base de adequação não têm histórico para comparar
    if (!state.pdv.adequacao.length) {
      alvo.innerHTML = `
        <p class="revisao-contexto">Este PDV ainda não está na base de adequação de estoque, então não há histórico para comparar. Sua sugestão será registrada assim mesmo.</p>
        ${eans.map((e) => `<div class="revisao-item"><div class="revisao-sku"><span class="sku-dot" style="--sku-color:${SKU_COLOR[linhaPorEan(e).sku]}"></span>${esc(linhaPorEan(e).sku)}<span class="revisao-vb">VB ${state.selecionados[e]}</span></div></div>`).join('')}`;
      $('#btnConfirmarEnvio').disabled = false;
      return;
    }

    try {
      const r = await api('/api/revisao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cnpj: state.pdv.pdv.cnpj,
          itens: eans.map((ean) => ({ ean, vb: state.selecionados[ean] })),
        }),
      });
      $('#revisaoModelo').textContent = r.origem === 'ia' ? r.modelo : 'leitura automática';
      alvo.innerHTML = `
        ${r.aviso ? `<div class="alert alert-warning" style="margin-bottom:14px">${esc(r.aviso)}</div>` : ''}
        <p class="revisao-contexto">${esc(r.contexto)}</p>
        ${r.comentarios.map((c) => {
          const al = ALERTA_BADGE[c.alerta];
          return `
          <div class="revisao-item${c.alerta ? ' com-alerta' : ''}">
            <div class="revisao-sku">
              <span class="sku-dot" style="--sku-color:${SKU_COLOR[c.sku] || 'var(--gray-300)'}"></span>
              ${esc(c.sku)}
              <span class="revisao-vb">VB ${c.vb}</span>
              ${al ? `<span class="badge ${al.classe}">${al.texto}</span>` : ''}
            </div>
            <p class="revisao-texto">${esc(c.texto)}</p>
          </div>`;
        }).join('')}`;
    } catch (e) {
      alvo.innerHTML = `<div class="alert alert-warning">${esc(e.message)} Você pode confirmar o envio mesmo assim.</div>`;
    } finally {
      $('#btnConfirmarEnvio').disabled = false;
    }
  };

  const fecharRevisao = () => {
    const modal = $('#modalRevisao');
    modal.classList.remove('aberto');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  };

  // "A, B e C" — usado nas mensagens de erro consolidadas
  const listar = (itens) => itens.length <= 1 ? (itens[0] || '')
    : `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;

  // Consolida as falhas num único aviso, em vez de mostrar só a primeira.
  const resumirFalhas = (falhas) => {
    if (falhas.length === 1) return falhas[0].msg;
    const pendentes = falhas.filter((f) => /pendente/i.test(f.msg));
    if (pendentes.length === falhas.length) {
      return `${falhas.length} sugestões não foram enviadas: você já tem uma pendente para `
        + `${listar(falhas.map((f) => f.sku))} neste PDV. Aguarde a decisão do BI&A.`;
    }
    return falhas.map((f) => `${f.sku}: ${f.msg}`).join(' · ');
  };

  // Envia as sugestões marcadas. `botao` é só quem mostra o estado de carregando.
  const enviarSelecionados = async (botao, fecharModal = false) => {
    const eans = Object.keys(state.selecionados);
    if (!eans.length) return;

    // Nada é enviado se algum SKU repetir o VB que o BI já sugere.
    const iguais = eans.filter((ean) => vbIgualAoBi(ean, state.selecionados[ean]));
    if (iguais.length) {
      const nomes = listar(iguais.map((e) => linhaPorEan(e).sku));
      toast(iguais.length === 1
        ? `O VB ${state.selecionados[iguais[0]]} que você sugeriu para ${nomes} já é o VB sugerido atualmente neste PDV. Ajuste o valor e tente novamente.`
        : `O VB que você sugeriu para ${nomes} já é o sugerido atualmente neste PDV. Ajuste os valores e tente novamente.`, true);
      iguais.forEach((ean) => {
        const c = document.querySelector(`.sku-card[data-ean="${ean}"]`);
        if (c) atualizarDica(c);
      });
      return;
    }
    const btn = botao;
    const rotuloOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const resultados = await Promise.allSettled(eans.map((ean) =>
        api('/api/sugestoes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cnpj: state.pdv.pdv.cnpj,
            ean,
            sugestao_vb: state.selecionados[ean],
            representante: state.bia ? undefined : state.rep,
            rede: state.pdv.manualRede || undefined,
            modo: state.bia ? 'bia' : undefined,
          }),
        })));

      const ok = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const falhas = resultados
        .map((r, i) => (r.status === 'rejected' ? { sku: linhaPorEan(eans[i]).sku, msg: r.reason.message } : null))
        .filter(Boolean);

      if (!ok.length) {
        if (fecharModal) fecharRevisao();
        toast(falhas.length ? resumirFalhas(falhas) : 'Não foi possível enviar.', true);
        return;
      }

      $('#successTitle').textContent = state.bia
        ? (ok.length > 1 ? 'VBs atualizados!' : 'VB atualizado!')
        : (ok.length > 1 ? 'Sugestões enviadas!' : 'Sugestão enviada!');
      $('#successMsg').innerHTML = state.bia
        ? 'Os VBs foram definidos pelo <strong>BI&A</strong> e já entraram na sugestão oficial.'
        : 'Suas indicações foram registradas e estão <strong>aguardando análise do BI&A</strong>.';
      $('#successDetail').innerHTML = `
        <span><strong>${esc(nomeExibicaoPdv())}</strong> · ${fmtCNPJ(state.pdv.pdv.cnpj)}</span>
        ${ok.map((r) => `<span>${esc(r.sku)} — Volume Base: <strong>${esc(r.sugestao_vb)}</strong></span>`).join('')}
        <span>Status: ${state.bia
          ? '<span class="badge badge-green">Aprovada</span>'
          : '<span class="badge badge-warning">Pendente BI&A</span>'}</span>
        ${falhas.length ? `<span class="revisao-falha">${falhas.length} não enviada(s): ${esc(listar(falhas.map((f) => f.sku)))} — já em análise pelo BI&A</span>` : ''}
      `;
      if (falhas.length) toast(resumirFalhas(falhas), true);
      state.selecionados = {};
      if (fecharModal) fecharRevisao();
      goTo(5);
    } finally {
      btn.disabled = false;
      btn.innerHTML = rotuloOriginal;
    }
  };

  // ---------------------------------------------------------- rep: minhas sugestões
  const carregarMinhasSugestoes = async () => {
    const body = $('#minhasSugestoesBody');
    body.innerHTML = '<tr><td colspan="11"><div class="skeleton" style="height:44px"></div></td></tr>';
    try {
      const rows = await api('/api/sugestoes');
      const pend = rows.filter((r) => r.status_aprovacao === 'PENDENTE').length;
      const apr = rows.filter((r) => r.status_aprovacao === 'APROVADA').length;
      $('#minhasStats').innerHTML = rows.length
        ? `<span class="badge badge-gray">${rows.length} ${rows.length === 1 ? 'sugestão' : 'sugestões'}</span>` +
          (pend ? ` <span class="badge badge-warning">${pend} em análise</span>` : '') +
          (apr ? ` <span class="badge badge-green">${apr} aprovada${apr === 1 ? '' : 's'}</span>` : '')
        : '';
      $('#minhasVazio').style.display = rows.length ? 'none' : '';
      $('#panel-sugestoes').querySelector('.table-wrapper').style.display = rows.length ? '' : 'none';
      body.innerHTML = rows.map((r) => `
        <tr>
          <td class="td-num" data-label="Enviada">${fmtData(r.created_at)}</td>
          <td data-label="PDV">${esc(r.rede ? redeLabel(r.rede) : titleCase(r.nome_pdv || ''))}<div class="decidido">${fmtCNPJ(r.cnpj)}</div></td>
          <td data-label="Cidade">${esc(titleCase(r.cidade || '—'))}${r.uf ? '/' + esc(r.uf) : ''}</td>
          <td data-label="Rede">${esc(r.rede ? redeLabel(r.rede) : '—')}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td class="td-num" data-label="Estq. atual">${r.estoque_atual ?? '—'}</td>
          <td class="td-num" data-label="VB sugerido BI">${r.estoque_ideal ?? '—'}</td>
          <td class="td-num" data-label="Meu VB"><strong>${esc(r.sugestao_vb)}</strong></td>
          <td class="td-num" data-label="Und / mês">${fmtMedia(r.media_mensal)}</td>
          <td data-label="Status"><span class="badge ${STATUS_SUG_BADGE[r.status_aprovacao] || 'badge-gray'}">${esc(STATUS_SUG_LABEL[r.status_aprovacao] || r.status_aprovacao)}</span></td>
          <td class="td-num" data-label="Decidida">${r.decidido_em ? fmtData(r.decidido_em) : '—'}</td>
        </tr>
      `).join('');
    } catch (e) {
      body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--error);padding:28px">${esc(e.message)}</td></tr>`;
    }
  };

  // ---------------------------------------------------------- admin: painel (KPIs)
  const carregarDashboard = async () => {
    try {
      const d = await api('/api/dashboard');
      state.pendentes = Number(d.pendentes) || 0;
      const num = (v) => Number(v || 0).toLocaleString('pt-BR');
      const kpis = [
        { label: 'Aguardando análise', valor: num(d.pendentes), cor: 'var(--warning)',
          hint: state.pendentes ? 'Clique para revisar' : 'Nada na fila', click: true },
        { label: 'Aprovadas no mês', valor: num(d.aprovadas_mes), cor: 'var(--green-600)',
          hint: 'Já valendo na sugestão oficial' },
        { label: 'Representantes ativos', valor: num(d.reps_ativos), cor: 'var(--primary-600)',
          hint: 'Com CT ativo em território' },
        { label: 'PDVs na base', valor: num(d.pdvs_mapeados), cor: 'var(--accent-600)',
          hint: 'Redes monitoradas' },
      ];
      $('#kpiGrid').innerHTML = kpis.map((k, i) => `
        <div class="kpi-card${k.click ? ' clickable' : ''}" style="--kpi-color:${k.cor}; animation-delay:${i * 60}ms"${k.click ? ' data-goto="aprovacoes"' : ''}>
          <div class="kpi-label">${esc(k.label)}</div>
          <div class="kpi-value">${k.valor}</div>
          <div class="kpi-hint">${esc(k.hint)}</div>
        </div>
      `).join('');
      $('#kpiGrid').querySelectorAll('[data-goto]').forEach((el) =>
        el.addEventListener('click', () => { goTo('aprovacoes'); carregarAprovacoes(); }));
      renderNav(); // atualiza o badge de pendentes
    } catch (e) {
      $('#kpiGrid').innerHTML = `<div class="search-empty">${esc(e.message)}</div>`;
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
          <td class="td-num" data-label="Enviada">${fmtData(r.created_at)}</td>
          <td data-label="Representante">${esc(repDisplay(r.representante))}</td>
          <td data-label="PDV">${esc(r.rede ? redeLabel(r.rede) : titleCase(r.nome_pdv || ''))}<div class="decidido">${fmtCNPJ(r.cnpj)}</div></td>
          <td data-label="Rede">${esc(r.rede ? redeLabel(r.rede) : '—')}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td class="td-num" data-label="Estq. atual">${r.estoque_atual ?? '—'}</td>
          <td class="td-num" data-label="VB sugerido BI">${r.estoque_ideal ?? '—'}</td>
          <td class="td-num" data-label="VB do rep"><strong>${esc(r.sugestao_vb)}</strong></td>
          <td class="td-num" data-label="Und / mês">${fmtMedia(r.media_mensal)}</td>
          <td data-label="Status">
            <span class="badge ${STATUS_SUG_BADGE[r.status_aprovacao] || 'badge-gray'}">${esc(STATUS_SUG_LABEL[r.status_aprovacao] || r.status_aprovacao)}</span>
            ${r.decidido_em ? `<div class="decidido">${fmtData(r.decidido_em)}</div>` : ''}
          </td>
          <td class="td-acoes">
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
          <td data-label="Usuário"><strong>${esc(u.usuario)}</strong></td>
          <td data-label="Nome">${esc(u.nome)}</td>
          <td data-label="Papel"><span class="badge ${u.role === 'admin' ? 'badge-accent' : 'badge-primary'}">${u.role === 'admin' ? 'Admin' : 'Representante'}</span></td>
          <td data-label="Território">${esc(titleCase(u.desc_territorio || '—'))}</td>
          <td data-label="Situação"><span class="badge ${u.ativo ? 'badge-green' : 'badge-error'}">${u.ativo ? 'Ativo' : 'Desativado'}</span></td>
          <td data-label="Senha">${u.senha_padrao ? '<span class="badge badge-warning">Padrão</span>' : '<span class="badge badge-gray">Própria</span>'}</td>
          <td class="td-num" data-label="Último login">${u.ultimo_login ? fmtData(u.ultimo_login) : '—'}</td>
          <td class="td-acoes"><button class="btn btn-sm btn-secondary btn-reset-senha">Redefinir senha</button></td>
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
  // Exibir/ocultar os caracteres. Volta a ocultar sozinho ao sair da tela,
  // para a senha não ficar exposta se o rep deixar o celular na mesa.
  const ocultarSenhas = () => {
    document.querySelectorAll('.btn-olho').forEach((b) => {
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', 'Exibir senha');
      $(`#${b.dataset.alvo}`).type = 'password';
    });
  };

  document.querySelectorAll('.btn-olho').forEach((btn) => {
    btn.addEventListener('click', () => {
      const campo = $(`#${btn.dataset.alvo}`);
      const exibir = campo.type === 'password';
      campo.type = exibir ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(exibir));
      btn.setAttribute('aria-label', exibir ? 'Ocultar senha' : 'Exibir senha');
      campo.focus();
    });
  });

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

  $('#btnAdminComoRep').addEventListener('click', () => { state.rep = null; state.bia = false; atualizarHeader(); goTo(1); });
  $('#btnAdminBia').addEventListener('click', entrarModoBia);
  $('#btnEtapa1VoltarAdmin').addEventListener('click', () => goTo('admin'));

  // menu do usuário (dropdown no avatar)
  $('#userTrigger').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const wrap = $('#topbarUser');
    const abrindo = !wrap.classList.contains('open');
    fecharDropdowns();
    wrap.classList.toggle('open', abrindo);
    $('#userTrigger').setAttribute('aria-expanded', String(abrindo));
  });
  $('#userMenu').addEventListener('click', (ev) => ev.stopPropagation());
  $('#btnEtapa2Voltar').addEventListener('click', () => {
    if (state.bia) { state.bia = false; atualizarHeader(); goTo('admin'); }
    else { state.rep = null; atualizarHeader(); goTo(1); }
  });
  $('#btnVaziaNova').addEventListener('click', irSugerirComoRep);
  // logo = atalho para o início: "Nova sugestão" (rep) ou "Painel" (admin)
  $('#btnLogoHome').addEventListener('click', () => {
    if (state.auth?.role === 'admin') goTo('admin');
    else irSugerirComoRep();
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
  // goTo primeiro: o painel precisa estar visível antes do mapa ser montado
  $('#btnVoltarValidacao').addEventListener('click', () => { goTo(3); renderValidacao(); });
  // ── REVISÃO POR IA: DESATIVADA ──────────────────────────────────────────
  // O envio vai direto para o banco, sem passar pelo modal de revisão.
  // Para REATIVAR, basta trocar a linha abaixo por:
  //     $('#btnEnviar').addEventListener('click', abrirRevisao);
  // O restante (endpoint /api/revisao, abrirRevisao, o modal e o fallback
  // determinístico) continua pronto e testado — nada foi removido.
  $('#btnEnviar').addEventListener('click', () => enviarSelecionados($('#btnEnviar')));

  $('#btnVoltarAjustar').addEventListener('click', fecharRevisao);
  $('#btnConfirmarEnvio').addEventListener('click',
    () => enviarSelecionados($('#btnConfirmarEnvio'), true));
  $('#modalRevisao').addEventListener('click', (ev) => {
    if (ev.target.id === 'modalRevisao') fecharRevisao();   // clique fora fecha
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && $('#modalRevisao').classList.contains('aberto')) fecharRevisao();
  });

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
    goTo(3);
    renderValidacao();
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
