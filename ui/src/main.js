import './styles/app.css';
import { h, clear } from './ui/dom.js';

const ROUTES = [
  { path: '/', label: '首页', load: () => import('./views/home.js') },
  { path: '/run', label: '开始检测', load: () => import('./views/run.js') },
  { path: '/map', label: '型号地图', load: () => import('./views/map.js') },
  { path: '/history', label: '历史', load: () => import('./views/history.js') },
  { path: '/about', label: '方法与局限', load: () => import('./views/about.js') },
];

const app = document.getElementById('app');
const outlet = h('main.main');

function themeToggle() {
  const btn = h('button.theme-toggle', {
    type: 'button', title: '切换明暗', 'aria-label': '切换明暗主题',
    onclick: () => {
      const root = document.documentElement;
      const isDark = root.dataset.theme
        ? root.dataset.theme === 'dark'
        : !window.matchMedia('(prefers-color-scheme: light)').matches;
      const next = isDark ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('llmfp-theme', next); } catch {}
      btn.textContent = next === 'dark' ? '☾' : '☀';
    },
  }, document.documentElement.dataset.theme === 'light' ? '☀' : '☾');
  return btn;
}

const nav = h('nav.nav', { 'aria-label': '主导航' },
  ...ROUTES.filter((r) => r.path !== '/').map((r) =>
    h('a.nav-link', { href: r.path, dataset: { path: r.path } }, r.label)));

app.append(
  h('div.shell',
    h('header.topbar',
      h('a.brand', { href: '/' }, h('span.brand-mark', '◈'), '指纹核验'),
      nav,
      themeToggle()),
    outlet,
    h('footer.footer',
      h('div.footer-inner',
        h('div',
          '方法复现自 Bruckner, T. (2026) ',
          h('em', 'One Token Is Enough'),
          '，arXiv:2607.10252。上游数据集 CC-BY-4.0，代码 MIT，已做子集化与重排。'),
        h('div',
          h('a', { href: '/about' }, '能力与局限'), ' · ',
          h('a', { href: 'https://github.com/zhyouhh/llm-fingerprint', rel: 'noopener' }, '源码'))))),
);

/* ── routing ──────────────────────────────────────────────────────────────
 * History API rather than hashes: wrangler's not_found_handling serves index.html for
 * every unmatched path, so real URLs work on reload and when shared. */

let token = 0;

async function render(path) {
  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  const mine = ++token;

  for (const link of nav.querySelectorAll('.nav-link')) {
    if (link.dataset.path === route.path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  clear(outlet);
  outlet.append(h('div.page', h('p.faint', h('span.spinner'), ' 加载中')));

  try {
    const mod = await route.load();
    if (mine !== token) return;           // a newer navigation won
    clear(outlet);
    outlet.append(await mod.view({ navigate }));
  } catch (err) {
    if (mine !== token) return;
    clear(outlet);
    outlet.append(h('div.page',
      h('div.banner', '这个页面没能加载：', String(err?.message ?? err)),
      h('p.faint', { style: { marginTop: 'var(--gap-3)' } }, '刷新一次通常就好。')));
    console.error(err);
  }
  if (mine === token) window.scrollTo({ top: 0, behavior: 'instant' });
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render(path);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const href = a.getAttribute('href');
  if (!href?.startsWith('/') || a.target === '_blank') return;
  e.preventDefault();
  navigate(href);
});

window.addEventListener('popstate', () => render(location.pathname));
render(location.pathname);
