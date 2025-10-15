// public/js/ml-integration.js
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const api = {
  get: (url) => fetch(url).then(r => r.json()),
  post: (url, body) =>
    fetch(url, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) })
      .then(r => r.json())
};

const SHOW_DEBUG = false; // deixe true só quando quiser ver JSON dentro do card

function setLog(obj){
  const pre = $('[data-ml="log"]');
  if (!pre) return;
  if (!SHOW_DEBUG){ pre.hidden = true; pre.textContent = ''; return; }
  pre.hidden = false;
  pre.textContent = JSON.stringify(obj, null, 2);
  pre.classList.add('ml-log'); // e ainda assim fica pequeno
}

function pill(el, state){
  el.classList.remove('ok','off');
  if (state === 'ok'){
    el.textContent = window.__mlNickname || 'Conectado';
    el.classList.add('ok');
  }else{
    el.textContent = 'Não conectado';
    el.classList.add('off');
  }
}

async function refreshStatus(){
  const card = $('[data-ml="card"]');
  const pillEl = $('[data-ml="status-pill"]', card);
  const btnConnect = $('[data-ml="connect"]', card);
  const btnDisconnect = $('[data-ml="disconnect"]', card);
  try{
    const st = await api.get('/api/ml/status');
    setLog({ status: st });
    if (st.connected){
      window.__mlNickname = st.nickname;
      pill(pillEl, 'ok');
      btnConnect.hidden = true;
      btnDisconnect.hidden = false;
    }else{
      window.__mlNickname = '';
      pill(pillEl, 'off');
      btnConnect.hidden = false;
      btnDisconnect.hidden = true;
    }
  }catch(e){
    pill(pillEl, 'off');
  }
}

function renderAccountsList(data){
  const list = $('[data-ml="accounts"]');
  list.innerHTML = '';
  const items = data?.items || [];
  const active = data?.active_user_id || null;

  if (!items.length){
    const li = document.createElement('div');
    li.className = 'ml-acc-row';
    li.innerHTML = `<div class="ml-acc-left"><span class="ml-acc-name">Nenhuma conta salva</span></div>`;
    list.appendChild(li);
    return;
  }

  items.forEach(acc => {
    const row = document.createElement('div');
    row.className = 'ml-acc-row';

    const left = document.createElement('div');
    left.className = 'ml-acc-left';
    left.innerHTML = `
      <span class="ml-acc-name">${acc.nickname}</span>
      <span class="ml-acc-id">(${acc.user_id})</span>
      ${active === acc.user_id ? `<span class="ml-badge">Ativa</span>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'ml-acc-actions';
    if (active !== acc.user_id){
      const btn = document.createElement('button');
      btn.className = 'btn btn--primary';
      btn.textContent = 'Ativar';
      btn.addEventListener('click', async () => {
        await api.post('/api/ml/active', { user_id: String(acc.user_id) });
        // revalida tudo
        await Promise.all([refreshStatus(), refreshAccounts()]);
      });
      actions.appendChild(btn);
    }

    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function refreshAccounts(){
  try{
    const accs = await api.get('/api/ml/accounts');
    setLog({ accounts: accs });
    renderAccountsList(accs);
  }catch(e){
    // silencia
  }
}

function wireActions(){
  const card = $('[data-ml="card"]');
  const btnDisconnect = $('[data-ml="disconnect"]', card);
  const btnMe = $('[data-ml="me"]', card);

  btnDisconnect.addEventListener('click', async () => {
    await api.post('/api/ml/disconnect');
    await Promise.all([refreshStatus(), refreshAccounts()]);
    alert('Desconectado com sucesso.');
  });

  btnMe.addEventListener('click', async () => {
    try{
      const r = await api.get('/api/ml/me');
      if (r?.ok){
        alert(`Conta ativa: ${r.account.nickname} (user_id ${r.account.user_id})`);
      }else{
        alert('Não conectado.');
      }
    }catch(_){
      alert('Não conectado.');
    }
  });
}

(async function init(){
  wireActions();
  await Promise.all([refreshStatus(), refreshAccounts()]);
})();
