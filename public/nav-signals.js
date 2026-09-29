/**
 * Adds the Signals link to a page header and badges it with the number of
 * urgent deadlines. Shared by every page, so the count follows you around.
 */
const DAY_MS = 86400_000;

const link = document.createElement('a');
link.className = 'nav-link';
link.href = '/signals.html';
link.textContent = 'Signals';

const actions = document.querySelector('.topbar-actions');
if (actions) actions.prepend(link);

try {
  const response = await fetch('/api/signals');
  if (response.ok) {
    const payload = await response.json();
    const urgent = (payload.signals ?? []).filter(
      (s) => Math.ceil((new Date(s.deadline) - Date.now()) / DAY_MS) <= 7,
    ).length;
    if (urgent > 0) {
      link.classList.add('has-signals');
      link.dataset.count = String(urgent);
      link.title = `${urgent} deadline${urgent === 1 ? '' : 's'} within 7 days`;
    }
  }
} catch {
  /* the badge is a nicety; never block the page for it */
}
