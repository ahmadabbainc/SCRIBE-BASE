/* Audio Transcriber Studio - engine
   Pure logic only (no DOM), so it can be tested outside the app. */
(function (root) {
  'use strict';

  const NO_SPACE = new Set(['zh', 'ja', 'th', 'lo', 'my', 'km', 'yue']);
  const EN_FILLERS = new Set(['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'hm', 'mm', 'mmm', 'mhm']);
  const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'inc', 'ltd', 'mt', 'gen', 'col', 'sgt', 'lt', 'fig']);
  const END = new Set([...'.!?؟。！？…']);
  const CLOSERS = new Set([...'"\'”’)]}»」』']);
  const CLAUSE = new Set([...',;:，、；：']);

  const SUFFIX = {
    'TXT': '_Text.txt',
    'Sentence SRT': '_Sentence.srt',
    'Subtitle SRT': '_Subtitles.srt',
    'Word-by-Word SRT': '_Word_by_Word.srt',
    'VTT': '_Subtitles.vtt'
  };
  const FORMATS = Object.keys(SUFFIX);

  const LANG_NAMES = {
    english: 'en', chinese: 'zh', japanese: 'ja', thai: 'th', lao: 'lo',
    burmese: 'my', khmer: 'km', cantonese: 'yue'
  };

  // ---------------------------------------------------------- helpers
  function langCode(x) {
    if (!x) return '';
    x = String(x).toLowerCase();
    if (x.length <= 3) return x;
    return LANG_NAMES[x] || '';
  }

  function stamp(seconds, sep) {
    sep = sep || ',';
    let ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const p = (n, l) => String(n).padStart(l, '0');
    return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + sep + p(ms, 3);
  }

  function clock(seconds) {
    seconds = Math.floor(seconds || 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
             : m + ':' + String(s).padStart(2, '0');
  }

  function norm(t) {
    return String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function rstripSet(s, set) {
    let i = s.length;
    while (i > 0 && set.has(s[i - 1])) i--;
    return s.slice(0, i);
  }

  function endsSentence(token) {
    const t = rstripSet(token, CLOSERS);
    if (!t || !END.has(t[t.length - 1])) return false;

    // A single period may be an abbreviation or an initial, not a sentence end
    if (t.endsWith('.') && !t.endsWith('..')) {
      const base = t.slice(0, -1);
      const low = base.toLowerCase();
      if (ABBR.has(low)) return false;
      if (low !== 'i' && /^(?:[A-Za-z]\.)*[A-Za-z]$/.test(base)) return false;
    }
    return true;
  }

  // ------------------------------------------------------- polishing
  // Marks each word with drop = true/false. Original timings are untouched.
  function flagWords(words, lang, o) {
    const stats = { fillers: 0, repeats: 0 };
    const filler = new Set(o.fillers && lang === 'en' ? EN_FILLERS : []);
    (o.extra || new Set()).forEach(x => filler.add(x));

    words.forEach(w => { w.drop = false; });

    if (filler.size) {
      words.forEach(w => {
        if (filler.has(norm(w.text))) { w.drop = true; stats.fillers++; }
      });
    }

    if (o.repeats && !NO_SPACE.has(lang)) {
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.drop) continue;

        let j = i + 1;
        while (j < words.length && words[j].drop) j++;
        if (j >= words.length) continue;

        const n = norm(w.text);
        const nn = norm(words[j].text);
        if (!n || !nn) continue;

        // "I I want" / "the the" (short words only, so "very very" survives)
        const sameShort = n === nn && n.length <= 3 && /^\p{L}+$/u.test(n) && !endsSentence(w.text);

        // "wh- what": a word cut off with a hyphen, then restarted
        const cutOff = w.text.endsWith('-') && nn[0] === n[0];

        if (sameShort || cutOff) { w.drop = true; stats.repeats++; }
      }
    }
    return stats;
  }

  // Builds the clean list. Fixes capitalization when a dropped word opened a
  // sentence, and keeps sentence-ending punctuation that sat on a dropped word.
  function finalizeWords(words) {
    const kept = [];
    let atStart = true;
    let pendingCap = false;

    for (const w of words) {
      if (w.drop) {
        if (atStart) pendingCap = true;
        const tail = rstripSet(w.text, CLOSERS);
        if (kept.length && tail && END.has(tail[tail.length - 1]) &&
            !endsSentence(kept[kept.length - 1].text)) {
          const prev = kept[kept.length - 1];
          let p = prev.text;
          while (p && CLAUSE.has(p[p.length - 1])) p = p.slice(0, -1);
          prev.text = p + tail[tail.length - 1];
          atStart = true;
          pendingCap = true;
        }
        continue;
      }

      let t = w.text;
      if (pendingCap && t && /\p{Ll}/u.test(t[0])) {
        t = t[0].toUpperCase() + t.slice(1);
      }
      pendingCap = false;
      kept.push({ start: w.start, end: w.end, text: t });
      atStart = endsSentence(t);
    }
    return kept;
  }

  // ----------------------------------------------------- pause trimming
  // Returns the stretches of the original audio to keep (in seconds).
  // Dropped words are always cut; pauses longer than `keep` shrink to `keep`.
  function planTrim(words, keep, total, sr) {
    const half = keep / 2;

    const padBefore = i => {
      const prevEnd = i > 0 ? words[i - 1].end : 0;
      return Math.max(0, Math.min(half, words[i].start - prevEnd));
    };
    const padAfter = i => {
      const limit = i + 1 < words.length ? words[i + 1].start : total;
      return Math.max(0, Math.min(half, limit - words[i].end));
    };

    const spans = [];
    let curS = 0, curE = 0, lastI = -1;

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.drop) continue;

      const continues = lastI >= 0 && i === lastI + 1 && (w.start - words[lastI].end) <= keep;
      if (continues) { curE = w.end; lastI = i; continue; }

      if (lastI >= 0) spans.push([curS, curE + padAfter(lastI)]);
      curS = w.start - padBefore(i);
      curE = w.end;
      lastI = i;
    }
    if (lastI >= 0) spans.push([curS, curE + padAfter(lastI)]);

    // Safety: no negative starts, no overlaps, no empty stretches.
    // Snap to the sample grid so audio and subtitle timing stay exact.
    const clean = [];
    let prevEnd = 0;
    for (let [s, e] of spans) {
      s = Math.max(s, prevEnd);
      e = Math.min(e, total);
      if (e - s > 0.02) {
        const rs = Math.round(s * sr) / sr;
        const re = Math.round(e * sr) / sr;
        if (re > rs) { clean.push([rs, re]); prevEnd = re; }
      }
    }
    return clean;
  }

  // Maps a time in the original audio to the same moment in the trimmed audio.
  function makeRemap(spans) {
    const offsets = [];
    let acc = 0;
    spans.forEach(([s, e]) => { offsets.push(acc); acc += e - s; });

    const remap = t => {
      let lo = 0, hi = spans.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid][0] <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (idx < 0) return 0;
      const [s, e] = spans[idx];
      return offsets[idx] + Math.min(Math.max(t - s, 0), e - s);
    };
    remap.total = acc;
    return remap;
  }

  // Cuts the kept stretches out of the audio and returns a 16-bit mono WAV.
  function renderTrimmedWav(pcm, sr, spans) {
    const idx = spans.map(([s, e]) => {
      const a = Math.round(s * sr);
      const b = Math.min(pcm.length, Math.round(e * sr));
      return [a, Math.max(a, b)];
    });
    let n = 0;
    idx.forEach(([a, b]) => { n += b - a; });

    const buf = new ArrayBuffer(44 + n * 2);
    writeWavHeader(new DataView(buf), n, sr);
    const v = new DataView(buf);

    let o = 44;
    for (const [a, b] of idx) {
      const len = b - a;
      const f = Math.min(Math.floor(sr * 0.01), Math.floor(len / 4));
      for (let i = 0; i < len; i++) {
        let x = pcm[a + i];
        if (i < f) x *= i / f;
        else if (i >= len - f) x *= (len - 1 - i) / f;
        x = Math.max(-1, Math.min(1, x));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
        o += 2;
      }
    }
    return buf;
  }

  // ------------------------------------------------------ cue building
  // mode "sentence": one cue per real sentence.
  // mode "subtitle": short, readable cues (length, duration, pauses).
  function buildCues(words, mode, joiner, maxChars, maxDur) {
    maxChars = maxChars || 42;
    maxDur = maxDur || 6;
    const cues = [];
    let cur = [];

    const textOf = items => items.map(x => x.text).join(joiner).trim();
    const flush = () => {
      if (cur.length) {
        cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: textOf(cur) });
        cur = [];
      }
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];

      if (mode === 'subtitle' && cur.length) {
        const tooLong = textOf(cur.concat([w])).length > maxChars;
        const tooSlow = (w.end - cur[0].start) > maxDur;
        if (tooLong || tooSlow) flush();
      }

      cur.push(w);

      if (endsSentence(w.text)) { flush(); continue; }

      if (mode === 'subtitle') {
        const nxt = i + 1 < words.length ? words[i + 1] : null;
        if (nxt && (nxt.start - w.end) >= 0.8) { flush(); continue; }
        if (CLAUSE.has(w.text[w.text.length - 1]) && textOf(cur).length >= maxChars * 0.6) flush();
      }
    }
    flush();
    return cues;
  }

  // Guarantees positive durations and no overlapping cues.
  function tidy(cues, minDur) {
    minDur = minDur || 0;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (c.end <= c.start) c.end = c.start + 0.1;
      if (c.end - c.start < minDur) c.end = c.start + minDur;
      if (i + 1 < cues.length) {
        const nxt = cues[i + 1].start;
        if (c.start < nxt && nxt < c.end) c.end = nxt;
      }
    }
    return cues;
  }

  function toSrt(cues) {
    return cues.map((c, i) =>
      (i + 1) + '\n' + stamp(c.start) + ' --> ' + stamp(c.end) + '\n' + c.text + '\n').join('\n');
  }

  function toVtt(cues) {
    return 'WEBVTT\n\n' + cues.map(c =>
      stamp(c.start, '.') + ' --> ' + stamp(c.end, '.') + '\n' + c.text + '\n').join('\n');
  }

  // Builds every requested text format from the clean word list.
  function buildTexts(kept, formats, lang, maxChars, maxDur) {
    const joiner = NO_SPACE.has(lang) ? '' : ' ';
    const texts = {};
    let sub = null;

    if (formats.includes('TXT')) texts['TXT'] = kept.map(w => w.text).join(joiner).trim();
    if (formats.includes('Sentence SRT')) {
      texts['Sentence SRT'] = toSrt(tidy(buildCues(kept, 'sentence', joiner), 0.4));
    }
    if (formats.includes('Subtitle SRT') || formats.includes('VTT')) {
      sub = tidy(buildCues(kept, 'subtitle', joiner, maxChars, maxDur), 0.4);
      if (formats.includes('Subtitle SRT')) texts['Subtitle SRT'] = toSrt(sub);
      if (formats.includes('VTT')) texts['VTT'] = toVtt(sub);
    }
    if (formats.includes('Word-by-Word SRT')) {
      texts['Word-by-Word SRT'] = toSrt(tidy(kept.map(w => ({ start: w.start, end: w.end, text: w.text }))));
    }
    return texts;
  }

  // -------------------------------------------------------- audio helpers
  function writeWavHeader(v, samples, sr) {
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples * 2, true);
  }

  function encodeWav(samples, sr) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    writeWavHeader(v, samples.length, sr);
    let o = 44;
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
      o += 2;
    }
    return buf;
  }

  // Resamples a stretch of mono audio to 16 kHz (small uploads, ideal for Whisper).
  function resampleTo16k(pcm, sr, start, end) {
    const s0 = Math.floor(start * sr);
    const s1 = Math.min(pcm.length, Math.floor(end * sr));
    const ratio = sr / 16000;
    const n = Math.max(0, Math.floor((s1 - s0) / ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = s0 + i * ratio;
      const i0 = Math.floor(p);
      const f = p - i0;
      const a = pcm[i0];
      const b = pcm[Math.min(i0 + 1, s1 - 1)];
      out[i] = a + (b - a) * f;
    }
    return out;
  }

  function rmsRange(pcm, sr, start, end) {
    const a = Math.max(0, Math.floor(start * sr));
    const b = Math.min(pcm.length, Math.ceil(end * sr));
    if (b <= a) return 0;
    let e = 0;
    for (let i = a; i < b; i++) e += pcm[i] * pcm[i];
    return Math.sqrt(e / (b - a));
  }

  function quietestPoint(pcm, sr, a, b) {
    const win = Math.floor(sr * 0.1);
    const lo = Math.max(0, Math.floor(a * sr));
    const hi = Math.min(pcm.length, Math.floor(b * sr));
    let best = (a + b) / 2, bestE = Infinity;
    for (let s = lo; s + win <= hi; s += win) {
      let e = 0;
      for (let i = s; i < s + win; i++) e += pcm[i] * pcm[i];
      if (e < bestE) { bestE = e; best = (s + win / 2) / sr; }
    }
    return best;
  }

  // Splits long audio into chunks under the API size limit, cutting at quiet points.
  function planChunks(pcm, sr, targetSec) {
    targetSec = targetSec || 540;
    const total = pcm.length / sr;
    if (total <= targetSec + 60) return [[0, total]];

    const cuts = [0];
    while (total - cuts[cuts.length - 1] > targetSec + 60) {
      const base = cuts[cuts.length - 1] + targetSec;
      cuts.push(quietestPoint(pcm, sr, base - 20, base + 20));
    }
    cuts.push(total);

    const chunks = [];
    for (let i = 0; i < cuts.length - 1; i++) chunks.push([cuts[i], cuts[i + 1]]);
    return chunks;
  }

  const api = {
    NO_SPACE, FORMATS, SUFFIX,
    langCode, stamp, clock, norm, endsSentence,
    flagWords, finalizeWords, planTrim, makeRemap, renderTrimmedWav,
    buildCues, tidy, toSrt, toVtt, buildTexts,
    encodeWav, resampleTo16k, rmsRange, planChunks
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
