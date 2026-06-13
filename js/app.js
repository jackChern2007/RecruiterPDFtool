/*
 * app.js
 * ------
 * UI glue: drag & drop, file reading, progress, the preview table, the
 * per-candidate detail dialog, and the Excel download button.
 */
(function () {
  'use strict';

  var candidates = []; // parsed results, in upload order

  var els = {};

  document.addEventListener('DOMContentLoaded', function () {
    els = {
      dropzone: document.getElementById('dropzone'),
      fileInput: document.getElementById('fileInput'),
      browseBtn: document.getElementById('browseBtn'),
      results: document.getElementById('results'),
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
    els.dropzone.addEventListener('click', function (e) {
      if (e.target === els.browseBtn) return;
      els.fileInput.click();
    });
    els.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
    });
    els.fileInput.addEventListener('change', function () {
      handleFiles(els.fileInput.files);
      els.fileInput.value = '';
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
        candidates.push(candidate);
      }).catch(function (err) {
        candidates.push({
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
    var hasAny = candidates.length > 0;
    els.results.classList.toggle('hidden', !hasAny);
    els.emptyHelp.classList.toggle('hidden', hasAny);
    els.downloadBtn.disabled = !hasAny;

    var ok = candidates.filter(function (c) { return !c.parseError && c.name; }).length;
    els.resultsCount.textContent = candidates.length + ' file' +
      (candidates.length === 1 ? '' : 's') + ' · ' + ok + ' parsed cleanly';

    els.resultsBody.innerHTML = '';
    candidates.forEach(function (c, idx) {
      els.resultsBody.appendChild(buildRow(c, idx));
    });
  }

  function buildRow(c, idx) {
    var tr = document.createElement('tr');
    if (c.warnings && c.warnings.length) tr.classList.add('row-warn');

    var role = [c.currentTitle, c.currentCompany].filter(Boolean).join(' @ ');

    tr.appendChild(cell(c.name || '(name not found)', c.name ? '' : 'muted'));
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
      window.ExcelExport.download(candidates);
      toast('Excel file downloaded.');
    } catch (err) {
      toast('Export failed: ' + (err && err.message ? err.message : err));
    }
  }

  function onClear() {
    candidates = [];
    render();
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
