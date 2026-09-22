const form = document.getElementById('gate-form');
const input = document.getElementById('passphrase');
const submit = document.getElementById('submit');
const error = document.getElementById('error');

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: input.value }),
    });

    if (response.ok) {
      // Back to wherever they were headed, or the dashboard.
      const next = new URLSearchParams(location.search).get('next');
      location.href = next && next.startsWith('/') ? next : '/';
      return;
    }

    const payload = await response.json().catch(() => ({}));
    showError(payload.error ?? `Sign in failed (${response.status}).`);
    input.select();
  } catch (e) {
    showError(`Could not reach the server: ${e.message}`);
  } finally {
    submit.disabled = false;
  }
});
