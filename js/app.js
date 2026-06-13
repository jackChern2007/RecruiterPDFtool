/*
 * app.js
 * ------
 * UI glue: drag & drop, file reading, progress, the preview table, the
 * per-candidate detail dialog, and the Excel download button.
 */
(function () {
  'use strict';

  var candidates = []; // parsed results
  var nextOrder = 0;   // assigns a stable upload/import order to each candidate
  var keywords = [];   // current keyword search terms
  var keywordTimer = null;

  var els = {};

  document.addEventListener('DOMContentLoaded', function () {
    els = {
      dropzone: document.getElementById('dropzone'),
      fileInput: document.getElementById('fileInput'),
      browseBtn: document.getElementById('browseBtn'),
      importBtn: document.getElementById('importBtn'),
      importInput: document.getElementById('importInput'),
      keywordInput: document.getElementById('keywordInput'),
      results: document.getElementById('results'),
      resultsTable: document.getElementById('resultsTable'),
      resultsBody: document.getElementById('resultsBody'),
      resultsCount: document.getElementById('resultsCount'),
      downloadBtn: document.getElementById('downloadBtn'),
      clearBtn: document.getElementById('clearBtn'),
      emptyHelp: document.getElementById('emptyHelp'),
      detailDialog: document.getElementById('detailDialog'),
      detailContent: document.getElementById('detailContent'),
      dialogClose: document.getElementById('dialogClose'),
      toast: document.getElementById('toast'),
      repoLink: document.getElementById('repoLink')
    };

    configurePdfWorker();
    wireRepoLink();
    wireEvents();
  });

  function configurePdfWorker() {
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }

  // Point the footer "Source on GitHub" link at the repo this page is served
  // from (works automatically on <user>.github.io/<repo>).
  function wireRepoLink() {
    try {
      var host = location.hostname; // e.g. jackchern2007.github.io
      var parts = location.pathname.split('/').filter(Boolean);
      if (host.endsWith('github.io') && parts.length) {
        var user = host.split('.')[0];
        els.repoLink.href = 'https://github.com/' + user + '/' + parts[0];
      } else {
        els.repoLink.href = 'https://github.com/';
      }
    } catch (e) { /* no-op */ }
  }

  function wireEvents() {
    els.browseBtn.addEventListener('click', function () { els.fileInput.click(); });
    els.importBtn.addEventListener('click', function () { els.importInput.click(); });
    els.dropzone.addEventListener('click', function (e) {
      if (e.target === els.browseBtn || e.target === els.importBtn) return;
      els.fileInput.click();
    });
    els.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
    });
    els.fileInput.addEventListener('change', function () {
      handleFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

    els.importInput.addEventListener('change', function () {
      if (els.importInput.files && els.importInput.files[0]) {
        importExcel(els.importInput.files[0]);
      }
      els.importInput.value = '';
    });

    els.keywordInput.addEventListener('input', function () {
      clearTimeout(keywordTimer);
      keywordTimer = setTimeout(function () {
        keywords = parseKeywords(els.keywordInput.value);
        render();
      }, 200);
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      els.dropzone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      els.dropzone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropzone.classList.remove('dragover');
      });
    });
    els.dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    els.downloadBtn.addEventListener('click', onDownload);
    els.clearBtn.addEventListener('click', onClear);
    els.dialogClose.addEventListener('click', function () { els.detailDialog.close(); });
    els.detailDialog.addEventListener('click', function (e) {
      if (e.target === els.detailDialog) els.detailDialog.close();
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    });
    if (!files.length) {
      toast('Please choose PDF files exported from LinkedIn Recruiter.');
      return;
    }
    var queue = files.slice();
    var processed = 0;
    var total = queue.length;

    setBusy(true, 'Parsing 0/' + total + '…');

    function next() {
      if (!queue.length) {
        setBusy(false);
        render();
        toast('Parsed ' + total + ' file' + (total === 1 ? '' : 's') + '.');
        return;
      }
      var file = queue.shift();
      setBusy(true, 'Parsing ' + (processed + 1) + '/' + total + ' — ' + file.name);
      parseFile(file).then(function (candidate) {
        addCandidate(candidate);
      }).catch(function (err) {
        addCandidate({
          sourceFile: file.name,
          name: '',
          topSkills: [], languages: [], certifications: [], honorsAwards: [],
          experience: [], education: [],
          warnings: ['Failed to parse: ' + (err && err.message ? err.message : err)],
          parseError: true
        });
      }).then(function () {
        processed++;
        next();
      });
    }
    next();
  }

  function parseFile(file) {
    return file.arrayBuffer().then(function (buf) {
      return window.LinkedInParser.parseArrayBuffer(buf, file.name);
    });
  }

  function render() {
    applySort();

    var hasAny = candidates.length > 0;
    els.results.classList.toggle('hidden', !hasAny);
    els.emptyHelp.classList.toggle('hidden', hasAny);
    els.downloadBtn.disabled = !hasAny;
    els.resultsTable.classList.toggle('show-matches', keywords.length > 0);

    var ok = candidates.filter(function (c) { return !c.parseError && c.name; }).length;
    var countText = candidates.length + ' file' +
      (candidates.length === 1 ? '' : 's') + ' · ' + ok + ' parsed cleanly';
    if (keywords.length) countText += ' · sorted by keyword matches';
    els.resultsCount.textContent = countText;

    els.resultsBody.innerHTML = '';
    candidates.forEach(function (c, idx) {
      els.resultsBody.appendChild(buildRow(c, idx));
    });
  }

  // ---- Candidate bookkeeping & keyword search ------------------------------

  function addCandidate(c) {
    c._order = nextOrder++;
    candidates.push(c);
  }

  function parseKeywords(raw) {
    var seen = {};
    var out = [];
    (raw || '').split(',').forEach(function (k) {
      var t = k.trim();
      if (!t) return;
      var key = t.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(t);
    });
    return out;
  }

  // Flattens everything searchable about a candidate into one lowercase string.
  function buildSearchText(c) {
    var parts = [c.headline, c.summary, c.currentTitle, c.currentCompany, c.location]
      .concat(c.topSkills || [], c.languages || [], c.certifications || [], c.honorsAwards || []);
    (c.experience || []).forEach(function (e) {
      parts.push(e.title, e.company, e.location);
      parts = parts.concat(e.description || []);
    });
    (c.education || []).forEach(function (e) {
      parts.push(e.school, e.degree);
    });
    return parts.filter(Boolean).join(' \n ').toLowerCase();
  }

  function computeKeywordMatches(c, kws) {
    if (!kws.length) return { count: 0, matched: [] };
    var text = buildSearchText(c);
    var matched = kws.filter(function (k) { return text.indexOf(k.toLowerCase()) !== -1; });
    return { count: matched.length, matched: matched };
  }

  // Recomputes keyword-match counts and (when a search is active) sorts
  // candidates by match count, falling back to upload/import order.
  function applySort() {
    candidates.forEach(function (c) {
      var m = computeKeywordMatches(c, keywords);
      c._keywordMatchCount = m.count;
      c._matchedKeywords = m.matched;
    });
    candidates.sort(function (a, b) {
      if (keywords.length && b._keywordMatchCount !== a._keywordMatchCount) {
        return b._keywordMatchCount - a._keywordMatchCount;
      }
      return a._order - b._order;
    });
  }

  function buildRow(c, idx) {
    var tr = document.createElement('tr');
    if (c.warnings && c.warnings.length) tr.classList.add('row-warn');

    var role = [c.currentTitle, c.currentCompany].filter(Boolean).join(' @ ');

    tr.appendChild(cell(c.name || '(name not found)', c.name ? '' : 'muted'));
    tr.appendChild(matchesCell(c));
    tr.appendChild(cell(role));
    tr.appendChild(cell(c.location || ''));
    tr.appendChild(chipCell(c.topSkills));
    tr.appendChild(chipCell(c.languages));
    tr.appendChild(chipCell(c.certifications));
    tr.appendChild(cell(c.totalExperienceText || ''));

    var actions = document.createElement('td');
    actions.className = 'col-actions';
    var view = document.createElement('button');
    view.type = 'button';
    view.className = 'link-btn';
    view.textContent = 'Details';
    view.addEventListener('click', function () { showDetail(idx); });
    actions.appendChild(view);
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'link-btn danger';
    rm.textContent = 'Remove';
    rm.addEventListener('click', function () { candidates.splice(idx, 1); render(); });
    actions.appendChild(rm);
    tr.appendChild(actions);
    return tr;
  }

  function cell(text, cls) {
    var td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  }

  function matchesCell(c) {
    var td = document.createElement('td');
    td.className = 'col-matches';
    if (keywords.length) {
      td.textContent = (c._keywordMatchCount || 0) + ' / ' + keywords.length;
      if (c._matchedKeywords && c._matchedKeywords.length) td.title = c._matchedKeywords.join(', ');
    }
    return td;
  }

  function chipCell(list) {
    var td = document.createElement('td');
    (list || []).forEach(function (v) {
      var span = document.createElement('span');
      span.className = 'chip';
      span.textContent = v;
      td.appendChild(span);
    });
    if (!list || !list.length) { td.textContent = '—'; td.className = 'muted'; }
    return td;
  }

  function showDetail(idx) {
    var c = candidates[idx];
    var h = [];
    h.push('<h2>' + esc(c.name || '(name not found)') + '</h2>');
    if (c.headline) h.push('<p class="d-headline">' + esc(c.headline) + '</p>');
    var meta = [c.location, c.totalExperienceText ? c.totalExperienceText + ' total' : ''].filter(Boolean);
    if (meta.length) h.push('<p class="d-meta">' + esc(meta.join(' · ')) + '</p>');

    if (c.linkedinUrl) h.push('<p><a href="' + esc(c.linkedinUrl) + '" target="_blank" rel="noopener">' + esc(c.linkedinUrl) + '</a></p>');

    h.push(detailList('Top Skills', c.topSkills));
    h.push(detailList('Languages', c.languages));
    h.push(detailList('Certifications', c.certifications));
    h.push(detailList('Honors & Awards', c.honorsAwards));

    if (c.summary) h.push('<h3>Summary</h3><p class="d-summary">' + esc(c.summary) + '</p>');

    if (c.experience && c.experience.length) {
      h.push('<h3>Experience</h3>');
      c.experience.forEach(function (e) {
        h.push('<div class="d-exp">');
        h.push('<div class="d-exp-h"><strong>' + esc(e.title || '') + '</strong>' +
          (e.company ? ' · ' + esc(e.company) : '') + '</div>');
        var line = [e.period, e.location].filter(Boolean).join(' · ');
        if (line) h.push('<div class="d-exp-m">' + esc(line) + '</div>');
        if (e.description && e.description.length) {
          h.push('<ul>' + e.description.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>');
        }
        h.push('</div>');
      });
    }

    if (c.education && c.education.length) {
      h.push('<h3>Education</h3>');
      c.education.forEach(function (e) {
        h.push('<div class="d-edu"><strong>' + esc(e.school || '') + '</strong>' +
          (e.degree ? '<div>' + esc(e.degree) + '</div>' : '') +
          (e.period ? '<div class="d-exp-m">' + esc(e.period) + '</div>' : '') + '</div>');
      });
    }

    if (c.warnings && c.warnings.length) {
      h.push('<div class="d-warn"><strong>Notes:</strong><ul>' +
        c.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>');
    }

    h.push('<p class="d-src">Source: ' + esc(c.sourceFile || '') +
      (c.viewedDate ? ' · viewed ' + esc(c.viewedDate) : '') + '</p>');

    els.detailContent.innerHTML = h.join('');
    if (typeof els.detailDialog.showModal === 'function') els.detailDialog.showModal();
    else els.detailDialog.setAttribute('open', '');
  }

  function detailList(title, list) {
    if (!list || !list.length) return '';
    return '<h3>' + esc(title) + '</h3><div class="d-chips">' +
      list.map(function (v) { return '<span class="chip">' + esc(v) + '</span>'; }).join('') + '</div>';
  }

  function onDownload() {
    if (!candidates.length) return;
    try {
      window.ExcelExport.download(candidates, undefined, keywords.length > 0);
      toast('Excel file downloaded.');
    } catch (err) {
      toast('Export failed: ' + (err && err.message ? err.message : err));
    }
  }

  function onClear() {
    candidates = [];
    render();
  }

  // ---- Import a previously-exported workbook -------------------------------

  function importExcel(file) {
    if (!window.XLSX) { toast('XLSX library failed to load.'); return; }
    setBusy(true, 'Importing ' + file.name + '…');
    file.arrayBuffer().then(function (buf) {
      var wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      var candSheet = wb.Sheets['Candidates'];
      if (!candSheet) {
        throw new Error('No "Candidates" sheet found — is this a workbook exported from this tool?');
      }
      var candRows = XLSX.utils.sheet_to_json(candSheet, { defval: '' });
      var expRows = wb.Sheets['Experience'] ? XLSX.utils.sheet_to_json(wb.Sheets['Experience'], { defval: '' }) : [];
      var skillRows = wb.Sheets['Skills'] ? XLSX.utils.sheet_to_json(wb.Sheets['Skills'], { defval: '' }) : [];

      var imported = candRows
        .map(function (row) { return candidateFromRow(row, expRows, skillRows); })
        .filter(function (c) { return c.name; });

      if (!imported.length) {
        throw new Error('No candidates found in "' + file.name + '".');
      }

      imported.forEach(addCandidate);
      setBusy(false);
      render();
      toast('Imported ' + imported.length + ' candidate' + (imported.length === 1 ? '' : 's') + ' from ' + file.name + '.');
    }).catch(function (err) {
      setBusy(false);
      toast('Import failed: ' + (err && err.message ? err.message : err));
    });
  }

  // Matches an Experience/Skills sheet row back to its Candidates sheet row.
  function rowKey(name, sourceFile) {
    return (name || '') + ' ' + (sourceFile || '');
  }

  // Reverses formatDuration()/formatMonths(), e.g. "2 yrs 3 mos" -> 27.
  function parseDurationMonths(text) {
    text = (text || '').toString();
    var years = 0, months = 0;
    var ym = text.match(/(\d+)\s*yrs?/i);
    if (ym) years = parseInt(ym[1], 10);
    var mm = text.match(/(\d+)\s*mos?/i);
    if (mm) months = parseInt(mm[1], 10);
    return years * 12 + months;
  }

  function candidateFromRow(row, expRows, skillRows) {
    var name = (row['Name'] || '').toString().trim();
    var sourceFile = (row['Source File'] || '').toString();
    var key = rowKey(name, sourceFile);

    var experience = expRows
      .filter(function (r) { return rowKey(r['Candidate'], r['Source File']) === key; })
      .map(function (r) {
        return {
          company: r['Company'] || '',
          title: r['Title'] || '',
          period: r['Period'] || '',
          location: r['Location'] || '',
          description: (r['Description'] || '').toString().split('\n')
            .map(function (d) { return d.replace(/^[•]\s*/, '').trim(); })
            .filter(Boolean),
          durationMonths: parseDurationMonths(r['Duration'])
        };
      });

    var topSkills = [], languages = [], certifications = [];
    skillRows
      .filter(function (r) { return rowKey(r['Candidate'], r['Source File']) === key; })
      .forEach(function (r) {
        var value = (r['Value'] || '').toString();
        if (!value) return;
        if (r['Type'] === 'Top Skill') topSkills.push(value);
        else if (r['Type'] === 'Language') languages.push(value);
        else if (r['Type'] === 'Certification') certifications.push(value);
      });

    return {
      sourceFile: sourceFile,
      name: name,
      headline: row['Headline'] || '',
      location: row['Location'] || '',
      linkedinUrl: row['LinkedIn URL'] || '',
      email: row['Email'] || '',
      phone: row['Phone'] || '',
      currentTitle: row['Current Title'] || '',
      currentCompany: row['Current Company'] || '',
      topSkills: topSkills,
      languages: languages,
      certifications: certifications,
      honorsAwards: [],
      summary: row['Summary'] || '',
      experience: experience,
      education: row['Education'] ? [{ school: row['Education'], degree: '', period: '' }] : [],
      totalExperienceMonths: experience.reduce(function (s, e) { return s + (e.durationMonths || 0); }, 0),
      totalExperienceText: row['Experience (approx.)'] || '',
      viewedDate: row['Date Viewed'] || '',
      viewedBy: '',
      warnings: row['Parse Notes'] ? [String(row['Parse Notes'])] : [],
      imported: true
    };
  }

  function setBusy(busy, message) {
    els.dropzone.classList.toggle('busy', busy);
    if (busy) {
      els.dropzone.querySelector('.dz-title').textContent = message || 'Working…';
    } else {
      els.dropzone.querySelector('.dz-title').textContent = 'Drop LinkedIn Recruiter PDFs here';
    }
  }

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.add('hidden'); }, 3200);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
