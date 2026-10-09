// docmd prefixes heading ids with their parent headings ("crawling-stop-resume"), while the
// docs link with GitHub-style anchors ("#stop--resume"). Resolve such hashes to the docmd id.
(function () {
  const norm = (s) => decodeURIComponent(s).toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');

  function resolve() {
    const hash = location.hash.slice(1);
    if (!hash || document.getElementById(hash)) return;
    const want = norm(hash);
    const headings = document.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    const match = [...headings].find((h) => {
      const id = norm(h.id);
      return id === want || id.endsWith('-' + want);
    });
    if (match) {
      history.replaceState(null, '', '#' + match.id);
      match.scrollIntoView();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve);
  else resolve();
  window.addEventListener('hashchange', resolve);
})();
