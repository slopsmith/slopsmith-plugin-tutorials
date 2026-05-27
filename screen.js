// slopsmith-plugin-tutorials — browse/lesson/author SPA.
//
// Loaded by the core plugin loader (plugins/__init__.py:1320) and
// hydrated into #plugin-tutorials in screen.html.
//
// Routing model: a tiny `view` state machine driven by clicks + the
// "currentLessonRef" payload window.slopsmith.navigate carries. We
// deliberately don't use the URL hash because the host app already
// owns location.hash for its own #screen=... routing.

(function () {
  'use strict';

  const PLUGIN_ID = 'tutorials';
  const API_BASE  = `/api/plugins/${PLUGIN_ID}`;
  const MINIGAMES_RUNS_URL = '/api/plugins/minigames/runs';

  // ── Tiny DOM helpers ──────────────────────────────────────────────────
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (k === 'html') node.innerHTML = attrs[k];
        else if (attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  async function api(path, opts) {
    const res = await fetch(API_BASE + path, opts || {});
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail || ''; } catch (_) {}
      throw new Error(`API ${path} → ${res.status} ${detail}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ── State ─────────────────────────────────────────────────────────────

  const state = {
    mode: 'browse',                  // 'browse' | 'author'
    view: { kind: 'browse' },        // 'browse' | 'pack' | 'lesson' | 'author'
    packs: [],                       // summaries from /packs
    progress: { packs: {} },         // from /progress
    activePackId: null,
    activeLessonId: null,
    libraryFiles: null,              // lazy-loaded for author mode (sloppak picker)
    pendingRun: null,                // { packId, lessonId } — waiting on song:ended
  };

  // ── Bootstrap ─────────────────────────────────────────────────────────

  function injectTopLevelNav() {
    // Promote Tutorials out of the plugins dropdown into a sibling of
    // Library / Favorites / Upload / Settings. Each insertion is guarded
    // by an id check so loadPlugins() re-running (hot-reload, settings
    // changes) doesn't append duplicates.
    const onClick = (e) => {
      e.preventDefault();
      const menu = document.getElementById('mobile-menu');
      if (menu && !menu.classList.contains('hidden')) menu.classList.add('hidden');
      if (typeof window.showScreen === 'function') {
        window.showScreen('plugin-tutorials');
      }
    };

    const navPlugins = document.getElementById('nav-plugins');
    if (navPlugins && !document.getElementById('tut-nav-top-link')) {
      const link = document.createElement('a');
      link.id = 'tut-nav-top-link';
      link.href = '#';
      link.className = 'text-sm text-gray-400 hover:text-white transition';
      link.textContent = 'Tutorials';
      link.addEventListener('click', onClick);
      navPlugins.parentElement.insertBefore(link, navPlugins);
    }

    const mobileNav = document.getElementById('mobile-nav-plugins');
    if (mobileNav && !document.getElementById('tut-nav-top-link-mobile')) {
      const link = document.createElement('a');
      link.id = 'tut-nav-top-link-mobile';
      link.href = '#';
      link.className = 'text-gray-400 hover:text-white';
      link.textContent = 'Tutorials';
      link.addEventListener('click', onClick);
      mobileNav.parentElement.insertBefore(link, mobileNav);
    }
  }

  function init() {
    const host = document.getElementById('plugin-tutorials');
    if (!host) return; // screen not in DOM yet — host will retry hydration

    injectTopLevelNav();

    host.querySelectorAll('.tut-mode').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // Subscribe to song-end so we can prompt the user to record the run.
    // Only subscribe once: on the first execution window.slopsmithTutorials
    // is undefined (falsy), so the guard passes; on plugin reloads the
    // public surface is already alive and we skip re-subscription to avoid
    // duplicate onSongEnded calls.
    if (!window.slopsmithTutorials?.__alive) {
      if (window.slopsmith && typeof window.slopsmith.on === 'function') {
        window.slopsmith.on('song:ended', onSongEnded);
      }
    }

    // Pick up navigation payloads (e.g. another plugin deep-linking us).
    if (window.slopsmith && typeof window.slopsmith.getNavParams === 'function') {
      const params = window.slopsmith.getNavParams();
      if (params && params.packId) {
        state.activePackId = params.packId;
        state.activeLessonId = params.lessonId || null;
        state.view = state.activeLessonId
          ? { kind: 'lesson' }
          : { kind: 'pack' };
      }
    }

    refreshAndRender();
  }

  async function refreshAndRender() {
    try {
      const [packsRes, progressRes] = await Promise.all([
        api('/packs'),
        api('/progress').catch(() => ({ packs: {} })),
      ]);
      state.packs = packsRes.packs || [];
      state.progress = progressRes || { packs: {} };
    } catch (err) {
      console.error('[tutorials] failed to load packs', err);
    }
    render();
  }

  function render() {
    const root = document.getElementById('tutorials-root');
    if (!root) return;
    root.innerHTML = '';
    document.querySelectorAll('#plugin-tutorials .tut-mode').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.dataset.mode === state.mode ? 'true' : 'false');
    });

    if (state.mode === 'author') {
      renderAuthor(root);
      return;
    }
    switch (state.view.kind) {
      case 'pack':   return renderPackDetail(root);
      case 'lesson': return renderLesson(root);
      default:       return renderBrowse(root);
    }
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    state.view = mode === 'author' ? { kind: 'author' } : { kind: 'browse' };
    // Author always lands on an empty form — the active pack carries over
    // only within a single Author session, not across Browse↔Author trips.
    if (mode === 'author') state.activePackId = null;
    render();
  }

  // ── Browse ────────────────────────────────────────────────────────────

  function renderBrowse(root) {
    if (!state.packs.length) {
      root.appendChild(el('div', { class: 'tut-empty' },
        'No tutorial packs installed yet. Switch to Author mode to create one.'));
      return;
    }
    const grid = el('div', { class: 'tut-pack-grid' });
    for (const pack of state.packs) {
      grid.appendChild(packCard(pack));
    }
    root.appendChild(grid);
  }

  function packCard(pack) {
    const progress = packProgressPct(pack);
    const card = el('article', {
      class: 'tut-pack-card',
      onclick: () => {
        state.activePackId = pack.id;
        state.view = { kind: 'pack' };
        render();
      },
    }, [
      pack.cover_url
        ? el('div', { class: 'tut-pack-cover' },
            el('img', { src: pack.cover_url + '?v=' + Date.now(), alt: pack.title || pack.id, loading: 'lazy' }))
        : el('div', { class: 'tut-pack-cover tut-pack-cover-placeholder' },
            el('span', null, (pack.title || pack.id || '?').slice(0, 1).toUpperCase())),
      el('h3', null, pack.title || pack.id),
      el('p',  { class: 'tut-pack-author' }, pack.author ? `by ${pack.author}` : ' '),
      el('div', { class: 'tut-progress-bar' },
        el('div', { class: 'tut-progress-fill', style: `width:${progress}%` })),
      el('div', { class: 'tut-tags' }, (pack.techniques || []).map((t) =>
        el('span', { class: 'tut-tag' }, t))),
      el('p',  { class: 'tut-pack-author', style: 'margin-top:0.5rem;margin-bottom:0' },
        `${pack.lesson_count || 0} lessons · ${progress}% complete`),
    ]);
    return card;
  }

  function packProgressPct(pack) {
    const p = state.progress.packs?.[pack.id];
    if (!p || !pack.lesson_count) return 0;
    const passed = Object.values(p.lessons || {}).filter((l) => l && l.passed).length;
    return Math.round((passed / pack.lesson_count) * 100);
  }

  // ── Pack detail (lesson list) ─────────────────────────────────────────

  async function renderPackDetail(root) {
    const packId = state.activePackId;
    if (!packId) { state.view = { kind: 'browse' }; return render(); }
    let manifest;
    try {
      manifest = await api(`/packs/${packId}`);
    } catch (err) {
      root.appendChild(el('div', { class: 'tut-empty' }, `Could not load pack: ${err.message}`));
      return;
    }
    const progress = state.progress.packs?.[packId]?.lessons || {};
    const back = el('button', {
      class: 'tut-btn tut-btn-ghost',
      onclick: () => { state.view = { kind: 'browse' }; render(); },
    }, '← Back');
    const header = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;' }, [
      el('div', null, [
        el('h2', { style: 'margin:0;font-size:1.3rem' }, manifest.title || manifest.id),
        el('p',  { class: 'tut-pack-author' }, manifest.author ? `by ${manifest.author}` : ''),
      ]),
      back,
    ]);
    const list = el('div', { class: 'tut-lesson-list' });
    (manifest.lessons || []).forEach((lesson, idx) => {
      const st = progress[lesson.id] || {};
      const stateLabel = st.mastered ? 'Mastered' : st.passed ? 'Passed' : 'Locked';
      const stateClass = st.mastered ? 'is-mastery' : st.passed ? 'is-pass' : '';
      const hasThumb = !!lesson.thumb_url;
      const rowStyle = hasThumb
        ? `background-image:url('${lesson.thumb_url}?v=${Date.now()}')`
        : '';
      const rowClass = hasThumb ? 'tut-lesson-row has-thumb' : 'tut-lesson-row';
      list.appendChild(el('div', {
        class: rowClass,
        style: rowStyle,
        onclick: () => {
          state.activeLessonId = lesson.id;
          state.view = { kind: 'lesson' };
          render();
        },
      }, [
        el('div', { class: 'tut-lesson-overlay' }),
        el('div', { class: 'tut-lesson-meta', style: 'flex:1' }, [
          el('strong', null, `${idx + 1}. ${lesson.title || lesson.id}`),
          el('div', { class: 'tut-lesson-tags' },
            (lesson.techniques || []).join(' · ')),
        ]),
        el('div', { class: `tut-lesson-state ${stateClass}` }, [
          stateLabel,
          st.best_accuracy ? ` · best ${(st.best_accuracy * 100).toFixed(0)}%` : '',
        ].join('')),
      ]));
    });
    root.appendChild(header);
    root.appendChild(list);
  }

  // ── Lesson player ─────────────────────────────────────────────────────

  async function renderLesson(root) {
    const packId = state.activePackId;
    const lessonId = state.activeLessonId;
    if (!packId || !lessonId) { state.view = { kind: 'browse' }; return render(); }

    let manifest;
    try {
      manifest = await api(`/packs/${packId}`);
    } catch (err) {
      root.appendChild(el('div', { class: 'tut-empty' }, `Could not load pack: ${err.message}`));
      return;
    }
    const lesson = (manifest.lessons || []).find((l) => l.id === lessonId);
    if (!lesson) {
      root.appendChild(el('div', { class: 'tut-empty' }, 'Lesson not found in pack.'));
      return;
    }

    const wrap = el('div', { class: 'tut-lesson' });

    // Back row
    wrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
      el('div', null, [
        el('h2', { style: 'margin:0;font-size:1.3rem' }, lesson.title || lesson.id),
        el('p',  { class: 'tut-pack-author' }, `in "${manifest.title || manifest.id}"`),
      ]),
      el('button', {
        class: 'tut-btn tut-btn-ghost',
        onclick: () => { state.view = { kind: 'pack' }; render(); },
      }, '← Back'),
    ]));

    // Video
    const videoBox = el('div', { class: 'tut-video' });
    const video = lesson.video || {};
    if (video.type === 'youtube' && typeof video.src === 'string') {
      const ytId = parseYouTubeId(video.src);
      if (ytId) {
        videoBox.appendChild(el('iframe', {
          src: `https://www.youtube.com/embed/${ytId}?modestbranding=1&rel=0`,
          allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
          allowfullscreen: '',
        }));
      } else {
        videoBox.appendChild(el('div', { class: 'tut-empty' }, 'Invalid YouTube URL'));
      }
    } else if (video.type === 'file' && video.src && typeof video.src === 'string') {
      const src = video.src.startsWith('http') || video.src.startsWith('/')
        ? video.src
        : `${API_BASE}/packs/${packId}/videos/${encodeURIComponent(video.src.replace(/^videos\//, ''))}`;
      videoBox.appendChild(el('video', { src, controls: '', preload: 'metadata' }));
    } else {
      videoBox.appendChild(el('div', { class: 'tut-empty', style: 'border:0' },
        'No video attached to this lesson yet.'));
    }
    wrap.appendChild(videoBox);

    // Exercise CTA + submission form
    const passAcc = (lesson.pass?.accuracy ?? 0.7) * 100;
    const mastAcc = (lesson.mastery?.accuracy ?? 0.9) * 100;
    const ex = el('div', { class: 'tut-exercise' }, [
      el('h2', null, 'Exercise'),
      el('p', { class: 'tut-thresholds' },
        `Pass at ${passAcc.toFixed(0)}% · Mastery at ${mastAcc.toFixed(0)}%`),
    ]);

    const startBtn = el('button', {
      class: 'tut-btn',
      onclick: () => {
        const ex = lesson.exercise || {};
        if (!ex.sloppak) {
          alert('This lesson has no exercise sloppak attached yet.');
          return;
        }
        // Lesson manifests store DLC-relative paths so playSong can resolve
        // them via the core /ws/highway route.  Builtin packs ship relative
        // paths like "tutorials-builtin/<pack>/<file>.sloppak" — the backend
        // setup() installs those sloppaks under <DLC_DIR>/tutorials-builtin/
        // so the highway WS can find them.  Strip any legacy "sloppaks/"
        // pack-prefix that older Author saves may have written by mistake.
        const libraryFilename = ex.sloppak.replace(/^sloppaks\//, '');
        // Core's playSong forwards `arrangement` straight into the highway
        // WS query string, and the server types it as int (default -1 =
        // server picks). A string id like "lead" fails the int coercion
        // and the WS rejects with 403. Only forward if it parses as a
        // non-negative integer; otherwise let the server choose.
        const arrIdx = Number.parseInt(ex.arrangement, 10);
        const arrArg = Number.isFinite(arrIdx) && arrIdx >= 0 ? arrIdx : undefined;
        if (typeof window.playSong !== 'function') {
          alert('window.playSong is unavailable — is core slopsmith loaded?');
          return;
        }
        state.pendingRun = { packId, lessonId };
        window.playSong(libraryFilename, arrArg);
      },
    }, 'Start exercise');
    ex.appendChild(startBtn);

    // Manual record form — v1 is self-reported. Auto-scoring hooks in once
    // a stable accuracy metric is emitted by the highway.
    const form = el('form', {
      style: 'margin-top:1rem;display:flex;gap:0.75rem;align-items:end;flex-wrap:wrap;',
      onsubmit: async (e) => {
        e.preventDefault();
        const accuracy = parseFloat(form.querySelector('input[name=accuracy]').value) / 100;
        const score = Math.max(0, Math.round(accuracy * 1000));
        const speed = parseFloat(form.querySelector('input[name=speed]').value);
        await submitRun({ packId, lessonId, accuracy, score, speed, lesson }, resultBox);
      },
    }, [
      el('div', { class: 'tut-form-row', style: 'flex:1' }, [
        el('label', null, 'Accuracy %'),
        el('input', { type: 'number', name: 'accuracy', min: '0', max: '100', step: '1', value: '80', required: '' }),
      ]),
      el('div', { class: 'tut-form-row', style: 'flex:0 0 120px' }, [
        el('label', null, 'Speed'),
        el('input', { type: 'number', name: 'speed', min: '0.5', max: '1.5', step: '0.1', value: '1.0', required: '' }),
      ]),
      el('button', { type: 'submit', class: 'tut-btn' }, 'Record run'),
    ]);
    ex.appendChild(form);

    const resultBox = el('div', { class: 'tut-result', style: 'display:none' });
    ex.appendChild(resultBox);

    wrap.appendChild(ex);
    root.appendChild(wrap);
  }

  function parseYouTubeId(url) {
    if (!url) return null;
    const m = String(url).match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([A-Za-z0-9_-]{11})/,
    );
    return m ? m[1] : null;
  }

  function onSongEnded(/* ev */) {
    // The user finished the exercise — we don't auto-grade in v1, but
    // we can flag the lesson view so the record-run form is visually
    // primed. Future: read accuracy from the event detail when the
    // highway publishes one.
    if (!state.pendingRun) return;
    // Surface a quick toast hint in the result box if we're still on the
    // lesson view.  Don't navigate — the user may want to replay.
    const resultBox = document.querySelector('#plugin-tutorials .tut-result');
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.classList.remove('is-pass', 'is-mastery', 'is-fail');
      resultBox.innerHTML = 'Exercise finished. Enter your accuracy and tap <strong>Record run</strong> to log XP.';
    }
  }

  async function submitRun({ packId, lessonId, accuracy, score, speed, lesson }, resultBox) {
    let tutorialResult, minigamesResult;
    try {
      // Post to minigames first so we can show the XP-gained number
      // even if our local progress write fails (unlikely, but graceful).
      const gameId = `tutorial:${packId}:${lessonId}`;
      const mgRes = await fetch(MINIGAMES_RUNS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          game_id:  gameId,
          score,
          duration_ms: 0,
          modifiers: { speed },
          meta:      { lesson: lesson.title || lessonId, techniques: lesson.techniques || [] },
        }),
      });
      minigamesResult = mgRes.ok ? await mgRes.json() : null;

      tutorialResult = await api('/runs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pack_id: packId, lesson_id: lessonId, score, accuracy, speed }),
      });
    } catch (err) {
      resultBox.style.display = 'block';
      resultBox.classList.add('is-fail');
      resultBox.textContent = `Could not record run: ${err.message}`;
      return;
    }

    state.pendingRun = null;
    await refreshProgress();

    const passed = tutorialResult?.passed;
    const mastered = tutorialResult?.mastered;
    resultBox.classList.remove('is-pass', 'is-mastery', 'is-fail');
    resultBox.classList.add(mastered ? 'is-mastery' : passed ? 'is-pass' : 'is-fail');
    resultBox.style.display = 'block';

    const xpGained = minigamesResult?.xp_gained ?? 0;
    const level    = minigamesResult?.profile?.level ?? null;
    const status   = mastered ? '🏆 Mastery' : passed ? '✅ Pass' : '↻ Keep practicing';
    resultBox.innerHTML = '';
    resultBox.appendChild(el('strong', null, status));
    resultBox.appendChild(el('span', null,
      ` — accuracy ${(accuracy * 100).toFixed(0)}% at ${speed.toFixed(1)}× speed`));
    if (xpGained > 0) {
      resultBox.appendChild(el('div', null,
        `+${xpGained} XP${level != null ? ` · Level ${level}` : ''}`));
    }
    if (tutorialResult?.first_pass) {
      resultBox.appendChild(el('div', null, 'First time passing this lesson! 🎉'));
    }
    if (tutorialResult?.first_mastery) {
      resultBox.appendChild(el('div', null, 'First mastery! 🏆'));
    }
  }

  async function refreshProgress() {
    try {
      state.progress = await api('/progress');
    } catch (_) { /* non-fatal */ }
  }

  // ── Author mode ───────────────────────────────────────────────────────

  function renderAuthor(root) {
    const wrap = el('div', { class: 'tut-author' });
    const left = el('aside', null, [
      el('button', {
        class: 'tut-btn',
        style: 'width:100%;margin-bottom:0.5rem',
        onclick: () => promptNewPack(),
      }, '+ New pack'),
      el('div', { class: 'tut-author-list', id: 'tut-author-list' }),
    ]);
    const right = el('div', { id: 'tut-author-form' });
    wrap.appendChild(left);
    wrap.appendChild(right);
    root.appendChild(wrap);

    renderAuthorList();
    if (state.activePackId) {
      loadAndRenderAuthorForm(state.activePackId);
    } else {
      right.appendChild(authorWelcome());
    }
  }

  function renderAuthorList() {
    const listEl = document.getElementById('tut-author-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!state.packs.length) {
      listEl.appendChild(el('div', { class: 'tut-empty' }, 'No packs yet.'));
      return;
    }
    for (const pack of state.packs) {
      listEl.appendChild(el('button', {
        class: 'tut-author-pack',
        'aria-selected': pack.id === state.activePackId ? 'true' : 'false',
        onclick: () => {
          state.activePackId = pack.id;
          render();
        },
      }, pack.title || pack.id));
    }
  }

  async function promptNewPack() {
    const id = prompt('Pack id (lowercase, a-z0-9_-):');
    if (!id) return;
    const title = prompt('Pack title:') || id;
    try {
      const manifest = await api('/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title, author: '' }),
      });
      state.activePackId = manifest.id;
      await refreshAndRender();
    } catch (err) {
      alert(`Could not create pack: ${err.message}`);
    }
  }

  async function loadAndRenderAuthorForm(packId) {
    const formRoot = document.getElementById('tut-author-form');
    if (!formRoot) return;
    formRoot.innerHTML = '';
    let manifest;
    try {
      manifest = await api(`/packs/${packId}`);
    } catch (err) {
      formRoot.appendChild(el('div', { class: 'tut-empty' }, `Load failed: ${err.message}`));
      return;
    }
    // Ensure we have library files for the sloppak picker. /api/library
    // is paginated (default size 100); request the full library by walking
    // pages until we've covered `total`.
    if (!state.libraryFiles) {
      try {
        const all = [];
        let page = 1;
        const size = 1000;
        for (;;) {
          const r = await fetch(`/api/library?page=${page}&size=${size}`)
            .then((res) => res.json())
            .catch(() => null);
          if (!r || !Array.isArray(r.songs)) break;
          all.push(...r.songs);
          if (all.length >= (r.total || 0) || r.songs.length === 0) break;
          page += 1;
          if (page > 50) break; // sanity guard
        }
        state.libraryFiles = all
          .map((s) => s.filename || s.path || s.name)
          .filter(Boolean)
          .sort();
      } catch (_) { state.libraryFiles = []; }
    }
    formRoot.appendChild(authorForm(manifest));
  }

  function authorForm(manifest) {
    const form = el('div', { class: 'tut-author-form' });
    const titleInput = el('input', { type: 'text', value: manifest.title || '', placeholder: 'Pack title' });
    const authorInput = el('input', { type: 'text', value: manifest.author || '', placeholder: 'Author' });

    form.appendChild(el('div', { class: 'tut-form-row' }, [el('label', null, 'Title'), titleInput]));
    form.appendChild(el('div', { class: 'tut-form-row' }, [el('label', null, 'Author'), authorInput]));
    form.appendChild(el('div', { class: 'tut-form-row' }, [
      el('label', null, 'Pack techniques (comma-separated)'),
      tagInput('pack-techniques', manifest.techniques || []),
    ]));
    form.appendChild(coverRow(manifest));

    const lessonsHost = el('div');
    (manifest.lessons || []).forEach((lesson, idx) => {
      lessonsHost.appendChild(lessonEditor(manifest.id, lesson, idx));
    });
    form.appendChild(el('h3', { style: 'margin-top:1rem;margin-bottom:0.5rem' }, 'Lessons'));
    form.appendChild(lessonsHost);

    const addBtn = el('button', {
      class: 'tut-btn tut-btn-ghost',
      onclick: () => {
        const newLesson = blankLesson((manifest.lessons || []).length + 1);
        lessonsHost.appendChild(lessonEditor(manifest.id, newLesson, (manifest.lessons || []).length));
        manifest.lessons = manifest.lessons || [];
        manifest.lessons.push(newLesson);
      },
    }, '+ Add lesson');

    const saveStatus = el('span', { style: 'margin-left:0.75rem;color:var(--tut-muted);font-size:0.85rem' }, '');
    const saveBtn = el('button', {
      class: 'tut-btn',
      onclick: async () => {
        // Read all editors back into the manifest before saving.
        manifest.title = titleInput.value.trim();
        manifest.author = authorInput.value.trim();
        manifest.techniques = readTagInput('pack-techniques');
        manifest.lessons = Array.from(lessonsHost.querySelectorAll('[data-lesson-editor]'))
          .map((node) => readLessonEditor(node));
        // Verbose log so misbehaving saves can be diagnosed from devtools.
        console.log('[tutorials] Save pack — payload:', JSON.parse(JSON.stringify(manifest)));
        saveStatus.style.color = 'var(--tut-muted)';
        saveStatus.textContent = 'Saving…';
        try {
          await api(`/packs/${manifest.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(manifest),
          });
          saveStatus.style.color = 'var(--tut-good)';
          saveStatus.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
          console.log('[tutorials] Save pack — server accepted');
          await refreshAndRender();
        } catch (err) {
          saveStatus.style.color = 'var(--tut-bad)';
          saveStatus.textContent = `Save failed: ${err.message}`;
          console.error('[tutorials] Save pack failed:', err);
        }
      },
    }, 'Save pack');

    const deleteBtn = el('button', {
      class: 'tut-btn tut-btn-ghost',
      style: 'color:#e06868;border-color:#e06868',
      onclick: async () => {
        if (!confirm(`Delete pack "${manifest.id}"? This cannot be undone.`)) return;
        try {
          await api(`/packs/${manifest.id}`, { method: 'DELETE' });
          state.activePackId = null;
          await refreshAndRender();
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
        }
      },
    }, 'Delete pack');

    form.appendChild(el('div', { class: 'tut-row-buttons' }, [addBtn, saveBtn, deleteBtn, saveStatus]));
    return form;
  }

  function blankLesson(n) {
    return {
      id: `l${n}`,
      title: `Lesson ${n}`,
      video: { type: 'file', src: '' },
      exercise: { sloppak: '', arrangement: '' },
      pass: { accuracy: 0.7 },
      mastery: { accuracy: 0.9, speed: 1.0 },
      xp: { pass: 100, mastery: 250 },
      techniques: [],
    };
  }

  function lessonEditor(packId, lesson, idx) {
    const node = el('div', { class: 'tut-lesson-editor', dataset: { lessonEditor: '1' } });
    const idInput    = el('input', { type: 'text', value: lesson.id || '', dataset: { field: 'id' } });
    const titleInput = el('input', { type: 'text', value: lesson.title || '', dataset: { field: 'title' } });

    const videoTypeSel = el('select', { dataset: { field: 'video_type' } }, [
      el('option', { value: 'file' }, 'Upload a file'),
      el('option', { value: 'youtube' }, 'YouTube URL'),
    ]);
    videoTypeSel.value = (lesson.video && lesson.video.type) || 'file';

    const videoSrcInput = el('input', {
      type: 'text',
      value: lesson.video?.src || '',
      placeholder: videoTypeSel.value === 'youtube' ? 'https://youtu.be/...' : 'videos/<filename>.webm',
      dataset: { field: 'video_src' },
    });
    // Update the placeholder reactively when the source type changes so the
    // user gets the right hint after switching from "Upload a file" to
    // "YouTube URL" without having to guess what to type.
    videoTypeSel.addEventListener('change', () => {
      videoSrcInput.placeholder = videoTypeSel.value === 'youtube'
        ? 'https://youtu.be/...'
        : 'videos/<filename>.webm';
    });
    const fileInput = el('input', {
      type: 'file',
      accept: 'video/mp4,video/webm',
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const lessonId = idInput.value.trim();
      if (!lessonId) { alert('Set the lesson id first.'); return; }
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`${API_BASE}/packs/${packId}/videos?lesson_id=${encodeURIComponent(lessonId)}`, {
          method: 'POST',
          body: fd,
        });
        if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
        const j = await r.json();
        videoTypeSel.value = 'file';
        videoSrcInput.value = `videos/${j.filename}`;
      } catch (err) {
        alert(`Upload failed: ${err.message}`);
      }
    });

    const sloppakSel = el('select', { dataset: { field: 'sloppak' } });
    sloppakSel.appendChild(el('option', { value: '' }, '— none —'));
    if (lesson.exercise?.sloppak && !/^sloppaks\//.test(lesson.exercise.sloppak)) {
      // Legacy / direct library reference.
      sloppakSel.appendChild(el('option', { value: lesson.exercise.sloppak, selected: '' }, lesson.exercise.sloppak));
    }
    if (lesson.exercise?.sloppak && /^sloppaks\//.test(lesson.exercise.sloppak)) {
      sloppakSel.appendChild(el('option', { value: lesson.exercise.sloppak, selected: '' }, lesson.exercise.sloppak));
    }
    for (const filename of state.libraryFiles || []) {
      const opt = el('option', { value: filename }, filename);
      if (filename === lesson.exercise?.sloppak) opt.selected = true;
      sloppakSel.appendChild(opt);
    }
    const copySloppakBtn = el('button', {
      class: 'tut-btn tut-btn-ghost',
      onclick: async () => {
        const choice = sloppakSel.value;
        if (!choice) { alert('Pick a library sloppak first.'); return; }
        try {
          await api(`/packs/${packId}/sloppaks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: choice }),
          });
          // The pack now carries a self-contained copy under sloppaks/,
          // useful for export — but the lesson reference STAYS as the
          // library filename so playSong() can resolve it. The pack copy
          // and the library copy are two separate stores; the manifest
          // only points at the library one.
          alert(`Copied "${choice}" into the pack for distribution.`);
        } catch (err) {
          alert(`Copy failed: ${err.message}`);
        }
      },
    }, 'Copy into pack');

    const arrInput = el('input', {
      type: 'text', value: lesson.exercise?.arrangement || '',
      placeholder: 'arrangement id (optional)', dataset: { field: 'arrangement' },
    });
    const passInput = el('input', {
      type: 'number', min: '0', max: '1', step: '0.05',
      value: lesson.pass?.accuracy ?? 0.7, dataset: { field: 'pass' },
    });
    const mastInput = el('input', {
      type: 'number', min: '0', max: '1', step: '0.05',
      value: lesson.mastery?.accuracy ?? 0.9, dataset: { field: 'mastery' },
    });
    const mastSpeedInput = el('input', {
      type: 'number', min: '0.5', max: '1.5', step: '0.1',
      value: lesson.mastery?.speed ?? 1.0, dataset: { field: 'mastery_speed' },
    });
    const xpPassInput = el('input', {
      type: 'number', min: '0', step: '5', value: lesson.xp?.pass ?? 100, dataset: { field: 'xp_pass' },
    });
    const xpMastInput = el('input', {
      type: 'number', min: '0', step: '5', value: lesson.xp?.mastery ?? 250, dataset: { field: 'xp_mastery' },
    });

    const techNode = tagInput(`lesson-tech-${idx}-${lesson.id || 'new'}`, lesson.techniques || []);

    const removeBtn = el('button', {
      class: 'tut-btn tut-btn-ghost',
      style: 'color:#e06868;border-color:#e06868',
      onclick: () => node.remove(),
    }, 'Remove lesson');

    node.appendChild(el('h4', null, `Lesson #${idx + 1}`));
    node.appendChild(twoCol(
      formRow('Lesson id', idInput),
      formRow('Title', titleInput),
    ));
    node.appendChild(lessonThumbRow(packId, () => idInput.value.trim()));
    node.appendChild(twoCol(
      formRow('Video source', videoTypeSel),
      formRow('Video src / URL', videoSrcInput),
    ));
    node.appendChild(formRow('Upload local video (webm/mp4)', fileInput));
    node.appendChild(twoCol(
      formRow('Exercise sloppak (from library)', sloppakSel),
      formRow(' ', copySloppakBtn),
    ));
    node.appendChild(formRow('Arrangement id', arrInput));
    node.appendChild(twoCol(
      formRow('Pass accuracy (0–1)', passInput),
      formRow('Mastery accuracy (0–1)', mastInput),
    ));
    node.appendChild(twoCol(
      formRow('Mastery speed (≥0.5)', mastSpeedInput),
      formRow('Techniques', techNode),
    ));
    node.appendChild(twoCol(
      formRow('XP — pass', xpPassInput),
      formRow('XP — mastery', xpMastInput),
    ));
    node.appendChild(el('div', { class: 'tut-row-buttons' }, [removeBtn]));
    return node;
  }

  // ── Numeric parsing helpers ───────────────────────────────────────────────
  // Use these instead of `parseFloat(x) || fallback` so that an explicitly
  // authored value of 0 is preserved rather than silently replaced by the
  // fallback. (`||` coerces 0 → falsy; `??` passes NaN through.)
  function _numDefault(raw, fallback) {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : fallback;
  }
  function _intDefault(raw, fallback) {
    const v = parseInt(raw, 10);
    return Number.isFinite(v) ? v : fallback;
  }

  function readLessonEditor(node) {
    const get = (field) => node.querySelector(`[data-field="${field}"]`)?.value;
    const techHost = node.querySelector('.tut-tag-input');
    const techs = techHost
      ? Array.from(techHost.querySelectorAll('.tut-tag-chip')).map((c) => c.dataset.value)
      : [];
    return {
      id:    (get('id') || '').trim(),
      title: (get('title') || '').trim(),
      video: { type: get('video_type') || 'file', src: (get('video_src') || '').trim() },
      exercise: {
        sloppak:     (get('sloppak') || '').trim(),
        arrangement: (get('arrangement') || '').trim(),
      },
      pass:    { accuracy: _numDefault(get('pass'), 0.7) },
      mastery: {
        accuracy: _numDefault(get('mastery'),       0.9),
        speed:    _numDefault(get('mastery_speed'), 1.0),
      },
      xp: {
        pass:    _intDefault(get('xp_pass'),    0),
        mastery: _intDefault(get('xp_mastery'), 0),
      },
      techniques: techs,
    };
  }

  // ── Small UI primitives ───────────────────────────────────────────────

  function coverRow(manifest) {
    // Render a small preview + upload/clear controls for the pack cover.
    // The preview hits /packs/<id>/cover with a cache-busting query so a
    // freshly-uploaded cover refreshes without a full reload.
    const previewWrap = el('div', { class: 'tut-cover-preview' });
    function refreshPreview(cacheBust) {
      previewWrap.innerHTML = '';
      const url = `${API_BASE}/packs/${manifest.id}/cover?v=${cacheBust || Date.now()}`;
      const img = new Image();
      img.alt = 'Cover';
      img.onload = () => { previewWrap.appendChild(img); };
      img.onerror = () => {
        previewWrap.appendChild(el('div', { class: 'tut-empty', style: 'padding:0.75rem;font-size:0.85rem' },
          'No cover set yet.'));
      };
      img.src = url;
    }
    refreshPreview();

    const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`${API_BASE}/packs/${manifest.id}/cover`, { method: 'POST', body: fd });
        if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
        refreshPreview();
        // Bust caches on the browse-side card too.
        await refreshAndRender();
      } catch (err) {
        alert(`Cover upload failed: ${err.message}`);
      } finally {
        fileInput.value = '';
      }
    });

    const clearBtn = el('button', {
      class: 'tut-btn tut-btn-ghost',
      onclick: async () => {
        if (!confirm('Remove the cover image?')) return;
        try {
          await fetch(`${API_BASE}/packs/${manifest.id}/cover`, { method: 'DELETE' });
          refreshPreview();
          await refreshAndRender();
        } catch (err) {
          alert(`Cover remove failed: ${err.message}`);
        }
      },
    }, 'Remove cover');

    return el('div', { class: 'tut-form-row' }, [
      el('label', null, 'Cover image (PNG/JPEG/WebP, up to 4 MB)'),
      el('div', { style: 'display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap' }, [
        previewWrap, fileInput, clearBtn,
      ]),
    ]);
  }

  function lessonThumbRow(packId, getLessonId) {
    // Same shape as coverRow but parameterised by lesson_id. The id is
    // read lazily on each interaction so renaming a lesson in the editor
    // still uploads to the renamed slot rather than the original.
    const previewWrap = el('div', { class: 'tut-cover-preview' });
    function refresh(cacheBust) {
      previewWrap.innerHTML = '';
      const lessonId = getLessonId();
      if (!lessonId) {
        previewWrap.appendChild(el('div', { class: 'tut-empty', style: 'padding:0.4rem;font-size:0.75rem' },
          'Set id first'));
        return;
      }
      const url = `${API_BASE}/packs/${packId}/lessons/${encodeURIComponent(lessonId)}/thumb?v=${cacheBust || Date.now()}`;
      const img = new Image();
      img.alt = 'Thumb';
      img.onload  = () => { previewWrap.appendChild(img); };
      img.onerror = () => {
        previewWrap.appendChild(el('div', { class: 'tut-empty', style: 'padding:0.4rem;font-size:0.75rem' }, 'No thumb'));
      };
      img.src = url;
    }
    refresh();

    const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const lessonId = getLessonId();
      if (!lessonId) { alert('Set the lesson id first.'); return; }
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`${API_BASE}/packs/${packId}/lessons/${encodeURIComponent(lessonId)}/thumb`, {
          method: 'POST', body: fd,
        });
        if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
        refresh();
      } catch (err) {
        alert(`Thumb upload failed: ${err.message}`);
      } finally {
        fileInput.value = '';
      }
    });

    const clearBtn = el('button', {
      class: 'tut-btn tut-btn-ghost',
      onclick: async () => {
        const lessonId = getLessonId();
        if (!lessonId) return;
        if (!confirm(`Remove thumbnail for "${lessonId}"?`)) return;
        try {
          await fetch(`${API_BASE}/packs/${packId}/lessons/${encodeURIComponent(lessonId)}/thumb`, { method: 'DELETE' });
          refresh();
        } catch (err) {
          alert(`Remove failed: ${err.message}`);
        }
      },
    }, 'Remove thumb');

    return el('div', { class: 'tut-form-row' }, [
      el('label', null, 'Thumbnail (PNG/JPEG/WebP, up to 4 MB)'),
      el('div', { style: 'display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap' }, [
        previewWrap, fileInput, clearBtn,
      ]),
    ]);
  }

  function authorWelcome() {
    return el('div', { class: 'tut-empty' }, [
      el('h2', { style: 'margin:0 0 0.5rem;color:var(--tut-text);font-size:1.2rem' },
        'Build a tutorial pack'),
      el('p', { style: 'margin:0 0 0.75rem' },
        'A pack bundles short intro videos with exercise sloppaks. Each lesson awards XP through the minigames profile when you pass it.'),
      el('p', { style: 'margin:0 0 0.5rem' }, 'To get started:'),
      el('ol', { style: 'margin:0 0 0.75rem 1.25rem;padding:0;text-align:left;display:inline-block' }, [
        el('li', null, 'Click + New pack on the left to create a pack.'),
        el('li', null, 'Add lessons — paste a YouTube URL or upload a webm/mp4 for the intro.'),
        el('li', null, 'Pick an exercise sloppak from your library and copy it into the pack.'),
        el('li', null, 'Set pass / mastery thresholds and XP rewards.'),
        el('li', null, 'Save, then switch to Browse to play it.'),
      ]),
      el('p', { style: 'margin:0;font-size:0.85rem' },
        'Or pick an existing pack on the left to edit it.'),
    ]);
  }

  function formRow(label, child) {
    return el('div', { class: 'tut-form-row' }, [el('label', null, label), child]);
  }
  function twoCol(a, b) {
    return el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0.75rem' }, [a, b]);
  }

  function tagInput(id, initial) {
    const host = el('div', { class: 'tut-tag-input', dataset: { tagInput: id } });
    function addChip(value) {
      const chip = el('span', { class: 'tut-tag-chip', dataset: { value } }, [
        value,
        el('button', { type: 'button', onclick: () => chip.remove() }, '×'),
      ]);
      host.insertBefore(chip, input);
    }
    const input = el('input', {
      type: 'text', placeholder: '+ tag', style: 'flex:1;min-width:120px',
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ',') return;
        e.preventDefault();
        const v = input.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (v) addChip(v);
        input.value = '';
      },
    });
    // Append input FIRST so insertBefore(chip, input) has a valid sibling.
    host.appendChild(input);
    (initial || []).forEach(addChip);
    return host;
  }
  function readTagInput(id) {
    const host = document.querySelector(`[data-tag-input="${id}"]`);
    if (!host) return [];
    return Array.from(host.querySelectorAll('.tut-tag-chip')).map((c) => c.dataset.value);
  }

  // ── Public surface ────────────────────────────────────────────────────

  // Hot-reload guard — placed here (after all declarations) so that init()
  // is never invoked before `const state` and friends are initialized.
  // The plugin loader removes and re-appends screen.html on each
  // loadPlugins() pass; when the IIFE re-runs, module-level state and the
  // global event subscription already exist — just re-hydrate the DOM.
  if (window.slopsmithTutorials && window.slopsmithTutorials.__alive) {
    // Update the public refresh handle so it points to this invocation's
    // refreshAndRender closure, then re-run init to rebind mode buttons
    // and the tutorials-root to the freshly-inserted DOM nodes.
    window.slopsmithTutorials.refresh = refreshAndRender;
    init();
    return;
  }

  window.slopsmithTutorials = {
    __alive: true,
    refresh: refreshAndRender,
  };

  // Hydration timing: the host plugin loader removes and re-appends the
  // plugin's screen.html on each loadPlugins() pass, so DOMContentLoaded
  // may already have fired by the time this script runs. Init both on
  // load and immediately if the container is present.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
