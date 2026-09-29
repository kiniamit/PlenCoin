/**
 * Tap-to-reveal for `title` tooltips.
 *
 * Hover never fires on a touch screen, so a `title` is invisible on a phone.
 * This shows the same text in a bubble on tap. Native hover is left intact on
 * desktop - the title is only pulled off while the bubble is open, so the two
 * never show at once.
 */
const bubble = document.createElement('div');
bubble.className = 'tip-bubble';
bubble.setAttribute('role', 'tooltip');
bubble.hidden = true;
document.body.append(bubble);

let anchor = null;
let stashedTitle = null;

function hide() {
  if (anchor && stashedTitle !== null) anchor.setAttribute('title', stashedTitle);
  anchor = null;
  stashedTitle = null;
  bubble.hidden = true;
}

function show(element, text) {
  hide();
  anchor = element;
  stashedTitle = element.getAttribute('title');
  if (stashedTitle !== null) element.removeAttribute('title');

  bubble.textContent = text;
  bubble.hidden = false;
  bubble.style.left = '0px';
  bubble.style.top = '0px';

  const rect = element.getBoundingClientRect();
  const margin = 8;
  const maxLeft = document.documentElement.clientWidth - bubble.offsetWidth - margin;
  const left = rect.left + window.scrollX + rect.width / 2 - bubble.offsetWidth / 2;

  // Flip above when there is no room below.
  const below = rect.bottom + bubble.offsetHeight + 14 <= window.innerHeight;
  const top = below
    ? rect.bottom + window.scrollY + 6
    : rect.top + window.scrollY - bubble.offsetHeight - 6;

  bubble.style.left = `${Math.max(margin, Math.min(left, Math.max(margin, maxLeft)))}px`;
  bubble.style.top = `${top}px`;
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[title]');

  // Never swallow a click meant for a link or a control.
  if (!element || element.closest('a, button, input, label')) {
    hide();
    return;
  }

  const text = element.getAttribute('title');
  if (!text || element === anchor) {
    hide();
    return;
  }

  show(element, text);
  event.stopPropagation();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hide();
});
window.addEventListener('scroll', hide, { passive: true });
window.addEventListener('resize', hide);
