// public/js/register.js
const $ = (s) => document.querySelector(s);

function showToast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('is-visible'), 3000);
}

function emailValid(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').toLowerCase());
}

async function checkEmailExists(email) {
  try {
    const r = await fetch(`/api/auth/check-email?email=${encodeURIComponent(email)}`);
    const j = await r.json().catch(() => ({}));
    return Boolean(j?.exists);
  } catch {
    return false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = $('#form-register');
  const btn  = $('#btn-submit');

  const firstEl   = $('#first_name');
  const lastEl    = $('#last_name');
  const companyEl = $('#company');
  const emailEl   = $('#email');
  const passEl    = $('#password');
  const confEl    = $('#confirm');

  const errFirst   = $('#err-first');
  const errLast    = $('#err-last');
  const errCompany = $('#err-company');
  const errEmail   = $('#err-email');
  const errConf    = $('#err-confirm');
  const hintEmail  = $('#hint-email');

  emailEl?.addEventListener('blur', async () => {
    const e = emailEl.value.trim();
    if (!emailValid(e)) { hintEmail.textContent = ''; return; }
    const exists = await checkEmailExists(e);
    hintEmail.textContent = exists ? 'Este e-mail já está cadastrado.' : 'E-mail disponível.';
    hintEmail.style.color = exists ? '#b91c1c' : 'var(--muted-foreground,#6b7280)';
  });

  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    [errFirst, errLast, errCompany, errEmail, errConf].forEach(el => el?.classList.remove('is-visible'));

    const first    = (firstEl.value || '').trim();
    const last     = (lastEl.value || '').trim();
    const company  = (companyEl.value || '').trim();
    const email    = (emailEl.value || '').trim();
    const password = passEl.value;
    const confirm  = confEl.value;

    let ok = true;
    if (first.length < 2)   { errFirst.classList.add('is-visible');   ok = false; }
    if (last.length  < 2)   { errLast.classList.add('is-visible');    ok = false; }
    if (company.length < 2) { errCompany.classList.add('is-visible'); ok = false; }
    if (!emailValid(email)) { errEmail.classList.add('is-visible');   ok = false; }
    if (password.length < 6 || password !== confirm) {
      errConf.classList.add('is-visible'); ok = false;
    }
    if (!ok) return;

    const name = [first, last].filter(Boolean).join(' ');

    btn.disabled = true;
    btn.textContent = 'Criando…';
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, company })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error || 'Falha ao cadastrar';
        if (String(msg).toLowerCase().includes('email')) errEmail.classList.add('is-visible');
        showToast(msg);
        return;
      }
      // sucesso: sessão já criada no backend
      showToast('Conta criada com sucesso!');
      setTimeout(() => { window.location.href = '/home.html'; }, 600);
    } catch (e) {
      showToast(e?.message || 'Erro de rede');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Criar conta';
    }
  });
});
