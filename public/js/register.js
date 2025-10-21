// Helpers
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Toast
function showToast(message, duration = 3000) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

// Inline errors
function showError(el, msg){ if(!el) return; el.textContent = msg; el.classList.add('is-visible'); }
function hideError(el){ if(!el) return; el.textContent = ''; el.classList.remove('is-visible'); }
function setInputError(input, has){ if(!input) return; input.classList.toggle('error-state', !!has); }

// Loading (overlay + botão)
function setLoading(on){
  if (typeof window.pageLoaderShow === 'function' && typeof window.pageLoaderDone === 'function') {
    if (on) window.pageLoaderShow(); else window.pageLoaderDone();
    return;
  }
  const el = document.getElementById('pageLoader');
  if (!el) return;
  if (on) el.classList.remove('hidden'); else el.classList.add('hidden');
}

// Email validator
const emailValid = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').toLowerCase());

// API helpers
async function apiCheckEmail(email){
  const url = `/api/auth/check-email?email=${encodeURIComponent(email)}`;
  const r = await fetch(url, { headers: { 'Accept':'application/json' }, credentials:'same-origin' });
  if(!r.ok) throw new Error('Falha ao verificar e-mail.');
  const j = await r.json().catch(()=> ({}));
  return Boolean(j.exists ?? j?.data?.exists);
}

async function apiRegister(payload){
  const r = await fetch('/api/auth/register', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
    credentials:'same-origin',
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok){
    const msg = j?.error || j?.message || 'Falha ao criar conta.';
    throw new Error(msg);
  }
  return j;
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  const form = $('#form-register');
  const btn  = $('#btn-submit');

  // inputs
  const firstNameInput = $('#first_name');
  const lastNameInput  = $('#last_name');
  const companyInput   = $('#company');
  const emailInput     = $('#email');
  const passwordInput  = $('#password');
  const confirmInput   = $('#confirm');

  // errors
  const errFirst   = $('#err-first');
  const errLast    = $('#err-last');
  const errCompany = $('#err-company');
  const errEmail   = $('#err-email');
  const errConfirm = $('#err-confirm');
  const hintEmail  = $('#hint-email');

  if (!form || !btn) return;

  const inputs = [firstNameInput,lastNameInput,companyInput,emailInput,passwordInput,confirmInput];
  const errs   = [errFirst,errLast,errCompany,errEmail,null,errConfirm];

  // limpar erro ao digitar
  inputs.forEach((input, i) => {
    input?.addEventListener('input', () => {
      if (errs[i]) hideError(errs[i]);
      setInputError(input, false);
    });
  });

  // checagem de e-mail
  emailInput?.addEventListener('blur', async () => {
    const email = emailInput.value.trim();
    if(!hintEmail) return;

    hintEmail.className = 'hint';
    hintEmail.textContent = '';
    if(!email || !emailValid(email)) return;

    try{
      hintEmail.textContent = 'Verificando...';
      const exists = await apiCheckEmail(email);
      hintEmail.textContent = exists ? 'Este e-mail já está cadastrado.' : 'E-mail disponível.';
      hintEmail.classList.add(exists ? 'warning' : 'success');
    }catch{
      hintEmail.textContent = '';
    }
  });

  emailInput?.addEventListener('input', () => {
    if (!hintEmail) return;
    hintEmail.className = 'hint';
    hintEmail.textContent = '';
  });

  // validação
  function validate(){
    let ok = true;
    [errFirst,errLast,errCompany,errEmail,errConfirm].forEach(hideError);
    inputs.forEach(i => setInputError(i,false));

    const first = firstNameInput?.value.trim() || '';
    const last  = lastNameInput?.value.trim() || '';
    const comp  = companyInput?.value.trim() || '';
    const email = emailInput?.value.trim() || '';
    const pass  = passwordInput?.value || '';
    const conf  = confirmInput?.value || '';

    if(first.length < 2){ showError(errFirst,'Informe seu nome.'); setInputError(firstNameInput,true); ok = false; }
    if(last.length  < 2){ showError(errLast,'Informe seu sobrenome.'); setInputError(lastNameInput,true); ok = false; }
    if(comp.length  < 2){ showError(errCompany,'Informe o nome da empresa.'); setInputError(companyInput,true); ok = false; }
    if(!emailValid(email)){ showError(errEmail,'Informe um e-mail válido.'); setInputError(emailInput,true); ok = false; }
    if(pass.length  < 6){ showError(errConfirm,'A senha deve ter no mínimo 6 caracteres.'); setInputError(passwordInput,true); ok = false; }
    if(pass !== conf){   showError(errConfirm,'As senhas não coincidem.'); setInputError(confirmInput,true); ok = false; }

    return ok;
  }

  // submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!validate()){
      showToast('Por favor, corrija os erros no formulário.');
      return;
    }

    const name = `${firstNameInput.value.trim()} ${lastNameInput.value.trim()}`.trim().replace(/\s+/g,' ');
    const payload = {
      // o backend usa só estes campos:
      name,
      email: emailInput.value.trim(),
      password: passwordInput.value
      // company é ignorado pela API atual; mantemos apenas no frontend
    };

    // estados de loading
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Criando…';
    setLoading(true);

    try{
      await apiRegister(payload);
      showToast('Conta criada com sucesso!');
      // já loga e cria sessão no servidor -> manda direto pra home
      setTimeout(() => { window.location.href = '/home.html'; }, 600);
    }catch(err){
      const msg = err?.message || 'Erro ao criar conta. Tente novamente.';
      showToast(msg);
      if (/mail|email/i.test(msg)) {
        showError(errEmail, msg);
        setInputError(emailInput, true);
      }
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = 'Criar conta';
      setLoading(false);
    }
  });
});
