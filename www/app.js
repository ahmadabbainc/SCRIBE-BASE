/* Audio Transcriber Studio - app */
(function () {
  'use strict';

  const E = window.Engine;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ------------------------------------------------------------ config
  const PROVIDERS = {
    groq: {
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      models: [
        ['whisper-large-v3-turbo', 'large-v3-turbo (fastest)'],
        ['whisper-large-v3', 'large-v3 (most accurate)']
      ],
      hint: 'Starts with gsk_'
    },
    openai: {
      name: 'OpenAI',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      models: [['whisper-1', 'whisper-1']],
      hint: 'Starts with sk-'
    }
  };

  const LANGUAGES = [
    ['auto', 'Auto-detect'], ['en', 'English'], ['ar', 'Arabic'], ['es', 'Spanish'],
    ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'],
    ['nl', 'Dutch'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
    ['pl', 'Polish'], ['hi', 'Hindi'], ['ur', 'Urdu'], ['bn', 'Bengali'],
    ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['zh', 'Chinese'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['fa', 'Persian'], ['he', 'Hebrew']
  ];

  const PERSIST = ['provider', 'key', 'model', 'language', 'prompt', 'chars', 'dur',
                   'trim', 'keep', 'fillers', 'repeats', 'silence', 'extra'];

  // ------------------------------------------------------------- state
  let files = [];
  let cancelled = false;
  let abortCtl = null;
  let results = null;
  let previewFormat = '';

  // ----------------------------------------------------------- storage
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('ats.' + k); return v === null ? d : v; }
      catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem('ats.' + k, v); } catch (e) { /* ignore */ } }
  };

  // ---------------------------------------------------------------- UI
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }

  function setProgress(frac, text) {
    $('barFill').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    $('progressText').textContent = text || '';
  }

  function fmtSize(n) {
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fillSelect(sel, pairs) {
    sel.innerHTML = '';
    pairs.forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    });
  }

  function fillModels() {
    const p = PROVIDERS[$('provider').value] || PROVIDERS.groq;
    fillSelect($('model'), p.models);
    $('key').placeholder = p.hint;
  }

  function renderFiles() {
    const ul = $('fileList');
    ul.innerHTML = '';
    files.forEach(f => {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.textContent = f.name;
      const b = document.createElement('span'); b.textContent = fmtSize(f.size);
      li.append(a, b);
      ul.appendChild(li);
    });
    $('clearFiles').hidden = files.length === 0;
  }

  function selectedFormats() {
    return Array.from(document.querySelectorAll('#formats input:checked')).map(i => i.value);
  }

  function loadSettings() {
    PERSIST.forEach(id => {
      const el = $(id);
      const v = store.get(id, null);
      if (v === null) return;
      if (el.type === 'checkbox') el.checked = v === '1';
      else if (el.tagName === 'SELECT') {
        if (Array.from(el.options).some(o => o.value === v)) el.value = v;
      } else el.value = v;
    });
    try {
      const saved = JSON.parse(store.get('formats', 'null'));
      if (Array.isArray(saved)) {
        document.querySelectorAll('#formats input').forEach(i => { i.checked = saved.includes(i.value); });
      }
    } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    PERSIST.forEach(id => {
      const el = $(id);
      store.set(id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    });
    store.set('formats', JSON.stringify(selectedFormats()));
  }

  function updateReadouts() {
    $('keepVal').textContent = Number($('keep').value).toFixed(2) + ' s';
    $('charsVal').textContent = $('chars').value;
    $('durVal').textContent = $('dur').value + ' s';
  }

  function init() {
    fillSelect($('provider'), Object.keys(PROVIDERS).map(k => [k, PROVIDERS[k].name]));
    fillSelect($('language'), LANGUAGES);

    const box = $('formats');
    E.FORMATS.forEach(f => {
      const l = document.createElement('label');
      l.className = 'chip';
      const i = document.createElement('input');
      i.type = 'checkbox'; i.value = f;
      i.checked = f === 'TXT' || f === 'Sentence SRT';
      const s = document.createElement('span'); s.textContent = f;
      l.append(i, s);
      box.appendChild(l);
    });

    $('provider').value = store.get('provider', 'groq');
    fillModels();
    loadSettings();
    updateReadouts();

    // First run: open Settings so the key is easy to find.
    if (!$('key').value) $('settings').open = true;

    $('provider').addEventListener('change', () => { fillModels(); saveSettings(); });
    document.querySelectorAll('#settings input, #settings select, #settings textarea, .card input')
      .forEach(el => el.addEventListener('change', saveSettings));
    ['keep', 'chars', 'dur'].forEach(id => $(id).addEventListener('input', updateReadouts));

    $('showKey').addEventListener('click', () => {
      const k = $('key');
      const show = k.type === 'password';
      k.type = show ? 'text' : 'password';
      $('showKey').textContent = show ? 'Hide' : 'Show';
    });

    $('file').addEventListener('change', e => {
      files = Array.from(e.target.files || []);
      renderFiles();
    });
    $('clearFiles').addEventListener('click', () => {
      files = []; $('file').value = ''; renderFiles();
    });

    $('go').addEventListener('click', run);
    $('stop').addEventListener('click', () => {
      cancelled = true;
      if (abortCtl) abortCtl.abort();
      toast('Stopping…');
    });

    $('copy').addEventListener('click', copyPreview);
    $('shareAll').addEventListener('click', () => results && shareFiles(results.files));
  }

  // ------------------------------------------------------------- audio
  async function decodeFile(file) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This device cannot decode audio.');

    const data = await file.arrayBuffer();
    const ctx = new AC({ sampleRate: 24000 });
    let audio;
    try {
      audio = await ctx.decodeAudioData(data);
    } catch (e) {
      throw new Error('"' + file.name + '" could not be read. Try an MP3, M4A, WAV or MP4 file.');
    } finally {
      if (ctx.close) ctx.close().catch(() => {});
    }

    const n = audio.length;
    const ch = audio.numberOfChannels;
    const pcm = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < n; i++) pcm[i] += d[i];
    }
    if (ch > 1) for (let i = 0; i < n; i++) pcm[i] /= ch;

    return { pcm, sr: audio.sampleRate };
  }

  // --------------------------------------------------------------- API
  async function transcribeChunk(blob, cfg) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (cancelled) throw new Error('Stopped');

      const fd = new FormData();
      fd.append('file', blob, 'chunk.wav');
      fd.append('model', cfg.model);
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('temperature', '0');
      if (cfg.language !== 'auto') fd.append('language', cfg.language);
      if (cfg.prompt) fd.append('prompt', cfg.prompt);

      let res;
      try {
        res = await fetch(cfg.url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.key },
          body: fd,
          signal: abortCtl ? abortCtl.signal : undefined
        });
      } catch (e) {
        if (cancelled) throw new Error('Stopped');
        if (attempt === 3) throw new Error('Could not reach ' + cfg.name + '. Check your internet connection and try again.');
        await sleep(1500 * (attempt + 1));
        continue;
      }

      if (res.ok) return res.json();

      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = parseFloat(res.headers.get('retry-after'));
        await sleep((isFinite(ra) ? Math.min(ra, 60) : 3 * (attempt + 1)) * 1000);
        continue;
      }

      let msg = '';
      try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* ignore */ }
      if (res.status === 401) throw new Error('The API key was rejected. Check it in Settings.');
      if (res.status === 413) throw new Error('The audio chunk was too large for ' + cfg.name + '.');
      throw new Error(cfg.name + ' error ' + res.status + (msg ? ': ' + msg : ''));
    }
    throw new Error('The request failed after several tries.');
  }

  function wordsFromResponse(data, offset) {
    let list = (data.words || []).map(w => ({
      start: Number(w.start) + offset, end: Number(w.end) + offset, text: String(w.word).trim()
    }));
    let usedSegments = false;

    if (!list.length && data.segments && data.segments.length) {
      list = data.segments.map(s => ({
        start: Number(s.start) + offset, end: Number(s.end) + offset, text: String(s.text).trim()
      }));
      usedSegments = true;
    }
    list = list.filter(w => w.text && isFinite(w.start) && isFinite(w.end));
    return { list, usedSegments };
  }

  // ---------------------------------------------------------- pipeline
  async function processFile(file, idx, total, cfg, opts, notes) {
    const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}\-_. ]+/gu, '_').trim() || ('audio_' + (idx + 1));
    const span = 1 / total;
    const at = f => (idx + f) * span;
    const started = Date.now();

    setProgress(at(0), 'Reading ' + file.name + '…');
    await sleep(30);
    const { pcm, sr } = await decodeFile(file);
    const duration = pcm.length / sr;

    // ---- Transcribe in chunks
    const chunks = E.planChunks(pcm, sr, 540);
    let words = [];
    let detected = '';
    let usedSegments = false;

    for (let ci = 0; ci < chunks.length; ci++) {
      if (cancelled) throw new Error('Stopped');
      const [a, b] = chunks[ci];

      setProgress(at(0.08 + 0.77 * (ci / chunks.length)),
        'Transcribing ' + file.name + (chunks.length > 1 ? ' (part ' + (ci + 1) + ' of ' + chunks.length + ')' : '') + '…');

      if (E.rmsRange(pcm, sr, a, b) < 0.0008) continue; // silent chunk

      const wav = new Blob([E.encodeWav(E.resampleTo16k(pcm, sr, a, b), 16000)], { type: 'audio/wav' });
      const data = await transcribeChunk(wav, cfg);

      if (!detected && data.language) detected = data.language;
      const r = wordsFromResponse(data, a);
      if (r.usedSegments) usedSegments = true;
      words = words.concat(r.list);
    }

    if (!words.length) {
      notes.push({ text: file.name + ': no speech detected.', warn: true });
      return null;
    }

    // ---- Remove words the AI heard in silence
    if (opts.silence) {
      words = words.filter(w => E.rmsRange(pcm, sr, w.start, w.end) >= 0.0025);
      if (!words.length) {
        notes.push({ text: file.name + ': only silence was found.', warn: true });
        return null;
      }
    }

    // ---- Polish
    setProgress(at(0.88), 'Polishing ' + file.name + '…');
    await sleep(30);

    const lang = cfg.language !== 'auto' ? cfg.language : E.langCode(detected);
    const stats = E.flagWords(words, lang, { fillers: opts.fillers, repeats: opts.repeats, extra: opts.extra });
    const kept = E.finalizeWords(words);

    if (!kept.length) {
      notes.push({ text: file.name + ': nothing left after cleaning.', warn: true });
      return null;
    }

    const outFiles = [];
    let trimNote = '';

    if (opts.trim) {
      try {
        const spans = E.planTrim(words, opts.keep, duration, sr);
        if (!spans.length) {
          trimNote = 'Nothing to trim.';
        } else {
          setProgress(at(0.93), 'Trimming ' + file.name + '…');
          await sleep(30);
          const wavBuf = E.renderTrimmedWav(pcm, sr, spans);
          const remap = E.makeRemap(spans);
          kept.forEach(w => { w.start = remap(w.start); w.end = remap(w.end); });
          outFiles.push({ name: base + '_Trimmed.wav', blob: new Blob([wavBuf], { type: 'audio/wav' }) });
          trimNote = 'audio ' + E.clock(duration) + ' to ' + E.clock(remap.total);
        }
      } catch (e) {
        notes.push({ text: file.name + ': audio trimming failed (' + e.message + '). Subtitles use the original timing.', warn: true });
      }
    }

    // ---- Build text outputs
    const texts = E.buildTexts(kept, opts.formats, lang, opts.chars, opts.dur);
    const textFiles = opts.formats.map(f => ({
      name: base + E.SUFFIX[f],
      blob: new Blob([texts[f]], { type: 'text/plain;charset=utf-8' })
    }));

    const took = Math.max(1, Math.round((Date.now() - started) / 1000));
    let line = file.name + ': ' + E.clock(duration) + ' of audio, ' + kept.length + ' words, ' + took + 's';
    const removed = stats.fillers + stats.repeats;
    if (removed) line += ', removed ' + stats.fillers + ' fillers and ' + stats.repeats + ' repeats';
    if (trimNote) line += ', ' + trimNote;
    notes.push({ text: line, warn: false });
    if (usedSegments) {
      notes.push({ text: file.name + ': word timing was not available, so phrases were used instead. Filler removal may be less precise.', warn: true });
    }

    return { texts, files: textFiles.concat(outFiles) };
  }

  async function run() {
    const cfg = {
      provider: $('provider').value,
      key: $('key').value.trim(),
      model: $('model').value,
      language: $('language').value,
      prompt: $('prompt').value.trim()
    };
    const P = PROVIDERS[cfg.provider];
    cfg.url = P.url;
    cfg.name = P.name;

    const opts = {
      formats: E.FORMATS.filter(f => selectedFormats().includes(f)),
      trim: $('trim').checked,
      keep: Number($('keep').value),
      fillers: $('fillers').checked,
      repeats: $('repeats').checked,
      silence: $('silence').checked,
      chars: Number($('chars').value),
      dur: Number($('dur').value),
      extra: new Set($('extra').value.split(/[,\n]/).map(E.norm).filter(Boolean))
    };

    if (!files.length) return toast('Choose at least one audio or video file.');
    if (!opts.formats.length) return toast('Pick at least one output format.');
    if (!cfg.key) {
      $('settings').open = true;
      $('key').focus();
      return toast('Paste your ' + P.name + ' API key in Settings first.');
    }

    saveSettings();
    cancelled = false;
    abortCtl = new AbortController();
    results = null;

    $('go').disabled = true;
    $('stop').hidden = false;
    $('results').hidden = true;
    $('progressCard').hidden = false;
    $('progressCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

    const notes = [];
    const all = { texts: null, files: [] };
    let failure = '';

    try {
      for (let i = 0; i < files.length; i++) {
        if (cancelled) break;
        const r = await processFile(files[i], i, files.length, cfg, opts, notes);
        if (r) {
          if (!all.texts) all.texts = r.texts;
          all.files = all.files.concat(r.files);
        }
      }
    } catch (e) {
      if (!cancelled && e.message !== 'Stopped') failure = e.message || String(e);
    } finally {
      $('go').disabled = false;
      $('stop').hidden = true;
      abortCtl = null;
    }

    $('progressCard').hidden = true;

    if (failure) notes.push({ text: failure, warn: true });
    if (cancelled) notes.push({ text: 'Stopped before finishing.', warn: true });

    if (all.files.length) {
      results = all;
      renderResults(notes);
    } else {
      const msg = failure || (cancelled ? 'Stopped.' : 'Nothing to show.');
      toast(msg, 6000);
      if (notes.length) { renderNotesOnly(notes); }
    }
  }

  // ----------------------------------------------------------- results
  function renderNotes(notes) {
    const ul = $('notes');
    ul.innerHTML = '';
    notes.forEach(n => {
      const li = document.createElement('li');
      li.textContent = (n.warn ? '⚠ ' : '✓ ') + n.text;
      if (n.warn) li.className = 'warn';
      ul.appendChild(li);
    });
  }

  function renderNotesOnly(notes) {
    renderNotes(notes);
    $('tabs').innerHTML = '';
    $('preview').value = '';
    $('outFiles').innerHTML = '';
    $('results').hidden = false;
  }

  function renderResults(notes) {
    renderNotes(notes);

    const tabs = $('tabs');
    tabs.innerHTML = '';
    const formats = results.texts ? Object.keys(results.texts) : [];
    formats.forEach(f => {
      const b = document.createElement('button');
      b.className = 'tab'; b.textContent = f; b.type = 'button';
      b.addEventListener('click', () => showPreview(f));
      tabs.appendChild(b);
    });
    if (formats.length) showPreview(formats[0]); else $('preview').value = '';

    const box = $('outFiles');
    box.innerHTML = '';
    results.files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'out';
      const left = document.createElement('div');
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = f.name;
      const sz = document.createElement('div'); sz.className = 'sz'; sz.textContent = fmtSize(f.blob.size);
      left.append(nm, sz);
      const btn = document.createElement('button');
      btn.className = 'btn'; btn.type = 'button'; btn.textContent = 'Share';
      btn.addEventListener('click', () => shareFiles([f]));
      row.append(left, btn);
      box.appendChild(row);
    });

    $('results').hidden = false;
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showPreview(f) {
    previewFormat = f;
    $('preview').value = results.texts[f] || '';
    document.querySelectorAll('#tabs .tab').forEach(b => {
      b.setAttribute('aria-pressed', b.textContent === f ? 'true' : 'false');
    });
  }

  async function copyPreview() {
    const text = $('preview').value;
    if (!text) return toast('Nothing to copy yet.');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = $('preview');
      ta.removeAttribute('readonly'); ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.setAttribute('readonly', ''); 
    }
    toast('Copied ' + previewFormat + '.');
  }

  // ----------------------------------------------------- save and share
  const isNative = () => !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error || new Error('Could not read the file.'));
      r.readAsDataURL(blob);
    });
  }

  // Writes a file to the app cache in 3 MB pieces (keeps memory low) and returns its URI.
  async function writeToCache(file) {
    const FS = Capacitor.Plugins.Filesystem;
    const path = 'transcripts/' + file.name;
    const STEP = 3 * 1024 * 1024; // multiple of 3, so base64 pieces join cleanly

    try { await FS.deleteFile({ path, directory: 'CACHE' }); } catch (e) { /* not there yet */ }

    for (let o = 0; o < file.blob.size; o += STEP) {
      const data = await blobToBase64(file.blob.slice(o, o + STEP));
      if (o === 0) await FS.writeFile({ path, data, directory: 'CACHE', recursive: true });
      else await FS.appendFile({ path, data, directory: 'CACHE' });
    }
    const res = await FS.getUri({ path, directory: 'CACHE' });
    return res.uri;
  }

  function webDownload(file) {
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  async function shareFiles(list) {
    if (!list || !list.length) return;

    if (!isNative()) {
      list.forEach(webDownload);
      return;
    }

    try {
      toast('Preparing…', 8000);
      const uris = [];
      for (const f of list) uris.push(await writeToCache(f));
      $('toast').hidden = true;
      await Capacitor.Plugins.Share.share({
        title: 'Transcript files',
        files: uris,
        dialogTitle: 'Save or share'
      });
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/cancel/i.test(m)) return;
      toast('Could not share: ' + m, 6000);
    }
  }

  init();
})();
