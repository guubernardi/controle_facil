// public/js/register.js

// Helpers
const $  = (s) => document.querySelector(s);

// Toast simples
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

// Validação de e-mail
const emailValid = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').toLowerCase());

// API helpers
async function apiCheckEmail(email){
  const url = `/api/auth/check-email?email=${encodeURIComponent(email)}`;
  const r = await fetch(url, { headers: { 'Accept':'application/json' }, credentials:'include' });
  if(!r.ok) return false;
  const j = await r.json().catch(()=> ({}));
  return Boolean(j.exists ?? j?.data?.exists);
}

async function apiRegister(payload){
  const r = await fetch('/api/auth/register', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
    credentials:'include',
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok){
    throw new Error(j?.error || j?.message || 'Falha ao criar conta.');
  }
  return j;
}

document.addEventListener('DOMContentLoaded', () => {
  const form = $('#form-register');
  const btn  = $('#btn-submit');

  const firstNameInput = $('#first_name');
  const lastNameInput  = $('#last_name');
  const companyInput   = $('#company');
  const emailInput     = $('#email');
  const passwordInput  = $('#password');
  const confirmInput   = $('#confirm');

  const errFirst   = $('#err-first');
  const errLast    = $('#err-last');
  const errCompany = $('#err-company');
  const errEmail   = $('#err-email');
  const errConfirm = $('#err-confirm');
  const hintEmail  = $('#hint-email');

  const setInputError = (input, has) => input && input.classList.toggle('error-state', !!has);
  const showError = (el, msg) => { if(el){ el.textContent = msg; el.classList.add('is-visible'); } };
  const hideError = (el) => { if(el){ el.textContent = ''; el.classList.remove('is-visible'); } };

  if (!form || !btn) return;

  // limpa erros ao digitar
  [firstNameInput,lastNameInput,companyInput,emailInput,passwordInput,confirmInput].forEach((input) => {
    input?.addEventListener('input', () => {
      [errFirst,errLast,errCompany,errEmail,errConfirm].forEach(hideError);
      setInputError(input, false);
      if (input === emailInput && hintEmail) { hintEmail.className = 'hint'; hintEmail.textContent = ''; }
    });
  });

  // checagem de e-mail (disponível/ocupado)
  emailInput?.addEventListener('blur', async () => {
    const email = emailInput.value.trim();
    if (!hintEmail) return;
    hintEmail.className = 'hint';
    hintEmail.textContent = '';
    if (!email || !emailValid(email)) return;
    try{
      hintEmail.textContent = 'Verificando...';
      const exists = await apiCheckEmail(email);
      hintEmail.textContent = exists ? 'Este e-mail já está cadastrado.' : 'E-mail disponível.';
      hintEmail.classList.add(exists ? 'warning' : 'success');
    }catch{ hintEmail.textContent = ''; }
  });

  function validate(){
    let ok = true;
    [errFirst,errLast,errCompany,errEmail,errConfirm].forEach(hideError);

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!validate()){
      showToast('Por favor, corrija os erros no formulário.');
      return;
    }

    // MONTA O PAYLOAD QUE O BACK-END ESPERA
    const name = `${firstNameInput.value.trim()} ${lastNameInput.value.trim()}`.replace(/\s+/g, ' ').trim();
    const payload = {
      name,                                // << esperado pela rota
      email: emailInput.value.trim(),      // << esperado pela rota
      password: passwordInput.value,       // << esperado pela rota
      // opcional: ainda enviamos company se quiser registrar depois (servidor ignora)
      company: companyInput.value.trim()
    };

    btn.disabled = true;
    btn.classList.add('loading');
    const originalText = btn.textContent;
    btn.textContent = 'Criando…';

    try{
      await apiRegister(payload);
      // sessão já é criada no servidor; pode ir direto pra home
      showToast('Conta criada com sucesso!');
      setTimeout(() => { window.location.href = '/home.html'; }, 600);
    }catch(err){
      const msg = err?.message || 'Erro ao criar conta. Tente novamente.';
      showToast(msg);
      if (/mail|email/i.test(msg)) { showError(errEmail, msg); setInputError(emailInput, true); }
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = originalText;
    }
  });
});
